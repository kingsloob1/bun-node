import type { Subprocess } from "bun";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "bun:test";
import { createDriver } from "../lib/index";
import { SpawnExecutor } from "../lib/runner/executors/spawn";
import { makeTmpDir } from "./helpers";
import { reachError, reportUnreachable } from "./helpers/backends";

/**
 * `runSummoned` in real processes, so the signals are real: a platform's
 * SIGTERM, Fly's SIGINT, Ctrl-C twice, Cloud Run's SIGTSTP/SIGCONT, and what a
 * process leaves behind when it exits.
 *
 * Each case runs `fixtures/processes/run-summoned.ts`, which reports as JSON
 * lines with the wall clock (`at`), shared with this process. Where a case
 * asserts a duration it says so, and its bound is generous: the point is on
 * which side of the platform's grace a close lands, which is seconds, not
 * milliseconds. **Duration-asserting cases:** the second SIGINT, the
 * deadline, the backstop and its control, the 5 s close rule and its
 * control, and "in-invocation" leaving nothing to hold the process.
 */

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "run-summoned.ts",
);

/** How far past a bound a loaded machine may run. */
const SLACK = 2_000;

/** SIGTSTP/SIGCONT are handled only when asked for. */
const PAUSE_SIGNALS = { OPTIONS: JSON.stringify({ pauseSignals: true }) };
/** How early a timer may appear to fire, read across two processes' clocks. */
const EARLY = 100;

/** One line the fixture printed. */
interface Line {
  /** What happened. */
  event: string;
  /** When, epoch ms. */
  at: number;
  /** A log line's level. */
  level?: string;
  /** A log line's message. */
  message?: string;
  /** A log line's fields. */
  fields?: Record<string, unknown>;
  /** The rest. */
  [key: string]: unknown;
}

/** A running fixture. */
interface Fixture {
  /** The process. */
  proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Every line so far. */
  lines: Line[];
  /** Resolves with the first line matching, or rejects after `timeout`. */
  waitFor: (match: (line: Line) => boolean, timeout?: number) => Promise<Line>;
  /** Resolves with the exit code and when it was seen. */
  exited: Promise<{ code: number; at: number }>;
  /** Everything on stderr, once the process has ended. */
  stderr: () => Promise<string>;
  /** Sends a signal, and returns when it was sent. */
  signal: (name: NodeJS.Signals) => number;
}

const running: Fixture[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fixture of running.splice(0)) {
    if (fixture.proc.exitCode === null && fixture.proc.signalCode === null) {
      fixture.proc.kill("SIGKILL");
    }
  }
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/** Starts the fixture with `env` and summon `args`. */
function start(env: Record<string, string>, args: string[] = []): Fixture {
  const proc = Bun.spawn([process.execPath, FIXTURE, ...args], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: Line[] = [];
  const waiters: {
    match: (line: Line) => boolean;
    resolve: (line: Line) => void;
  }[] = [];

  // Read as it comes: an attempt's child inherits this pipe, so its end can
  // come long after the fixture's own exit.
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const text = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!text.startsWith("{")) {
          continue;
        }
        const line = JSON.parse(text) as Line;
        lines.push(line);
        for (const waiter of [...waiters]) {
          if (waiter.match(line)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(line);
          }
        }
      }
    }
  })();
  const stderr = new Response(proc.stderr).text();

  const fixture: Fixture = {
    proc,
    lines,
    waitFor: async (match, timeout = 15_000) => {
      const seen = lines.find(match);
      if (seen) {
        return seen;
      }
      return await new Promise<Line>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `the fixture never printed the line awaited; it printed:\n${lines.map((line) => JSON.stringify(line)).join("\n")}`,
            ),
          );
        }, timeout);
        waiters.push({
          match,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
    exited: proc.exited.then((code) => ({ code, at: Date.now() })),
    stderr: async () => await stderr,
    signal: (name) => {
      const at = Date.now();
      proc.kill(name);
      return at;
    },
  };
  running.push(fixture);
  return fixture;
}

/** A log line with this message (or message prefix). */
function logged(message: string): (line: Line) => boolean {
  return (line) =>
    line.event === "log" && (line.message ?? "").startsWith(message);
}

const CLOSING = "Summoned worker closing";
const CLOSING_EARLY = "Summoned worker closing with force before it was ready";
const STOPPED = "Summoned worker stopped";
const BACKSTOP = "Summoned worker did not finish closing";

