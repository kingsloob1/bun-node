import type { Subprocess } from "bun";
import type { DriverConfig, SummonedExit } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import {
  BunQueueWorker,
  ConfigError,
  createDriver,
  MemoryDriver,
  runSummoned,
  SUMMON_ARGS,
} from "../lib/index";
import { SpawnExecutor } from "../lib/runner/executors/spawn";
import { readSummonClaims } from "../lib/summon/claim";
import { makeTmpDir, testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * `runSummoned(workers[])` (summon-multi-queue §4.7, PR-B2, test 6): one
 * summoned unit running a worker per queue — one idle clock over every
 * queue, one close budget, an exit mark on every worker's claim, per-queue
 * totals — driven by hand-built `--bun-jobs-summon-*=` arguments, so no
 * shared-unit controller is needed.
 */

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "run-summoned-several.ts",
);

// Each case runs a real process to its exit.
setDefaultTimeout(60_000);

/** How far past a bound a loaded machine may run. */
const SLACK = 3_000;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});
const BACKENDS = await crossProcessBackends({ cleanups });

/** One line the fixture printed. */
interface Line {
  /** What happened. */
  event: string;
  /** When, epoch ms. */
  at: number;
  /** A log line's message. */
  message?: string;
  /** A log line's level. */
  level?: string;
  /** A log line's fields. */
  fields?: Record<string, unknown>;
  /** The queue, for a worker's line. */
  queue?: string;
  /** A `waiting` line's count of the queue's waiting jobs. */
  count?: number;
}

/** A running fixture. */
interface Fixture {
  /** The process. */
  proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Every line so far. */
  lines: Line[];
  /** Resolves with the first line matching. */
  waitFor: (match: (line: Line) => boolean, timeout?: number) => Promise<Line>;
  /** Resolves with the exit code and when it was seen. */
  exited: Promise<{ code: number; at: number }>;
  /** Everything on stderr. */
  stderr: Promise<string>;
}

const running: Fixture[] = [];
/** Attempt children's pids a test saw, killed after it if still ours. */
const children: number[] = [];
afterEach(() => {
  for (const fixture of running.splice(0)) {
    if (fixture.proc.exitCode === null && fixture.proc.signalCode === null) {
      fixture.proc.kill("SIGKILL");
    }
  }
  // A test that failed or timed out may leave an orphan behind: by pid only,
  // and only this worktree's spawn entry.
  for (const pid of children.splice(0)) {
    killIfOurs(pid);
  }
});

/** Starts the fixture with `env` and summon `args`. */
function start(env: Record<string, string>, args: string[]): Fixture {
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
    stderr: new Response(proc.stderr).text(),
  };
  running.push(fixture);
  return fixture;
}

/** Waits for the exit, failing with the fixture's output if it never comes. */
async function exitOf(
  fixture: Fixture,
  timeout = 25_000,
): Promise<{ code: number; at: number }> {
  const result = await Promise.race([
    fixture.exited,
    Bun.sleep(timeout).then(() => undefined),
  ]);
  if (result === undefined) {
    fixture.proc.kill("SIGKILL");
    throw new Error(
      `the fixture did not exit within ${timeout} ms; it printed:\n${fixture.lines.map((line) => JSON.stringify(line)).join("\n")}\nstderr:\n${await fixture.stderr}`,
    );
  }
  return result;
}

/** The result, from the "stopped" log line, which carries it. */
function stopped(fixture: Fixture): SummonedExit & { mode: string } {
  const line = fixture.lines.find(
    (one) => one.event === "log" && one.message === "Summoned worker stopped",
  );
  if (line === undefined) {
    throw new Error(
      `no "stopped" line; it printed:\n${fixture.lines.map((one) => JSON.stringify(one)).join("\n")}`,
    );
  }
  return line.fields as unknown as SummonedExit & { mode: string };
}