/** Waits for the exit, failing with the fixture's output if it never comes. */
async function exitOf(
  fixture: Fixture,
  timeout = 20_000,
): Promise<{ code: number; at: number }> {
  const result = await Promise.race([
    fixture.exited,
    Bun.sleep(timeout).then(() => undefined),
  ]);
  if (result === undefined) {
    fixture.proc.kill("SIGKILL");
    throw new Error(
      `the fixture did not exit within ${timeout} ms; it printed:\n${fixture.lines.map((line) => JSON.stringify(line)).join("\n")}\nstderr:\n${await fixture.stderr()}`,
    );
  }
  return result;
}

/** A process as `ps` sees it: alive or not, and its command line. */
function inspect(pid: number): { alive: boolean; args: string } {
  const { stdout } = Bun.spawnSync([
    "ps",
    "-o",
    "stat=,args=",
    "-p",
    String(pid),
  ]);
  const text = stdout.toString().trim();
  if (text.length === 0) {
    return { alive: false, args: "" };
  }
  const [stat = "", ...args] = text.split(/\s+/);
  return { alive: !stat.startsWith("Z"), args: args.join(" ") };
}

/** Kills `pid` if it is still one of this worktree's attempt children. */
function killIfOurs(pid: number): void {
  const seen = inspect(pid);
  if (seen.alive && seen.args.includes(SpawnExecutor.entry)) {
    process.kill(pid, "SIGKILL");
  }
}

/** A pid file in a fresh temporary directory, removed after the test. */
async function pidFile(): Promise<string> {
  const tmp = await makeTmpDir("run-summoned");
  cleanups.push(tmp.cleanup);
  return join(tmp.path, "child.json");
}

/** The attempt child's pid, once it has written it. */
async function childPid(file: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      return (JSON.parse(await Bun.file(file).text()) as { pid: number }).pid;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`no attempt child ever wrote ${file}`);
}