/** The summon arguments for attempt `id` on `queues` in `namespace`. */
function argsFor(id: string, namespace: string, queues: string[]): string[] {
  return [
    `${SUMMON_ARGS.id}=${id}`,
    `${SUMMON_ARGS.kind}=test`,
    `${SUMMON_ARGS.namespace}=${namespace}`,
    `${SUMMON_ARGS.group}=media`,
    ...queues.map((queue) => `${SUMMON_ARGS.queue}=${queue}`),
  ];
}

/** Quick idle checks, so a test waits on seconds, not the defaults. */
const QUICK = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ idleFor: 300, idleCheckInterval: 50, ...extra });

/** A SQLite file both this process and the fixture open. */
async function sqlite(): Promise<DriverConfig> {
  const dir = await makeTmpDir("run-summoned-several");
  cleanups.push(dir.cleanup);
  return { type: "sql", url: `sqlite://${join(dir.path, "jobs.db")}` };
}

/* --- refusals, in this process --------------------------------------------- */

describe("runSummoned(workers[]): refusals before anything runs", () => {
  /** A worker on `queue` with `summon`, not yet running. */
  const worker = (
    queue: string,
    summon?: { id: string },
    driver = new MemoryDriver(),
  ) =>
    new BunQueueWorker(queue, async () => null, {
      namespace: testNamespace("several"),
      driver,
      logger: noopLogger,
      ...(summon === undefined ? {} : { summon }),
    });

  /**
   * Options under which a refusal that regressed fails the test rather than
   * the runner: without `exit: false`, a unit that ran would end in
   * `process.exit(0)` — which ends `bun test` early, with code 0.
   */
  const SAFE = {
    exit: false,
    signals: false,
    idleFor: 100,
    idleCheckInterval: 20,
  } as const;

  it("refuses an empty set", async () => {
    await expect(runSummoned([], SAFE)).rejects.toBeInstanceOf(ConfigError);
  });

  it("refuses two workers on one queue, starting neither", async () => {
    const driver = new MemoryDriver();
    const one = worker("renders", undefined, driver);
    const two = worker("renders", undefined, driver);
    await expect(runSummoned([one, two], SAFE)).rejects.toThrow(/renders/);
    expect(one.isRunning).toBe(false);
    expect(two.isRunning).toBe(false);
  });

  it("refuses workers summoned by different attempts, starting neither", async () => {
    const one = worker("renders", { id: "sm_a" });
    const two = worker("thumbs", { id: "sm_b" });
    await expect(runSummoned([one, two], SAFE)).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(one.isRunning || two.isRunning).toBe(false);
  });

  it("refuses a worker that is already running, starting none of the others", async () => {
    const one = worker("renders");
    const two = worker("thumbs");
    void two.run();
    try {
      await expect(runSummoned([one, two], SAFE)).rejects.toBeInstanceOf(
        ConfigError,
      );
      expect(one.isRunning).toBe(false);
    } finally {
      await two.close({ force: true });
    }
  });
});

/* --- a real unit ------------------------------------------------------------ */

describe("runSummoned(workers[]), in a real process", () => {
  it("refuses a queue the arguments name with no worker: exit 1, before any claim", async () => {
    const driver = await sqlite();
    const namespace = testNamespace("several-missing");
    const fixture = start(
      { DRIVER: JSON.stringify(driver), WORKERS: "renders" },
      argsFor("sm_missing", namespace, ["renders", "thumbs"]),
    );
    const { code } = await exitOf(fixture);
    expect(code).toBe(1);
    expect(await fixture.stderr).toContain("thumbs");
    expect(fixture.lines.some((line) => line.event === "ready")).toBe(false);
    const store = createDriver(driver);
    await store.connect();
    try {
      for (const queue of ["renders", "thumbs"]) {
        const claims = await readSummonClaims(store, { ns: namespace, queue }, [
          "sm_missing",
        ]);
        expect(claims.get("sm_missing"), queue).toBeUndefined();
      }
    } finally {
      await store.close();
    }
  });

  it("refuses it through runSummoned(worker) too: one worker for arguments naming two queues", async () => {
    const fixture = start(
      { SINGLE: "1", WORKERS: "renders" },
      argsFor("sm_single", testNamespace("several-single"), [
        "renders",
        "thumbs",
      ]),
    );
    expect((await exitOf(fixture)).code).toBe(1);
    expect(await fixture.stderr).toContain("thumbs");
  });

  it("stops only once every queue is idle, with per-queue totals", async () => {
    const fixture = start(
      {
        PRE_JOBS: JSON.stringify({ renders: 2 }),
        SLOW_QUEUE: "renders",
        SLOW_MS: "1500",
        OPTIONS: QUICK(),
      },
      argsFor("sm_idle", testNamespace("several-idle"), ["renders", "thumbs"]),
    );
    const { code, at } = await exitOf(fixture);
    expect(code, await fixture.stderr).toBe(0);
    const processed = fixture.lines.filter(
      (line) => line.event === "processed",
    );
    expect(processed.map((line) => line.queue)).toEqual(["renders", "renders"]);
    // thumbs was idle from the start, well past idleFor: the unit waited
    // for renders anyway.
    expect(at).toBeGreaterThanOrEqual(processed.at(-1)!.at);
    const result = stopped(fixture);
    expect(result).toMatchObject({
      reason: "idle",
      code: 0,
      completed: 2,
      failed: 0,
      queues: {
        renders: { completed: 2, failed: 0 },
        thumbs: { completed: 0, failed: 0 },
      },
    });
    expect(
      fixture.lines
        .filter((line) => line.event === "closed")
        .map((line) => line.queue)
        .sort(),
    ).toEqual(["renders", "thumbs"]);
  });

  it("a signal closes every worker under one budget, letting jobs in flight finish", async () => {
    const fixture = start(
      {
        PRE_JOBS: JSON.stringify({ renders: 1, thumbs: 1 }),
        JOB_MS: "800",
        OPTIONS: QUICK({ idleFor: 60_000, grace: 8_000 }),
      },
      argsFor("sm_signal", testNamespace("several-signal"), [
        "renders",
        "thumbs",
      ]),
    );
    await fixture.waitFor(
      (line) => line.event === "processing" && line.queue === "renders",
    );
    await fixture.waitFor(
      (line) => line.event === "processing" && line.queue === "thumbs",
    );
    const sent = Date.now();
    fixture.proc.kill("SIGTERM");
    const { code, at } = await exitOf(fixture);
    expect(code).toBe(0);
    expect(at - sent).toBeLessThan(8_000 + SLACK);
    const closing = fixture.lines.filter(
      (line) =>
        line.event === "log" &&
        (line.message ?? "").startsWith("Summoned worker closing"),
    );
    // One decision for the unit, not one per worker.
    expect(closing).toHaveLength(1);
    expect(closing[0]!.message).toBe("Summoned worker closing gracefully");
    expect(stopped(fixture)).toMatchObject({
      reason: "signal",
      signal: "SIGTERM",
      queues: {
        renders: { completed: 1, failed: 0 },
        thumbs: { completed: 1, failed: 0 },
      },
    });
  });

  it("one worker's run() failing closes them all, with code 1", async () => {
    const fixture = start(
      { FAIL_QUEUE: "thumbs", OPTIONS: QUICK({ idleFor: 60_000 }) },
      argsFor("sm_fail", testNamespace("several-fail"), ["renders", "thumbs"]),
    );
    const { code } = await exitOf(fixture);
    expect(code).toBe(1);
    expect(stopped(fixture)).toMatchObject({ reason: "error", code: 1 });
    expect(
      fixture.lines.some(
        (line) => line.event === "closed" && line.queue === "renders",
      ),
    ).toBe(true);
  });

  it("a failed start lets a ready worker finish its job in flight, and still exits 1 with reason error", async () => {
    const fixture = start(
      {
        FAIL_QUEUE: "thumbs",
        // Late enough that renders is ready and working when thumbs fails.
        FAIL_AFTER_MS: "1000",
        PRE_JOBS: JSON.stringify({ renders: 1 }),
        JOB_MS: "2000",
        OPTIONS: QUICK({ idleFor: 60_000 }),
      },
      argsFor("sm_fail_ready", testNamespace("several-fail-ready"), [
        "renders",
        "thumbs",
      ]),
    );
    const { code } = await exitOf(fixture);
    expect(code).toBe(1);
    const failed = fixture.lines.find(
      (line) =>
        line.event === "log" &&
        line.message === "Summoned worker could not start",
    );
    expect(failed?.fields).toMatchObject({ queue: "thumbs" });
    // renders had its job in hand when thumbs failed.
    const processing = fixture.lines.find(
      (line) => line.event === "processing" && line.queue === "renders",
    );
    expect(processing!.at).toBeLessThan(failed!.at);
    // Its job finished rather than being abandoned to the stall sweep...
    expect(stopped(fixture)).toMatchObject({
      reason: "error",
      code: 1,
      completed: 1,
      failed: 0,
      queues: {
        renders: { completed: 1, failed: 0 },
        thumbs: { completed: 0, failed: 0 },
      },
    });
    // ...because only the failed worker was forced, and the ready one closed
    // by the rule: graceful, with no budget to cut it short.
    expect(closingOf(fixture)).toMatchObject({
      message: "Summoned worker closing gracefully after a failed start",
      fields: { reason: "error", force: false, startFailed: ["thumbs"] },
    });
  });

  it("an owner closing one worker leaves the others running; the unit ends once every worker has closed", async () => {
    const fixture = start(
      {
        OWNER_CLOSE: "renders:400,thumbs:1600",
        OPTIONS: QUICK({ idleFor: 60_000 }),
      },
      argsFor("sm_owner", testNamespace("several-owner"), [
        "renders",
        "thumbs",
      ]),
    );
    const first = await fixture.waitFor(
      (line) =>
        line.event === "owner-close-resolved" && line.queue === "renders",
    );
    const { code, at } = await exitOf(fixture);
    expect(code).toBe(0);
    const second = fixture.lines.find(
      (line) => line.event === "owner-close" && line.queue === "thumbs",
    )!;
    // Still running after the first close: it ended only after the second.
    expect(at).toBeGreaterThanOrEqual(second.at);
    expect(second.at).toBeGreaterThan(first.at);
    expect(stopped(fixture)).toMatchObject({ reason: "closed", code: 0 });
  });

  it("runs on while one queue has work its paused worker is not taking, however idle the others", async () => {
    const fixture = start(
      { HOLD_QUEUE: "renders", OPTIONS: QUICK() },
      argsFor("sm_held", testNamespace("several-held"), ["renders", "thumbs"]),
    );
    await fixture.waitFor((line) => line.event === "held");
    // thumbs has been idle for several times idleFor (300 ms) by now.
    await Bun.sleep(1_500);
    expect(fixture.proc.exitCode).toBeNull();
    fixture.proc.kill("SIGTERM");
    expect((await exitOf(fixture)).code).toBe(0);
    expect(stopped(fixture)).toMatchObject({
      reason: "signal",
      queues: {
        renders: { completed: 0, failed: 0 },
        thumbs: { completed: 0, failed: 0 },
      },
    });
  });

  it("after an owner closes one worker, the unit still stops on idle for the rest", async () => {
    const fixture = start(
      { OWNER_CLOSE: "renders:300", OPTIONS: QUICK({ idleFor: 1_000 }) },
      argsFor("sm_owner_idle", testNamespace("several-owner-idle"), [
        "renders",
        "thumbs",
      ]),
    );
    const closed = await fixture.waitFor(
      (line) =>
        line.event === "owner-close-resolved" && line.queue === "renders",
    );
    const { code, at } = await exitOf(fixture);
    expect(code).toBe(0);
    expect(at).toBeGreaterThanOrEqual(closed.at);
    expect(stopped(fixture)).toMatchObject({ reason: "idle", code: 0 });
    // The unit closed thumbs itself; nobody else did.
    expect(
      fixture.lines.some(
        (line) => line.event === "closed" && line.queue === "thumbs",
      ),
    ).toBe(true);
  });

  it("runs on while only some workers are parked, and stops parked once all are", async () => {
    const some = start(
      {
        PARK_QUEUE: "renders",
        PRE_JOBS: JSON.stringify({ thumbs: 1 }),
        SLOW_QUEUE: "thumbs",
        SLOW_MS: "2000",
        OPTIONS: QUICK({ idleFor: 400 }),
      },
      argsFor("sm_park1", testNamespace("several-park"), ["renders", "thumbs"]),
    );
    await some.waitFor(
      (line) => line.event === "processing" && line.queue === "thumbs",
    );
    some.proc.kill("SIGUSR1");
    const { code, at } = await exitOf(some);
    expect(code).toBe(0);
    const done = some.lines.find((line) => line.event === "processed")!;
    expect(at).toBeGreaterThanOrEqual(done.at);
    expect(stopped(some).reason).toBe("idle");

    const all = start(
      {
        PARK_QUEUE: "*",
        PRE_JOBS: JSON.stringify({ thumbs: 1 }),
        SLOW_QUEUE: "thumbs",
        SLOW_MS: "200",
        OPTIONS: QUICK({ idleFor: 400 }),
      },
      argsFor("sm_park2", testNamespace("several-park"), ["renders", "thumbs"]),
    );
    await all.waitFor(
      (line) => line.event === "ready" && line.queue === "renders",
    );
    await all.waitFor(
      (line) => line.event === "ready" && line.queue === "thumbs",
    );
    all.proc.kill("SIGUSR1");
    expect((await exitOf(all)).code).toBe(0);
    expect(stopped(all).reason).toBe("parked");
  });

  it("exits idle once the other queues are idle, however much work waits for a parked worker", async () => {
    const idleFor = 1_000;
    const fixture = start(
      {
        PARK_QUEUE: "renders",
        PARK_ADD: "1",
        REPORT_WAITING: "1",
        OPTIONS: QUICK({ idleFor, exit: false }),
      },
      argsFor("sm_park_backlog", testNamespace("several-park-backlog"), [
        "renders",
        "thumbs",
      ]),
    );
    await fixture.waitFor(
      (line) => line.event === "ready" && line.queue === "renders",
    );
    await fixture.waitFor(
      (line) => line.event === "ready" && line.queue === "thumbs",
    );
    fixture.proc.kill("SIGUSR1");
    // renders is parked, with a job waiting that nothing in the unit takes.
    const backlog = await fixture.waitFor(
      (line) => line.event === "park-backlog" && line.queue === "renders",
    );
    const { code, at } = await exitOf(fixture, idleFor + 50 + SLACK);
    expect(code).toBe(0);
    // Decided with the backlog there, not before it arrived.
    expect(closingOf(fixture)!.at).toBeGreaterThan(backlog.at);
    expect(at - backlog.at).toBeLessThan(idleFor + 50 + SLACK);
    // Idle, not parked: thumbs was never parked.
    expect(stopped(fixture)).toMatchObject({
      reason: "idle",
      code: 0,
      queues: {
        renders: { completed: 0, failed: 0 },
        thumbs: { completed: 0, failed: 0 },
      },
    });
    // The job is left for whatever runs renders next.
    expect(
      fixture.lines.find(
        (line) => line.event === "waiting" && line.queue === "renders",
      ),
    ).toMatchObject({ count: 1 });
  });

  it("warns about a worker on a queue the arguments do not name, and runs it", async () => {
    const fixture = start(
      { WORKERS: "renders,extra", OPTIONS: QUICK() },
      argsFor("sm_extra", testNamespace("several-extra"), ["renders"]),
    );
    expect((await exitOf(fixture)).code).toBe(0);
    const warned = fixture.lines.find(
      (line) => line.event === "log" && line.level === "warn",
    );
    expect(warned?.message).toContain("not named");
    expect(warned?.fields).toMatchObject({ queues: ["extra"] });
    expect(stopped(fixture).queues).toEqual({
      renders: { completed: 0, failed: 0 },
      extra: { completed: 0, failed: 0 },
    });
  });

  it("runSummoned(worker) answers as it always has: no queues on its result", async () => {
    const fixture = start(
      {
        SINGLE: "1",
        PRE_JOBS: JSON.stringify({ renders: 1 }),
        OPTIONS: QUICK(),
      },
      argsFor("sm_one", testNamespace("several-one"), ["renders"]),
    );
    expect((await exitOf(fixture)).code).toBe(0);
    const result = stopped(fixture);
    expect(result).toMatchObject({ reason: "idle", completed: 1 });
    expect("queues" in result).toBe(false);
  });
});