describe("runSummoned, in a real process", () => {
  it("exits 0 once the queue has been idle for idleFor", async () => {
    const fixture = start({
      OPTIONS: JSON.stringify({ idleFor: 300, idleCheckInterval: 50 }),
    });
    const ready = await fixture.waitFor((line) => line.event === "ready");
    const closing = await fixture.waitFor(logged(CLOSING));
    const { code } = await exitOf(fixture);

    expect(code).toBe(0);
    expect(closing.fields?.reason).toBe("idle");
    // Idle has to hold for `idleFor` first: never sooner.
    expect(closing.at - ready.at).toBeGreaterThanOrEqual(300 - EARLY);
    const stopped = fixture.lines.find(logged(STOPPED));
    expect(stopped?.fields).toMatchObject({ reason: "idle", code: 0 });
  }, 30_000);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`on ${signal}, lets the job in flight finish and exits 0 within grace`, async () => {
      const fixture = start({ JOBS: "1", JOB_MS: "1500" });
      await fixture.waitFor((line) => line.event === "active");
      const sent = fixture.signal(signal);
      const { code, at } = await exitOf(fixture);

      expect(code).toBe(0);
      const closing = fixture.lines.find(logged(CLOSING));
      expect(closing?.fields).toMatchObject({
        reason: "signal",
        signal,
        force: false,
      });
      expect(fixture.lines.some((line) => line.event === "completed")).toBe(
        true,
      );
      expect(fixture.lines.find(logged(STOPPED))?.fields).toMatchObject({
        reason: "signal",
        signal,
        completed: 1,
        code: 0,
      });
      // The default grace is 10 s; the job needed about 1.5.
      expect(at - sent).toBeLessThan(10_000);
    }, 30_000);
  }

  it("exits 130 at once on a second SIGINT, however long the drain would take", async () => {
    // A job that never ends, and 30 s of grace: the drain would wait ~28 s.
    const fixture = start({
      JOBS: "1",
      PROCESSOR: "hang",
      OPTIONS: JSON.stringify({ grace: 30_000 }),
    });
    await fixture.waitFor((line) => line.event === "active");
    fixture.signal("SIGINT");
    await fixture.waitFor(logged(CLOSING));
    const second = fixture.signal("SIGINT");
    const { code, at } = await exitOf(fixture);

    expect(code).toBe(130);
    expect(fixture.lines.some(logged("Second SIGINT"))).toBe(true);
    expect(at - second).toBeLessThan(SLACK);
  }, 30_000);

  it("a first SIGINT during a deadline close is the platform's stop, not a second Ctrl-C", async () => {
    // Closing starts at 0.5 s, and waits ~1.25 s for a job that never ends.
    const fixture = start({
      JOBS: "1",
      PROCESSOR: "hang",
      DEADLINE_IN_MS: "3000",
      OPTIONS: JSON.stringify({ shutdownBuffer: 2_500, idleFor: 60_000 }),
    });
    await fixture.waitFor(logged(CLOSING));
    fixture.signal("SIGINT");
    await fixture.waitFor(logged("Summoned worker already stopping"));
    const { code } = await exitOf(fixture);

    expect(code).toBe(0);
    expect(fixture.lines.some(logged("Second SIGINT"))).toBe(false);
    expect(fixture.lines.find(logged(STOPPED))?.fields).toMatchObject({
      reason: "deadline",
      code: 0,
    });
  }, 30_000);

  it("SIGTSTP stops claiming and SIGCONT resumes it", async () => {
    const fixture = start(PAUSE_SIGNALS);
    await fixture.waitFor((line) => line.event === "ready");

    fixture.signal("SIGTSTP");
    const paused = await fixture.waitFor((line) => line.event === "paused");
    expect(paused.paused).toBe(true);

    fixture.signal("SIGHUP");
    await fixture.waitFor((line) => line.event === "added");
    await Bun.sleep(600);
    // Paused: the job waits.
    expect(fixture.lines.some((line) => line.event === "active")).toBe(false);

    fixture.signal("SIGCONT");
    const resumed = await fixture.waitFor((line) => line.event === "resumed");
    expect(resumed.paused).toBe(false);
    await fixture.waitFor((line) => line.event === "completed");

    fixture.signal("SIGTERM");
    expect((await exitOf(fixture)).code).toBe(0);
  }, 30_000);

  it("SIGCONT leaves an operator's pause alone, taken before SIGTSTP", async () => {
    const fixture = start(PAUSE_SIGNALS);
    await fixture.waitFor((line) => line.event === "ready");

    fixture.signal("SIGUSR2");
    await fixture.waitFor((line) => line.event === "paused");
    fixture.signal("SIGTSTP");
    await fixture.waitFor(logged("SIGTSTP: already paused"));
    fixture.signal("SIGCONT");
    await fixture.waitFor(logged("SIGCONT: no pause"));

    fixture.signal("SIGHUP");
    await fixture.waitFor((line) => line.event === "added");
    await Bun.sleep(600);
    expect(fixture.lines.some((line) => line.event === "resumed")).toBe(false);
    expect(fixture.lines.some((line) => line.event === "active")).toBe(false);

    fixture.signal("SIGTERM");
    expect((await exitOf(fixture)).code).toBe(0);
  }, 30_000);

  it("SIGCONT leaves an operator's pause alone, taken after SIGTSTP", async () => {
    const fixture = start(PAUSE_SIGNALS);
    await fixture.waitFor((line) => line.event === "ready");

    fixture.signal("SIGTSTP");
    await fixture.waitFor(logged("SIGTSTP: stopped claiming"));
    fixture.signal("SIGUSR2");
    await fixture.waitFor((line) => line.event === "operator-pause");
    // The operator's pause is its own event, after SIGTSTP's.
    await fixture.waitFor(
      (line) =>
        line.event === "paused" &&
        line.at >= fixture.lines.find((l) => l.event === "operator-pause")!.at,
    );
    fixture.signal("SIGCONT");
    await fixture.waitFor(logged("SIGCONT: no pause"));

    fixture.signal("SIGHUP");
    await fixture.waitFor((line) => line.event === "added");
    await Bun.sleep(600);
    expect(fixture.lines.some((line) => line.event === "resumed")).toBe(false);
    expect(fixture.lines.some((line) => line.event === "active")).toBe(false);

    fixture.signal("SIGTERM");
    expect((await exitOf(fixture)).code).toBe(0);
  }, 30_000);

  it("by default leaves SIGTSTP alone, so Ctrl-Z still suspends the process", async () => {
    const fixture = start({});
    await fixture.waitFor((line) => line.event === "ready");
    fixture.signal("SIGTSTP");
    let stat = "";
    const until = Date.now() + 5_000;
    while (!stat.startsWith("T") && Date.now() < until) {
      await Bun.sleep(50);
      const ps = Bun.spawnSync([
        "ps",
        "-o",
        "stat=",
        "-p",
        String(fixture.proc.pid),
      ]);
      stat = ps.stdout.toString().trim();
    }
    // Stopped by the kernel, not paused by the worker.
    expect(stat.startsWith("T")).toBe(true);
    expect(fixture.lines.some((line) => line.event === "paused")).toBe(false);

    fixture.signal("SIGCONT");
    fixture.signal("SIGTERM");
    expect((await exitOf(fixture)).code).toBe(0);
  }, 30_000);

  it("stops at the deadline minus shutdownBuffer", async () => {
    // Idle would never end it: `idleFor` is a minute.
    const fixture = start({
      DEADLINE_IN_MS: "2500",
      OPTIONS: JSON.stringify({ shutdownBuffer: 1_500, idleFor: 60_000 }),
    });
    const booting = await fixture.waitFor((line) => line.event === "booting");
    const closing = await fixture.waitFor(logged(CLOSING));
    const { code, at } = await exitOf(fixture);

    expect(code).toBe(0);
    expect(closing.fields?.reason).toBe("deadline");
    // Not before deadline − shutdownBuffer (~1 s after start), and gone
    // before the deadline itself.
    expect(closing.at - booting.at).toBeGreaterThanOrEqual(1_000 - EARLY);
    expect(at - booting.at).toBeLessThan(2_500 + SLACK);
    // The budget is the deadline less the backstop margin: ~1.25 s left.
    expect(closing.fields?.budget as number).toBeLessThanOrEqual(1_250 + EARLY);
  }, 30_000);

  it('"in-invocation" resolves with no timer, lease or signal handler left', async () => {
    const fixture = start({
      REPORT_LEASES: "1",
      OPTIONS: JSON.stringify({
        mode: "in-invocation",
        idleFor: 800,
        idleCheckInterval: 50,
      }),
    });
    const running = await fixture.waitFor(
      (line) => line.event === "leases-running",
    );
    const result = await fixture.waitFor((line) => line.event === "result");
    const after = await fixture.waitFor(
      (line) => line.event === "leases-after",
    );
    const end = await fixture.waitFor((line) => line.event === "end");
    const { code, at } = await exitOf(fixture, 10_000);

    // The detector can see a lease: one was held while it ran.
    expect(running.held as number).toBeGreaterThan(0);
    expect(after.held).toBe(0);
    expect(result).toMatchObject({ reason: "idle", code: 0 });
    expect(end.listeners).toEqual({
      SIGTERM: 0,
      SIGINT: 0,
      SIGTSTP: 0,
      SIGCONT: 0,
    });
    // It resolved rather than exiting, and nothing held the process after.
    expect(code).toBe(0);
    expect(at - end.at).toBeLessThan(SLACK);
  }, 30_000);

  it("negative control: a timer left behind does hold the process", async () => {
    const fixture = start({
      LEAK_TIMER: "1",
      OPTIONS: JSON.stringify({
        mode: "in-invocation",
        idleFor: 300,
        idleCheckInterval: 50,
      }),
    });
    await fixture.waitFor((line) => line.event === "end");
    const exited = await Promise.race([
      fixture.exited.then(() => true),
      Bun.sleep(SLACK + 1_000).then(() => false),
    ]);
    expect(exited).toBe(false);
  }, 30_000);

  it("exits 1 when run() cannot connect", async () => {
    const fixture = start({ DRIVER: "unreachable" });
    const { code } = await exitOf(fixture);

    expect(code).toBe(1);
    expect(fixture.lines.some(logged("Summoned worker could not start"))).toBe(
      true,
    );
    expect(fixture.lines.find(logged(STOPPED))?.fields).toMatchObject({
      reason: "error",
      code: 1,
    });
  }, 30_000);

  it("a signal while run() is still connecting closes before any claim and exits 0", async () => {
    const fixture = start({ DRIVER: "slow-connect:1500", PRE_JOBS: "1" });
    await fixture.waitFor((line) => line.event === "booting");
    fixture.signal("SIGTERM");
    const { code } = await exitOf(fixture);

    expect(code).toBe(0);
    expect(fixture.lines.some(logged(CLOSING_EARLY))).toBe(true);
    expect(fixture.lines.some((line) => line.event === "active")).toBe(false);
    expect(fixture.lines.find(logged(STOPPED))?.fields).toMatchObject({
      reason: "signal",
      completed: 0,
      code: 0,
    });
  }, 30_000);

  it("the backstop exits when a custom target's close() hangs", async () => {
    const fixture = start({ JOBS: "1", TARGET: "custom-hang" }, [
      "--bun-jobs-summon-id=backstop",
      "--bun-jobs-summon-grace-ms=2000",
    ]);
    await fixture.waitFor((line) => line.event === "active");
    const sent = fixture.signal("SIGTERM");
    const { code, at } = await exitOf(fixture);

    expect(code).toBe(0);
    const closing = fixture.lines.find(logged(CLOSING));
    // The grace came from the summon argument: 2000 − 250.
    expect(closing?.fields?.budget as number).toBeLessThanOrEqual(1_750);
    expect(fixture.lines.some(logged(BACKSTOP))).toBe(true);
    expect(fixture.lines.some(logged(STOPPED))).toBe(false);
    // Out before the platform's SIGKILL would have landed.
    expect(at - sent).toBeGreaterThanOrEqual(1_750 - EARLY);
    expect(at - sent).toBeLessThan(2_000 + SLACK);
  }, 30_000);

  it("negative control: without the backstop the process outlives the grace", async () => {
    // `exit: false` arms no backstop: the close waits out the worker's own
    // 5 s bound on the hanging target.
    const fixture = start(
      {
        JOBS: "1",
        TARGET: "custom-hang",
        OPTIONS: JSON.stringify({ exit: false }),
      },
      ["--bun-jobs-summon-id=backstop", "--bun-jobs-summon-grace-ms=2000"],
    );
    await fixture.waitFor((line) => line.event === "active");
    const sent = fixture.signal("SIGTERM");
    const { at } = await exitOf(fixture);

    expect(fixture.lines.some(logged(BACKSTOP))).toBe(false);
    // The close rule still budgeted for the platform's kill.
    expect(
      fixture.lines.find(logged(CLOSING))?.fields?.budget as number,
    ).toBeLessThanOrEqual(1_750);
    expect(at - sent).toBeGreaterThan(2_000 + 1_000);
  }, 30_000);

  it('a parked worker exits "parked", whatever demand says', async () => {
    const fixture = start({
      OPTIONS: JSON.stringify({ idleFor: 400, idleCheckInterval: 50 }),
    });
    await fixture.waitFor((line) => line.event === "ready");
    fixture.signal("SIGUSR1");
    await fixture.waitFor((line) => line.event === "operator-stop");
    // Work arrives while it is parked: demand is 1, and it still leaves.
    fixture.signal("SIGHUP");
    const { code } = await exitOf(fixture);

    expect(code).toBe(0);
    expect(fixture.lines.find(logged(CLOSING))?.fields?.reason).toBe("parked");
    expect(fixture.lines.some((line) => line.event === "active")).toBe(false);
  }, 30_000);

  it('"until-stopped" does not exit on idle, only on a signal', async () => {
    const fixture = start({
      OPTIONS: JSON.stringify({
        mode: "until-stopped",
        idleFor: 100,
        idleCheckInterval: 50,
      }),
    });
    await fixture.waitFor((line) => line.event === "ready");
    await Bun.sleep(1_000);
    expect(fixture.proc.exitCode).toBeNull();
    expect(fixture.lines.some(logged(CLOSING))).toBe(false);

    fixture.signal("SIGTERM");
    const { code } = await exitOf(fixture);
    expect(code).toBe(0);
    expect(fixture.lines.find(logged(CLOSING))?.fields?.reason).toBe("signal");
  }, 30_000);
});