/* --- the runner's pitfalls, across a unit's workers ------------------------ */

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

/** A pid file path in a fresh temporary directory, removed after the run. */
async function pidFile(): Promise<string> {
  const tmp = await makeTmpDir("run-summoned-several-pid");
  cleanups.push(tmp.cleanup);
  return join(tmp.path, "child.json");
}

/** The attempt child's pid, once it has written it. */
async function childPid(file: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const { pid } = JSON.parse(await Bun.file(file).text()) as {
        pid: number;
      };
      children.push(pid);
      return pid;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`no attempt child ever wrote ${file}`);
}

/** Waits up to `ms` for `pid` to be gone, then answers whether it is alive. */
async function aliveAfter(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (inspect(pid).alive && Date.now() < until) {
    await Bun.sleep(25);
  }
  return inspect(pid).alive;
}

/** The one "closing" decision the unit logged. */
function closingOf(fixture: Fixture): Line | undefined {
  return fixture.lines.find(
    (line) =>
      line.event === "log" &&
      (line.message ?? "").startsWith("Summoned worker closing"),
  );
}

/** Whether the hard backstop fired. */
function backstopped(fixture: Fixture): boolean {
  return fixture.lines.some(
    (line) =>
      line.event === "log" &&
      (line.message ?? "").startsWith("Summoned worker did not finish closing"),
  );
}