describe("the close rule, with a child-process target", () => {
  it("on a 5 s grace forces the close, finishes inside the grace and leaves no orphan", async () => {
    const file = await pidFile();
    const fixture = start(
      { JOBS: "1", TARGET: "child-process", PROCESSOR: "spin", PID_FILE: file },
      ["--bun-jobs-summon-id=five", "--bun-jobs-summon-grace-ms=5000"],
    );
    const pid = await childPid(file);
    try {
      // The right process: this worktree's spawn entry, a child of the fixture.
      expect(inspect(pid).args).toContain(SpawnExecutor.entry);
      await Bun.sleep(300);
      const sent = fixture.signal("SIGTERM");
      const { code, at } = await exitOf(fixture);

      expect(code).toBe(0);
      expect(fixture.lines.find(logged(CLOSING))?.fields).toMatchObject({
        reason: "signal",
        target: "child-process",
        budget: expect.any(Number),
        force: true,
      });
      expect(fixture.lines.some(logged(BACKSTOP))).toBe(false);
      expect(fixture.lines.some(logged(STOPPED))).toBe(true);
      expect(at - sent).toBeLessThan(5_000);

      // Give a kill sent on the way out a moment to land, then look.
      const until = Date.now() + 3_000;
      while (inspect(pid).alive && Date.now() < until) {
        await Bun.sleep(50);
      }
      expect(inspect(pid).alive).toBe(false);
    } finally {
      killIfOurs(pid);
    }
  }, 40_000);

  it("negative control: a graceful close on a 5 s grace overruns into the backstop, and orphans the child", async () => {
    const file = await pidFile();
    const fixture = start(
      {
        JOBS: "1",
        TARGET: "child-process",
        PROCESSOR: "spin",
        PID_FILE: file,
        PROBE: "draft",
      },
      ["--bun-jobs-summon-id=five", "--bun-jobs-summon-grace-ms=5000"],
    );
    const pid = await childPid(file);
    try {
      await Bun.sleep(300);
      const sent = fixture.signal("SIGTERM");
      const { code, at } = await exitOf(fixture);

      expect(code).toBe(0);
      expect(fixture.lines.find(logged(CLOSING))?.fields?.force).toBe(false);
      expect(fixture.lines.some(logged(BACKSTOP))).toBe(true);
      expect(fixture.lines.some(logged(STOPPED))).toBe(false);
      expect(at - sent).toBeGreaterThanOrEqual(4_750 - EARLY);
      await Bun.sleep(500);
      // The backstop cut the target's close short: the child survived.
      expect(inspect(pid).alive).toBe(true);
    } finally {
      killIfOurs(pid);
    }
  }, 40_000);

  it("on a 30 s grace closes gracefully, with the jobs' timeout the rule computes", async () => {
    const file = await pidFile();
    const fixture = start(
      {
        JOBS: "1",
        TARGET: "child-process",
        PROCESSOR: "nap",
        JOB_MS: "1500",
        PID_FILE: file,
      },
      ["--bun-jobs-summon-id=thirty", "--bun-jobs-summon-grace-ms=30000"],
    );
    const pid = await childPid(file);
    try {
      await Bun.sleep(300);
      fixture.signal("SIGTERM");
      const { code } = await exitOf(fixture);

      expect(code).toBe(0);
      const fields = fixture.lines.find(logged(CLOSING))?.fields ?? {};
      expect(fields).toMatchObject({
        reason: "signal",
        target: "child-process",
        targetClose: 4_500,
        tailReserve: 1_000,
        force: false,
      });
      const budget = fields.budget as number;
      // 30 000 − 250, read a millisecond or two after the signal.
      expect(budget).toBeLessThanOrEqual(29_750);
      expect(budget).toBeGreaterThan(29_750 - 500);
      expect(fields.timeout).toBe(budget - 4_500 - 1_000);
      expect(fixture.lines.find(logged(STOPPED))?.fields).toMatchObject({
        reason: "signal",
        completed: 1,
        code: 0,
      });
    } finally {
      killIfOurs(pid);
    }
  }, 40_000);
});