describe("runSummoned(workers[]): the runner's pitfalls across workers", () => {
  // thumbs (in-process) first: the budget must still be sized for renders'
  // child-process target, whose close takes longest.
  const QUEUES = ["thumbs", "renders"];

  it("sizes the one close for the longest target, and leaves no child running after the exit", async () => {
    const file = await pidFile();
    const fixture = start(
      {
        CHILD_QUEUE: "renders",
        PID_FILE: file,
        PRE_JOBS: JSON.stringify({ renders: 1 }),
        OPTIONS: QUICK({ idleFor: 60_000 }),
      },
      [
        ...argsFor("sm_child", testNamespace("several-child"), QUEUES),
        `${SUMMON_ARGS.graceMs}=5000`,
      ],
    );
    const pid = await childPid(file);
    try {
      // The right process: this worktree's spawn entry.
      expect(inspect(pid).args).toContain(SpawnExecutor.entry);
      await Bun.sleep(300);
      const sent = Date.now();
      fixture.proc.kill("SIGTERM");
      const { code, at } = await exitOf(fixture);

      // Not `await fixture.stderr`: an orphaned child holds that pipe open.
      expect(code).toBe(0);
      // A 5 s grace cannot cover a child-process target's graceful close
      // (4.5 s) plus the tail: forced, for both workers, in one decision.
      expect(closingOf(fixture)?.fields).toMatchObject({
        reason: "signal",
        target: "child-process",
        force: true,
        queues: QUEUES,
      });
      expect(backstopped(fixture)).toBe(false);
      expect(at - sent).toBeLessThan(5_000);
      expect(
        fixture.lines
          .filter((line) => line.event === "closed")
          .map((line) => line.queue)
          .sort(),
      ).toEqual(["renders", "thumbs"]);
      // Nothing left running once the process has gone.
      expect(await aliveAfter(pid, 3_000)).toBe(false);
    } finally {
      killIfOurs(pid);
    }
  });

  it("a signal during a graceful close escalates every worker's close, and kills the child", async () => {
    const file = await pidFile();
    // A graceful deadline close 3 s in, then SIGTERM on a 3 s grace.
    const fixture = start(
      {
        CHILD_QUEUE: "renders",
        PID_FILE: file,
        PRE_JOBS: JSON.stringify({ renders: 1 }),
        DEADLINE_IN_MS: "10000",
        OPTIONS: QUICK({ idleFor: 60_000 }),
      },
      [
        ...argsFor("sm_escalate", testNamespace("several-escalate"), QUEUES),
        `${SUMMON_ARGS.graceMs}=3000`,
      ],
    );
    const pid = await childPid(file);
    try {
      const closing = await fixture.waitFor(
        (line) =>
          line.event === "log" &&
          (line.message ?? "").startsWith("Summoned worker closing"),
      );
      expect(closing.fields).toMatchObject({
        reason: "deadline",
        target: "child-process",
        force: false,
      });
      await Bun.sleep(Math.max(0, closing.at + 300 - Date.now()));
      expect(inspect(pid).alive).toBe(true);
      const sent = Date.now();
      fixture.proc.kill("SIGTERM");
      const { code, at } = await exitOf(fixture);

      // Not `await fixture.stderr`: an orphaned child holds that pipe open.
      expect(code).toBe(0);
      expect(backstopped(fixture)).toBe(false);
      expect(stopped(fixture)).toMatchObject({ reason: "deadline", code: 0 });
      // The kill and its reaping, well before the 2,750 ms backstop.
      expect(at - sent).toBeLessThan(1_500 + SLACK / 3);
      expect(await aliveAfter(pid, 1_000)).toBe(false);
    } finally {
      killIfOurs(pid);
    }
  });

  it("a stop while one worker is still connecting forces that one at once, and lets a ready one finish its job", async () => {
    const file = await pidFile();
    const fixture = start(
      {
        CHILD_QUEUE: "renders",
        PID_FILE: file,
        SLOW_CONNECT_QUEUE: "renders",
        SLOW_CONNECT_MS: "8000",
        PRE_JOBS: JSON.stringify({ renders: 1, thumbs: 1 }),
        JOB_MS: "1500",
        OPTIONS: QUICK({ idleFor: 60_000 }),
      },
      argsFor("sm_early", testNamespace("several-early"), QUEUES),
    );
    // thumbs is up and working; renders is still connecting.
    await fixture.waitFor(
      (line) => line.event === "processing" && line.queue === "thumbs",
    );
    const sent = Date.now();
    fixture.proc.kill("SIGTERM");
    const { code, at } = await exitOf(fixture);

    expect(code, await fixture.stderr).toBe(0);
    // One decision: graceful (a 10 s grace covers it), with renders forced.
    expect(closingOf(fixture)).toMatchObject({
      message: "Summoned worker closing gracefully",
      fields: { reason: "signal", force: false, starting: ["renders"] },
    });
    // thumbs' job, claimed before the stop, finished rather than being
    // abandoned to the stall sweep.
    expect(stopped(fixture)).toMatchObject({
      reason: "signal",
      code: 0,
      queues: {
        thumbs: { completed: 1, failed: 0 },
        renders: { completed: 0, failed: 0 },
      },
    });
    // Without waiting out renders' 8 s connect.
    expect(at - sent).toBeLessThan(5_000);
    expect(
      fixture.lines.some(
        (line) => line.event === "ready" && line.queue === "renders",
      ),
    ).toBe(false);
    // renders' processor file never ran: no attempt child was started.
    expect(await Bun.file(file).exists()).toBe(false);
  });

  it("a stop while one worker is still connecting forces it before the exit marks are waited for: it never becomes ready or claims", async () => {
    const fixture = start(
      {
        // thumbs is ready, and writing its exit mark takes 900 ms...
        SLOW_STATE_QUEUE: "thumbs",
        SLOW_STATE_MS: "900",
        // ...while renders' connect completes 400 ms in, with a job waiting.
        SLOW_CONNECT_QUEUE: "renders",
        SLOW_CONNECT_MS: "400",
        PRE_JOBS: JSON.stringify({ renders: 1 }),
        REPORT_WAITING: "1",
        OPTIONS: QUICK({ idleFor: 60_000, grace: 10_000, exit: false }),
      },
      argsFor("sm_early_mark", testNamespace("several-early-mark"), QUEUES),
    );
    await fixture.waitFor(
      (line) => line.event === "ready" && line.queue === "thumbs",
    );
    const sent = Date.now();
    fixture.proc.kill("SIGTERM");
    const { code } = await exitOf(fixture);

    expect(code, await fixture.stderr).toBe(0);
    expect(closingOf(fixture)).toMatchObject({
      message: "Summoned worker closing gracefully",
      fields: { reason: "signal", force: false, starting: ["renders"] },
    });
    // The window was there: thumbs' close waited out the slow mark, well
    // past renders' connect.
    const thumbsClosed = fixture.lines.find(
      (line) => line.event === "closed" && line.queue === "thumbs",
    );
    expect(thumbsClosed!.at - sent).toBeGreaterThanOrEqual(700);
    // renders never became ready, and its handler never ran.
    expect(
      fixture.lines.some(
        (line) =>
          (line.event === "ready" || line.event === "processing") &&
          line.queue === "renders",
      ),
    ).toBe(false);
    expect(stopped(fixture)).toMatchObject({
      reason: "signal",
      code: 0,
      queues: {
        renders: { completed: 0, failed: 0 },
        thumbs: { completed: 0, failed: 0 },
      },
    });
    // Its job is still waiting, for the next unit.
    expect(
      fixture.lines.find(
        (line) => line.event === "waiting" && line.queue === "renders",
      ),
    ).toMatchObject({ count: 1 });
  });

  it("a stop before any worker is ready forces them all at once", async () => {
    const fixture = start(
      {
        SLOW_CONNECT_QUEUE: "renders,thumbs",
        SLOW_CONNECT_MS: "8000",
        OPTIONS: QUICK({ idleFor: 60_000 }),
      },
      argsFor("sm_none", testNamespace("several-none"), QUEUES),
    );
    await fixture.waitFor((line) => line.event === "starting");
    // Past the handlers' install, and far inside the 8 s connects.
    await Bun.sleep(300);
    const sent = Date.now();
    fixture.proc.kill("SIGTERM");
    const { code, at } = await exitOf(fixture);

    expect(code, await fixture.stderr).toBe(0);
    expect(closingOf(fixture)?.message).toBe(
      "Summoned worker closing with force before it was ready: nothing claimed yet",
    );
    expect(at - sent).toBeLessThan(3_000);
  });
});