/**
 * The review's edge cases (#195): budgets at or below zero, stops that
 * arrive before the worker is ready, and a start that fails after a signal.
 */
describe("runSummoned at the budget's edges", () => {
  it("a deadline reached while run() is still connecting closes at once, not after the connect", async () => {
    // Connecting takes 8 s; the deadline is 3 s away, so the stop is due at
    // once, and closes the worker then.
    const fixture = start({
      DRIVER: "slow-connect:8000",
      DEADLINE_IN_MS: "3000",
    });
    const booting = await fixture.waitFor((line) => line.event === "booting");
    const { code, at } = await exitOf(fixture);

    expect(code).toBe(0);
    expect(fixture.lines.find(logged(CLOSING_EARLY))?.fields).toMatchObject({
      reason: "deadline",
      force: true,
    });
    expect(fixture.lines.find(logged(STOPPED))?.fields?.reason).toBe(
      "deadline",
    );
    expect(fixture.lines.some(logged(BACKSTOP))).toBe(false);
    expect(fixture.lines.some((line) => line.event === "ready")).toBe(false);
    // Gone at once: not held until the 8 s connect ends, nor until the deadline.
    expect(at - booting.at).toBeLessThan(SLACK);
  }, 30_000);

  it('"in-invocation" resolves at once for a deadline reached while run() is still connecting', async () => {
    const fixture = start({
      DRIVER: "slow-connect:8000",
      DEADLINE_IN_MS: "3000",
      OPTIONS: JSON.stringify({ mode: "in-invocation" }),
    });
    const booting = await fixture.waitFor((line) => line.event === "booting");
    const result = await fixture.waitFor((line) => line.event === "result");
    expect((await exitOf(fixture)).code).toBe(0);

    expect(result).toMatchObject({ reason: "deadline", code: 0 });
    expect(result.at - booting.at).toBeLessThan(SLACK);
    expect(fixture.lines.some((line) => line.event === "ready")).toBe(false);
  }, 30_000);

  it("a signal while run() is connecting exits 0, even from a start that would have failed", async () => {
    const fixture = start({ DRIVER: "slow-fail:1500" });
    await fixture.waitFor((line) => line.event === "booting");
    fixture.signal("SIGTERM");
    const { code } = await exitOf(fixture);

    expect(code).toBe(0);
    expect(fixture.lines.some(logged(CLOSING_EARLY))).toBe(true);
    expect(fixture.lines.find(logged(STOPPED))?.fields).toMatchObject({
      reason: "signal",
      signal: "SIGTERM",
      code: 0,
    });
  }, 30_000);

  it("knows the target's kind from construction, on a driver that keeps no worker records", async () => {
    // In-process on Fly's 5 s grace: graceful, with the jobs given
    // 4,750 − 0 − 1,000 ms. A kind read from a record would be unknown here,
    // and a custom target's 5 s bound would force the close.
    const fixture = start({ NO_RECORDS: "1", JOBS: "1", JOB_MS: "1500" }, [
      "--bun-jobs-summon-id=kind",
      "--bun-jobs-summon-grace-ms=5000",
    ]);
    const ready = await fixture.waitFor((line) => line.event === "ready");
    expect(ready.records).toBe(false);
    await fixture.waitFor((line) => line.event === "active");
    fixture.signal("SIGTERM");
    const { code } = await exitOf(fixture);

    expect(code).toBe(0);
    const fields = fixture.lines.find(logged(CLOSING))?.fields ?? {};
    expect(fields).toMatchObject({
      reason: "signal",
      target: "in-process",
      targetClose: 0,
      force: false,
    });
    expect(fields.timeout).toBe((fields.budget as number) - 1_000);
    expect(fixture.lines.find(logged(STOPPED))?.fields).toMatchObject({
      completed: 1,
      code: 0,
    });
  }, 30_000);

  it("waits out an owner's close that lands during startup before it exits", async () => {
    // Connecting takes 500 ms; the owner closes the worker at 100 ms. The
    // worker resolves `run()` once startup stops, before that close has
    // unregistered it and closed its driver.
    const fixture = start({
      DRIVER: "slow-connect:500",
      OWNER_CLOSE_AT_MS: "100",
    });
    const { code } = await exitOf(fixture);

    expect(code).toBe(0);
    const events = fixture.lines.map((line) => line.event);
    const stoppedAt = fixture.lines.findIndex(logged(STOPPED));
    // The owner's close finished, and its caller heard so, before the exit.
    expect(events).toContain("closed-event");
    expect(events).toContain("owner-close-resolved");
    expect(stoppedAt).toBeGreaterThan(events.indexOf("closed-event"));
    expect(stoppedAt).toBeGreaterThan(events.indexOf("owner-close-resolved"));
    expect(fixture.lines[stoppedAt]?.fields).toMatchObject({
      reason: "closed",
      code: 0,
    });
    expect(
      fixture.lines.some(logged("Summoned worker was already closed")),
    ).toBe(false);
  }, 30_000);

  it("negative control: the same failed start with no signal exits 1", async () => {
    const fixture = start({ DRIVER: "slow-fail:500" });
    const { code } = await exitOf(fixture);

    expect(code).toBe(1);
    expect(fixture.lines.find(logged(STOPPED))?.fields).toMatchObject({
      reason: "error",
      code: 1,
    });
  }, 30_000);
});