/* --- exit marks, across processes ------------------------------------------ */

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `runSummoned(workers[]) exit marks on ${backend.name}`,
    () => {
      it("marks the unit's reason on every worker's claim, each under its own queue", async () => {
        const namespace = testNamespace(`several-marks-${backend.name}`);
        const id = `sm_marks${backend.name}`;
        const store = createDriver(backend.config);
        await store.connect();
        try {
          const fixture = start(
            {
              DRIVER: JSON.stringify(backend.config),
              PRE_JOBS: JSON.stringify({ renders: 1, thumbs: 1 }),
              OPTIONS: QUICK(),
            },
            argsFor(id, namespace, ["renders", "thumbs"]),
          );
          const { code } = await exitOf(fixture, 40_000);
          expect(code, await fixture.stderr).toBe(0);
          for (const queue of ["renders", "thumbs"]) {
            const claim = (
              await readSummonClaims(store, { ns: namespace, queue }, [id])
            ).get(id);
            expect(claim?.holders, queue).toHaveLength(1);
            expect(claim!.holders[0]!.exit, queue).toMatchObject({
              reason: "idle",
              code: 0,
            });
          }
        } finally {
          await store.purge(namespace).catch(() => {});
          await store.close();
        }
      }, 60_000);
    },
  );
}