/** A backend the zero-grace case runs on, with its server when it has one. */
interface EdgeBackend {
  /** The fixture's `DRIVER`. */
  name: "memory" | "postgres" | "redis";
  /** The variable naming its server, for the server-backed ones. */
  variable?: string;
}

const EDGE_BACKENDS: EdgeBackend[] = [
  { name: "memory" },
  { name: "postgres", variable: "BUN_JOBS_TEST_POSTGRES_URL" },
  { name: "redis", variable: "BUN_JOBS_TEST_REDIS_URL" },
];

for (const backend of EDGE_BACKENDS) {
  const url = backend.variable ? process.env[backend.variable] : undefined;
  if (backend.variable && !url) {
    describe.skip(`stops at the edges on ${backend.name}: not configured`, () => {
      it(`runs when ${backend.variable} is set`, () => {});
    });
    continue;
  }
  const config =
    backend.name === "postgres"
      ? ({ type: "sql", adapter: "postgres", url: url! } as const)
      : backend.name === "redis"
        ? ({ type: "redis", url: url! } as const)
        : undefined;
  const unreachable = config ? await reachError(config) : undefined;
  if (backend.variable && unreachable) {
    reportUnreachable(backend.name, backend.variable, unreachable);
    continue;
  }

  describe(`stops at the edges on ${backend.name}`, () => {
    /** Runs a child-process spin target, SIGTERMs it with no grace, and reports. */
    async function zeroGrace(probe?: "no-floor"): Promise<{
      fixture: Fixture;
      code: number;
      pid: number;
      aliveAfter: boolean;
    }> {
      const namespace = `run-summoned-edge-${process.pid}-${Date.now()}`;
      if (config) {
        cleanups.push(async () => {
          const driver = createDriver(config);
          await driver.connect();
          await driver.purge(namespace);
          await driver.close();
        });
      }
      const file = await pidFile();
      const fixture = start(
        {
          DRIVER: backend.name,
          NAMESPACE: namespace,
          JOBS: "1",
          TARGET: "child-process",
          PROCESSOR: "spin",
          PID_FILE: file,
          ...(probe ? { PROBE: probe } : {}),
        },
        ["--bun-jobs-summon-id=zero", "--bun-jobs-summon-grace-ms=0"],
      );
      const pid = await childPid(file);
      try {
        expect(inspect(pid).args).toContain(SpawnExecutor.entry);
        await Bun.sleep(300);
        fixture.signal("SIGTERM");
        const { code } = await exitOf(fixture);
        // Give a kill sent on the way out a moment to land, then look.
        const until = Date.now() + 3_000;
        while (inspect(pid).alive && Date.now() < until) {
          await Bun.sleep(50);
        }
        return { fixture, code, pid, aliveAfter: inspect(pid).alive };
      } finally {
        killIfOurs(pid);
      }
    }

    it("closes at once for a stop before ready, without waiting for the connect", async () => {
      const namespace = `run-summoned-early-${process.pid}-${Date.now()}`;
      if (config) {
        cleanups.push(async () => {
          const driver = createDriver(config);
          await driver.connect();
          await driver.purge(namespace);
          await driver.close();
        });
      }
      // Connecting takes 3 s longer than it would.
      const fixture = start({
        DRIVER: backend.name,
        NAMESPACE: namespace,
        SLOW_CONNECT_MS: "3000",
      });
      await fixture.waitFor((line) => line.event === "booting");
      const sent = fixture.signal("SIGTERM");
      const { code, at } = await exitOf(fixture);

      expect(code).toBe(0);
      expect(fixture.lines.find(logged(CLOSING_EARLY))?.fields).toMatchObject({
        reason: "signal",
        force: true,
      });
      expect(fixture.lines.find(logged(STOPPED))?.fields?.reason).toBe(
        "signal",
      );
      expect(fixture.lines.some((line) => line.event === "ready")).toBe(false);
      // Out before the slow connect would even have finished.
      expect(at - sent).toBeLessThan(3_000);
    }, 30_000);

    it("forces the close, which kills the child before the backstop can fire", async () => {
      const { fixture, code, aliveAfter } = await zeroGrace();

      expect(code).toBe(0);
      expect(fixture.lines.find(logged(CLOSING))?.fields).toMatchObject({
        reason: "signal",
        force: true,
      });
      expect(fixture.lines.some(logged(STOPPED))).toBe(true);
      expect(fixture.lines.some(logged(BACKSTOP))).toBe(false);
      expect(aliveAfter).toBe(false);
    }, 40_000);

    // Memory's forced close takes no I/O before the kill, so a timer armed for
    // "now" cannot beat it there; the round trip is what the servers add.
    if (backend.name !== "memory") {
      it("negative control: with no floor the backstop fires first, and orphans the child", async () => {
        const { fixture, code, aliveAfter } = await zeroGrace("no-floor");

        expect(code).toBe(0);
        expect(fixture.lines.some(logged(BACKSTOP))).toBe(true);
        expect(fixture.lines.some(logged(STOPPED))).toBe(false);
        expect(aliveAfter).toBe(true);
      }, 40_000);
    }
  });
}
