// The machine's shared heavy-run wrapper (`scripts/heavy-run.sh`), its queue
// listing (`scripts/heavy-queue.sh`) and their installer, exercised for real:
// each case spawns bash on the scripts in a temporary HEAVY_DIR of its own, so
// nothing here touches the live locks in /tmp/claude-1000.
//
// Timing. The machine is shared and often loaded, so every bound is generous
// and most assertions are about order and overlap, read from the jobs' own
// log, rather than about wall time. The head of the line polls the slots every
// 2 s (the wrapper's `nap`), so a job that waits behind a busy slot starts up
// to 2 s after it frees: three 1 s jobs on two slots take about 3 s, not 2 s,
// against about 5 s on one slot. Cases that take more than a few seconds say
// so in their name.
import type { Subprocess } from "bun";
import { Buffer } from "node:buffer";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  installHeavyRun,
  parseArgs,
  PREVIOUS_WRAPPER,
} from "../install-heavy-run";

const HEAVY_RUN = join(import.meta.dir, "..", "heavy-run.sh");
const HEAVY_QUEUE = join(import.meta.dir, "..", "heavy-queue.sh");

/** A case that takes a few seconds; the bound is far above what it needs. */
const SLOW = 60_000;

const JOB_SH = `#!/bin/bash
# job.sh <name> <seconds | @file> [exit status]: logs its start and end to
# $JOB_LOG. With @file it runs until <file> exists, however long that takes.
echo "start $1 $(date +%s%N) \${HEAVY_SLOT:-none}" >>"$JOB_LOG"
case "$2" in
  @*) until [ -e "\${2#@}" ]; do sleep 0.05; done ;;
  0) ;;
  *) sleep "$2" ;;
esac
echo "end $1 $(date +%s%N)" >>"$JOB_LOG"
exit "\${3:-0}"
`;
const HOLD_SH = `#!/bin/bash
# hold.sh <file>: waits until <file> exists. Run under \`flock <lock>\` it
# holds that lock until the test creates <file>.
until [ -e "$1" ]; do sleep 0.05; done
`;

const BURN_SH = `#!/bin/bash
# burn.sh <name> <threads>: <threads> busy loops, each until it has used 1 s of
# CPU, so the job uses <threads> CPU seconds whatever the load. Logs its start
# and end to $JOB_LOG, as job.sh does.
echo "start $1 $(date +%s%N) \${HEAVY_SLOT:-none}" >>"$JOB_LOG"
target=$(getconf CLK_TCK)
spin() {
  local s f i
  while :; do
    for ((i = 0; i < 2000; i++)); do :; done
    read -r s <"/proc/$BASHPID/stat"
    s=\${s##*) }
    read -r -a f <<<"$s"
    (( f[11] + f[12] >= target )) && return
  done
}
for ((t = 0; t < $2; t++)); do spin & done
wait
echo "end $1 $(date +%s%N)" >>"$JOB_LOG"
`;

const sleep = (ms: number) => Bun.sleep(ms);

async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Whether some process holds the lock on `file` (probing takes it briefly).
 * Asynchronous, like everything here that spawns: the cases run concurrently,
 * and a synchronous spawn would stall every other case's clock.
 */
async function held(file: string): Promise<boolean> {
  const probe = Bun.spawn(["flock", "-n", file, "true"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await probe.exited) !== 0;
}

/** Runs a short command to its end, without blocking the other cases. */
async function exec(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(argv, {
    ...options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

function childrenOf(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function argsOf(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Whether a wrapper has a child process running `program`. */
function childOf(run: { pid: number }, program: string): boolean {
  return childrenOf(run.pid).some((pid) => argsOf(pid)[0] === program);
}

function descendants(pid: number): number[] {
  const found: number[] = [];
  for (const child of childrenOf(pid)) found.push(child, ...descendants(child));
  return found;
}

/** The command `runJob` runs: relative, so the queue's COMMAND shows the name. */
function jobCommand(
  name: string,
  seconds: number | string,
  status?: number,
): string[] {
  const command = ["bash", "job.sh", name, String(seconds)];
  if (status !== undefined) command.push(String(status));
  return command;
}

/** A started wrapper. */
interface Run {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  pid: number;
  /** Resolves to the wrapper's exit status, its stderr and when it ended. */
  done: Promise<{ code: number; stderr: string; endedAt: number }>;
}

/** One case's temporary HEAVY_DIR, its helper scripts and its processes. */
class Box {
  readonly dir = mkdtempSync(join(tmpdir(), "heavy-run-test-"));
  readonly log = join(this.dir, "jobs.log");
  readonly job = join(this.dir, "job.sh");
  readonly hold = join(this.dir, "hold.sh");
  readonly history = join(this.dir, "bun-node-heavy-history.tsv");
  private readonly pids: number[] = [];
  private holds = 0;

  constructor() {
    writeFileSync(this.job, JOB_SH);
    writeFileSync(this.hold, HOLD_SH);
    writeFileSync(join(this.dir, "burn.sh"), BURN_SH);
    writeFileSync(this.log, "");
  }

  lock(name: string): string {
    return join(this.dir, name);
  }

  /** The environment of a wrapper: no inherited HEAVY_*, this box's dir. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (key.startsWith("HEAVY_") || key.startsWith("GIT_")) continue;
      if (key === "EXAMPLE_DRIVER") continue;
      env[key] = value;
    }
    return {
      ...env,
      HEAVY_DIR: this.dir,
      HEAVY_MAX_LOAD: "999",
      HEAVY_WAIT: "120",
      JOB_LOG: this.log,
      ...extra,
    };
  }

  /** Runs `command` through the wrapper (or `script`, a copy of it). */
  run(
    command: string[],
    options: {
      env?: Record<string, string>;
      cwd?: string;
      script?: string;
    } = {},
  ): Run {
    const proc = Bun.spawn(["bash", options.script ?? HEAVY_RUN, ...command], {
      cwd: options.cwd ?? this.dir,
      env: this.env(options.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.pids.push(proc.pid);
    const done = (async () => {
      const [stderr] = await Promise.all([
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
      ]);
      const code = await proc.exited;
      return { code, stderr, endedAt: Date.now() };
    })();
    return { proc, pid: proc.pid, done };
  }

  /**
   * `job.sh <name> <seconds> [status]` through the wrapper. `seconds` may be
   * `"@<file>"`: the job then runs until `finish(<file>)`.
   */
  runJob(
    name: string,
    seconds: number | string,
    options: {
      status?: number;
      env?: Record<string, string>;
      script?: string;
    } = {},
  ): Run {
    return this.run(jobCommand(name, seconds, options.status), options);
  }

  /** The key the wrapper gives `command` in this box (`--key`). */
  async key(
    command: string[],
    env: Record<string, string> = {},
  ): Promise<string> {
    const printed = await exec(["bash", HEAVY_RUN, "--key", ...command], {
      cwd: this.dir,
      env: this.env(env),
    });
    return printed.stdout.trim();
  }

  /**
   * Appends past runs of `command` to the history. A run without `cores` is
   * an old four-field line, from before CPU was recorded.
   */
  async seed(
    command: string[],
    runs: { seconds: number; cores?: number; status?: number }[],
    env: Record<string, string> = {},
  ): Promise<void> {
    const key = await this.key(command, env);
    const now = Math.floor(Date.now() / 1000);
    const lines = runs.map(({ seconds, cores, status = 0 }) => {
      const fields = [now, key, seconds, status];
      if (cores !== undefined) {
        const cpu = (cores * seconds).toFixed(2);
        fields.push(cpu, cores.toFixed(2), "1.00", "1.00", "1", "auto");
      }
      return `${fields.join("\t")}\n`;
    });
    appendFileSync(this.history, lines.join(""));
  }

  /** The history file's lines, split into fields. */
  lines(): string[][] {
    if (!existsSync(this.history)) return [];
    return readFileSync(this.history, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
  }

  /** Points HEAVY_LOADAVG at a file reading `load`, for a fixed load. */
  fixedLoad(load: number): Record<string, string> {
    const file = join(this.dir, "loadavg");
    writeFileSync(file, `${load.toFixed(2)} ${load.toFixed(2)} 0.00 1/100 1\n`);
    return { HEAVY_LOADAVG: file };
  }

  /** Lets a job started with `"@<file>"` finish. */
  finish(file: string): void {
    writeFileSync(join(this.dir, file), "");
  }

  /** Holds `lock` with a plain `flock`, as a job outside the wrapper would. */
  async holdLock(lock: string): Promise<() => Promise<void>> {
    const release = join(this.dir, `release-${this.holds++}`);
    const proc = Bun.spawn(["flock", lock, "bash", this.hold, release], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    this.pids.push(proc.pid);
    await until(`a plain flock on ${lock}`, () => held(lock));
    return async () => {
      writeFileSync(release, "");
      await proc.exited;
    };
  }

  /** The phase a wrapper recorded (`pid-<pid>.state`), or undefined. */
  phase(run: Run): string | undefined {
    const file = join(this.dir, "bun-node-heavy-jobs", `pid-${run.pid}.state`);
    try {
      return readFileSync(file, "utf8").split(" ")[0];
    } catch {
      return undefined;
    }
  }

  async phaseIs(run: Run, phase: string, timeoutMs?: number): Promise<void> {
    await until(`phase ${phase}`, () => this.phase(run) === phase, timeoutMs);
  }

  /** The jobs' log: each job's start and end (ms) and the slot it ran in. */
  jobs(): Map<string, { start: number; end?: number; slot: string }> {
    const jobs = new Map<
      string,
      { start: number; end?: number; slot: string }
    >();
    for (const line of readFileSync(this.log, "utf8").split("\n")) {
      const [what, name, ns, slot] = line.split(" ");
      if (!name || !ns) continue;
      const ms = Number(ns) / 1e6;
      if (what === "start") jobs.set(name, { start: ms, slot: slot ?? "" });
      else if (what === "end") jobs.get(name)!.end = ms;
    }
    return jobs;
  }

  /** How many times a job named `name` started. */
  starts(name: string): number {
    const lines = readFileSync(this.log, "utf8").split("\n");
    return lines.filter((line) => line.startsWith(`start ${name} `)).length;
  }

  /** The jobs in the order they started. */
  order(): string[] {
    return [...this.jobs()]
      .sort(([, a], [, b]) => a.start - b.start)
      .map(([name]) => name);
  }

  /** The most jobs that ran at the same moment. */
  maxOverlap(): number {
    const events: [number, number][] = [];
    for (const { start, end } of this.jobs().values())
      events.push([start, 1], [end ?? Infinity, -1]);
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0;
    let most = 0;
    for (const [, delta] of events) most = Math.max(most, (now += delta));
    return most;
  }

  /** Runs heavy-queue.sh against this box. */
  async queue(): Promise<string> {
    const proc = Bun.spawn(["bash", HEAVY_QUEUE], {
      cwd: this.dir,
      env: this.env({ HEAVY_WRAPPER: HEAVY_RUN }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  }

  /** Kills whatever this case started that still runs, and removes the dir. */
  async cleanup(): Promise<void> {
    const all = this.pids.flatMap((pid) => [pid, ...descendants(pid)]);
    for (const pid of all) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A test with a fresh Box, cleaned up however it ends. */
function scenario(
  name: string,
  body: (box: Box) => Promise<void>,
  timeout = 20_000,
) {
  // Concurrent: each case has its own HEAVY_DIR and mostly sleeps, and run
  // one after another they take minutes on a loaded machine.
  it.concurrent(
    name,
    async () => {
      const box = new Box();
      try {
        await body(box);
      } finally {
        await box.cleanup();
      }
    },
    timeout,
  );
}

/** The queue row (one line) whose text includes `marker`. */
function row(queue: string, marker: string): string {
  const line = queue.split("\n").find((l) => l.includes(marker));
  if (!line) throw new Error(`no queue row with ${marker} in:\n${queue}`);
  return line;
}

describe("heavy-run.sh: slots and exit status", () => {
  scenario(
    "a free slot is slot 1, and the exit status passes through",
    async (box) => {
      const ok = box.runJob("ok", 0);
      expect((await ok.done).code).toBe(0);
      expect(box.jobs().get("ok")!.slot).toBe("1");

      expect((await box.runJob("three", 0, { status: 3 }).done).code).toBe(3);
      // 75 is also what the wrapper exits with when it gives up; a command that
      // exits 75 ran once and is not mistaken for a busy slot.
      const r75 = await box.runJob("seventy-five", 0, { status: 75 }).done;
      expect(r75.code).toBe(75);
      expect(r75.stderr).not.toContain("giving up");
      expect(box.starts("seventy-five")).toBe(1);
      expect((await box.run(["false"]).done).code).toBe(1);
    },
  );

  scenario(
    "two slots: three 1 s jobs run two at a time [slow, ~3 s]",
    async (box) => {
      const began = Date.now();
      const runs = ["a", "b", "c"].map((name) => box.runJob(name, 1));
      const results = await Promise.all(runs.map((r) => r.done));
      const wall = (Math.max(...results.map((r) => r.endedAt)) - began) / 1000;
      expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
      expect(box.maxOverlap()).toBe(2);
      expect(new Set([...box.jobs().values()].map((j) => j.slot))).toEqual(
        new Set(["1", "2"]),
      );
      // Two at once and the third at the next 2 s poll: about 3 s, against
      // about 1 s for all three together and 5 s one at a time. The overlap
      // above is the claim; at a load of 70 on 16 cores this run has taken
      // 6 s, so the wall time is only a sanity bound.
      expect(wall).toBeGreaterThan(1.8);
      expect(wall).toBeLessThan(12);
    },
    SLOW,
  );

  scenario(
    "with the load gate shut, jobs run one at a time in slot 1 [slow, ~3 s]",
    async (box) => {
      const env = { HEAVY_MAX_LOAD: "0" };
      const runs = ["a", "b"].map((name) => box.runJob(name, 1, { env }));
      const results = await Promise.all(runs.map((r) => r.done));
      expect(results.map((r) => r.code)).toEqual([0, 0]);
      expect(box.maxOverlap()).toBe(1);
      expect([...box.jobs().values()].map((j) => j.slot)).toEqual(["1", "1"]);
    },
    SLOW,
  );

  scenario(
    "the wait limit: no slot within HEAVY_WAIT exits 75 [slow, ~3 s]",
    async (box) => {
      const release = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const began = Date.now();
      const run = box.runJob("never", 0, {
        env: { HEAVY_MAX_LOAD: "0", HEAVY_WAIT: "3" },
      });
      const result = await run.done;
      const waited = (result.endedAt - began) / 1000;
      expect(result.code).toBe(75);
      expect(result.stderr).toContain("giving up");
      expect(box.starts("never")).toBe(0);
      // Its clock counts whole seconds, so it can give up up to 1 s early,
      // and it notices between 2 s naps, so up to 2 s late.
      expect(waited).toBeGreaterThan(1.5);
      expect(waited).toBeLessThan(8);
      await release();
    },
    SLOW,
  );
});

describe("heavy-run.sh: exclusive jobs", () => {
  scenario(
    "an exclusive job runs in every slot, and nothing overlaps it [slow, ~5 s]",
    async (box) => {
      const o1 = box.runJob("o1", "@o1-done");
      await box.phaseIs(o1, "running");
      const e = box.runJob("e", 1, { env: { HEAVY_EXCLUSIVE: "1" } });
      await box.phaseIs(e, "waiting-slots");
      const o2 = box.runJob("o2", 1);
      await box.phaseIs(o2, "head");
      box.finish("o1-done");
      const results = await Promise.all([o1, e, o2].map((r) => r.done));
      expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
      const jobs = box.jobs();
      expect(jobs.get("e")!.slot).toBe("all");
      expect(box.order()).toEqual(["o1", "e", "o2"]);
      const ex = jobs.get("e")!;
      for (const name of ["o1", "o2"]) {
        const o = jobs.get(name)!;
        expect(o.end! <= ex.start || o.start >= ex.end!).toBe(true);
      }
    },
    SLOW,
  );

  scenario(
    "the streak cap: an ordinary job queued between two exclusive ones runs between them [slow, ~6 s]",
    async (box) => {
      const exclusive = { env: { HEAVY_EXCLUSIVE: "1" } };
      const e1 = box.runJob("e1", "@e1-done", exclusive);
      await box.phaseIs(e1, "running");
      const o = box.runJob("o", 1);
      await box.phaseIs(o, "head");
      const e2 = box.runJob("e2", 1, exclusive);
      await box.phaseIs(e2, "stepping-back");

      // The queue reads each wrapper's own phase. E2 leaves "stepping-back"
      // for an instant every 2 s to look again, so allow a second look.
      let queue = await box.queue();
      if (!queue.includes("stepping back")) queue = await box.queue();
      expect(row(queue, "e1")).toMatch(/RUNNING .*\[exclusive\]/);
      expect(row(queue, " o ")).toContain("head of the line");
      expect(row(queue, "e2")).toContain(
        "stepping back for ordinary jobs [exclusive]",
      );

      box.finish("e1-done");
      const results = await Promise.all([e1, o, e2].map((r) => r.done));
      expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
      expect(box.order()).toEqual(["e1", "o", "e2"]);
    },
    SLOW,
  );

  // The race the bump's ordering fixed: E1 holds the reserve while it waits
  // for slot 2, O and E2 queue behind it, and the moment E1 has every slot it
  // releases the reserve, which E2 (blocked on it) takes at once. If E1 counts
  // its start in the streak only AFTER releasing the reserve, E2 can read the
  // streak first, see 0, and run straight after E1 while O still waits.
  //
  // The window is a few forks wide, so the test holds the streak's own lock
  // while slot 2 frees: E1 then stalls at the bump. Bumping first, it stalls
  // still holding the reserve and E2 sees nothing until the bump is in;
  // bumping after the release, E2 reads a streak of 0 during the stall. That
  // makes the bad ordering lose every time, and the negative control below
  // proves it: on a copy with the bump moved after the release this scenario
  // gives E1, E2, O. The same mutation made by hand to scripts/heavy-run.sh
  // itself (2026-10-07) failed the race test below on each of two runs, with
  // E2 where O should be.
  async function race(box: Box, script?: string): Promise<string[]> {
    const exclusive = { env: { HEAVY_EXCLUSIVE: "1" }, script };
    const releaseSlot2 = await box.holdLock(box.lock("bun-node-heavy.2.lock"));
    const e1 = box.runJob("e1", 1, exclusive);
    await box.phaseIs(e1, "waiting-slots");
    const slot1 = box.lock("bun-node-heavy.lock");
    await until("E1 to hold slot 1", () => held(slot1));
    const o = box.runJob("o", 1, { script });
    await box.phaseIs(o, "head");
    const e2 = box.runJob("e2", 1, exclusive);
    await box.phaseIs(e2, "waiting-reserve");
    const blocked = () => childOf(e2, "flock");
    await until("E2 to block on the reserve", blocked);
    const releaseStreak = await box.holdLock(
      box.lock("bun-node-heavy.streak.lock"),
    );
    await releaseSlot2();
    await sleep(1500);
    await releaseStreak();
    const results = await Promise.all([e1, o, e2].map((r) => r.done));
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    return box.order();
  }

  scenario(
    "the race: the streak is bumped before the reserve is released [slow, ~7 s]",
    async (box) => {
      expect(await race(box)).toEqual(["e1", "o", "e2"]);
    },
    SLOW,
  );

  scenario(
    "negative control: with the bump after the release, the race test sees E2 jump O [slow, ~5 s]",
    async (box) => {
      const source = readFileSync(HEAVY_RUN, "utf8");
      const right = "  streak_set bump\n  exec {reserve}>&-\n";
      const wrong = "  exec {reserve}>&-\n  streak_set bump\n";
      expect(source.split(right)).toHaveLength(2);
      const mutated = join(box.dir, "heavy-run.mutated.sh");
      writeFileSync(mutated, source.replace(right, wrong));
      expect(await race(box, mutated)).toEqual(["e1", "e2", "o"]);
    },
    SLOW,
  );
});

describe("heavy-run.sh: waiting in the kernel", () => {
  scenario(
    "with six jobs waiting, at most one polls; the rest block at the turnstile [slow, ~5 s]",
    async (box) => {
      const release1 = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const release2 = await box.holdLock(box.lock("bun-node-heavy.2.lock"));
      const runs = Array.from({ length: 6 }, (_, i) => box.runJob(`w${i}`, 0));
      // Each records "in-line" before the turnstile and "head" once past it.
      await until("one head and five in line", () => {
        const phases = runs.map((r) => box.phase(r));
        return (
          phases.filter((p) => p === "head").length === 1 &&
          phases.filter((p) => p === "in-line").length === 5
        );
      });

      const pollers = (run: Run) => childOf(run, "sleep");
      let most = 0;
      let seen = 0;
      for (let i = 0; i < 25; i++) {
        const polling = runs.filter(pollers).length;
        most = Math.max(most, polling);
        seen += polling;
        await sleep(100);
      }
      expect(most).toBeLessThanOrEqual(1);
      expect(seen).toBeGreaterThan(0); // the head does poll

      const queue = await box.queue();
      expect(queue.match(/head of the line/g)).toHaveLength(1);
      expect(queue.match(/, in line/g)).toHaveLength(5);

      await release1();
      await release2();
      const results = await Promise.all(runs.map((r) => r.done));
      expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0]);
    },
    SLOW,
  );
});

describe("heavy-run.sh: tickets", () => {
  scenario(
    "a ticket runs once, then returns its recorded status",
    async (box) => {
      const env = { HEAVY_TICKET: "t-1" };
      expect((await box.runJob("t", 0, { status: 3, env }).done).code).toBe(3);
      expect(box.starts("t")).toBe(1);
      const status = readFileSync(
        join(box.dir, "bun-node-heavy-jobs", "t-1.status"),
        "utf8",
      );
      expect(status).toMatch(/^done 3 /);

      const again = await box.runJob("t", 0, { status: 3, env }).done;
      expect(again.code).toBe(3);
      expect(again.stderr).toContain("finished with exit 3");
      expect(box.starts("t")).toBe(1);

      const rerun = box.runJob("t", 0, {
        status: 3,
        env: { ...env, HEAVY_RERUN: "1" },
      });
      expect((await rerun.done).code).toBe(3);
      expect(box.starts("t")).toBe(2);

      // A different command under the same ticket runs fresh.
      expect((await box.runJob("other", 0, { env }).done).code).toBe(0);
      expect(box.starts("other")).toBe(1);
    },
  );

  scenario("an invalid ticket exits 64 and runs nothing", async (box) => {
    const run = box.runJob("bad", 0, { env: { HEAVY_TICKET: "no/slash" } });
    const result = await run.done;
    expect(result.code).toBe(64);
    expect(box.starts("bad")).toBe(0);
  });

  scenario(
    "a second call while the ticket's job is queued attaches: one run, both get its status [slow, ~3 s]",
    async (box) => {
      const env = { HEAVY_TICKET: "t-attach", HEAVY_MAX_LOAD: "0" };
      const release = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const first = box.runJob("t", 0, { status: 5, env });
      await box.phaseIs(first, "head");
      const second = box.runJob("t", 0, { status: 5, env });
      await box.phaseIs(second, "attached");
      await release();
      const results = await Promise.all([first.done, second.done]);
      expect(results.map((r) => r.code)).toEqual([5, 5]);
      expect(box.starts("t")).toBe(1);
    },
    SLOW,
  );

  scenario(
    "SIGKILL of a queued wrapper frees its ticket and the turnstile at once [slow, ~3 s]",
    async (box) => {
      const env = { HEAVY_TICKET: "t-kill", HEAVY_MAX_LOAD: "0" };
      const release = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const victim = box.runJob("t", 0, { env });
      await box.phaseIs(victim, "head");
      const behind = box.runJob("behind", 0, { env: { HEAVY_MAX_LOAD: "0" } });
      await box.phaseIs(behind, "in-line");
      // Kill it mid-nap, when a child of its (the 2 s sleep) is alive.
      await until("the head to nap", () => childOf(victim, "sleep"));
      const orphans = descendants(victim.pid);
      process.kill(victim.pid, "SIGKILL");
      await victim.done;

      const ticketLock = join(box.dir, "bun-node-heavy-jobs", "t-kill.lock");
      await until(
        "the ticket to be free",
        async () => !(await held(ticketLock)),
        500,
      );
      // The next in line becomes the head well inside the dead one's nap.
      await box.phaseIs(behind, "head", 1500);
      for (const pid of orphans) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }

      await release();
      expect((await behind.done).code).toBe(0);
      // Its status still says queued: the next call runs it.
      const next = await box.runJob("t", 0, { env }).done;
      expect(next.code).toBe(0);
      expect(box.starts("t")).toBe(1);
    },
    SLOW,
  );
});

describe("heavy-run.sh: history and keys", () => {
  function history(box: Box): string[][] {
    const file = join(box.dir, "bun-node-heavy-history.tsv");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
  }

  /** A git repository with `examples/bun-jobs/run.sh` exiting `$1`. */
  async function clone(box: Box, name: string): Promise<string> {
    const top = join(box.dir, name);
    const cwd = join(top, "examples", "bun-jobs");
    mkdirSync(cwd, { recursive: true });
    expect(
      (await exec(["git", "init", "-q", top], { env: box.env() })).code,
    ).toBe(0);
    writeFileSync(join(cwd, "run.sh"), 'exit "$1"\n');
    return cwd;
  }

  scenario(
    "each run appends one line, keyed the same from any clone",
    async (box) => {
      const command = ["timeout", "-k", "5", "30", "bash", "./run.sh", "0"];
      // HEAVY_MODE=slot: since auto became the default, clone-a's quick run
      // is history that sends clone-b's straight to "direct". The key is the
      // same either way; this keeps the case on the slot path it was written for.
      const env = { EXAMPLE_DRIVER: "memory", HEAVY_MODE: "slot" };
      const key = "examples/bun-jobs: bash ./run.sh 0 [EXAMPLE_DRIVER=memory]";
      for (const name of ["clone-a", "clone-b"]) {
        const cwd = await clone(box, name);
        expect((await box.run(command, { cwd, env }).done).code).toBe(0);
        const printed = await exec(["bash", HEAVY_RUN, "--key", ...command], {
          cwd,
          env: box.env(env),
        });
        expect(printed.stdout).toBe(`${key}\n`);
      }
      const lines = history(box);
      expect(lines).toHaveLength(2);
      for (const [epoch, lineKey, seconds, status, ...measured] of lines) {
        // cpu seconds, cores, load at start and end, where, mode asked.
        expect(measured).toHaveLength(6);
        expect(measured.slice(4)).toEqual(["1", "slot"]);
        expect(lineKey).toBe(key);
        expect(Number(epoch)).toBeGreaterThan(1_700_000_000);
        expect(seconds).toMatch(/^\d+$/);
        expect(status).toBe("0");
      }

      // Exclusive is part of the key, and so is a failure's status.
      const cwd = await clone(box, "clone-c");
      const failing = box.run(["bash", "./run.sh", "4"], {
        cwd,
        env: { HEAVY_EXCLUSIVE: "1" },
      });
      expect((await failing.done).code).toBe(4);
      expect(history(box)[2]!.slice(1, 2)).toEqual([
        "examples/bun-jobs: bash ./run.sh 4 [exclusive]",
      ]);
      expect(history(box)[2]![3]).toBe("4");

      // Outside a repository, the directory's own name stands in.
      const plain = join(box.dir, "plain-dir");
      mkdirSync(plain);
      await box.run(["true"], { cwd: plain }).done;
      expect(history(box)[3]![1]).toBe("plain-dir: true");
    },
  );

  scenario(
    "the queue's EST: unknown with no history, then the median and what is left [slow, ~6 s]",
    async (box) => {
      const cwd = await clone(box, "clone");
      // Runs until the test is done with it, however slow the queue is.
      writeFileSync(
        join(cwd, "long.sh"),
        'until [ -e "$HEAVY_DIR/long-done" ]; do sleep 0.1; done\n',
      );
      const env = { HEAVY_MAX_LOAD: "0" };
      const running = box.run(["timeout", "60", "bash", "./long.sh"], {
        cwd,
        env,
      });
      await box.phaseIs(running, "running");
      const waiting = box.run(["timeout", "60", "bash", "./long.sh"], {
        cwd,
        env,
      });
      await box.phaseIs(waiting, "head");

      let queue = await box.queue();
      expect(queue.split("\n")[0]).toMatch(/^STATE\s+EST\s+SESSION/);
      expect(row(queue, "RUNNING")).toContain("unknown");
      expect(row(queue, "head of the line")).toContain("unknown");

      // The last 10 successful runs count: two older outliers, failures and
      // another kind of job do not.
      const key = "examples/bun-jobs: bash ./long.sh";
      const now = Math.floor(Date.now() / 1000);
      const lines = [
        [key, 9999, 0],
        [key, 9999, 0],
        ...[340, 345, 350, 355, 360, 365, 370, 375, 380, 390].map((s) => [
          key,
          s,
          0,
        ]),
        [key, 5, 1],
        [key, 7, 124],
        ["elsewhere: bash ./long.sh", 10, 0],
      ].map(([k, s, rc]) => `${now}\t${k}\t${s}\t${rc}\n`);
      writeFileSync(
        join(box.dir, "bun-node-heavy-history.tsv"),
        lines.join(""),
      );

      queue = await box.queue();
      // Median of 340..390 is (360 + 365) / 2, rounded down: 6m02s.
      expect(row(queue, "RUNNING")).toMatch(/~6m02s, ~6m left/);
      expect(row(queue, "head of the line")).toContain("~6m02s (n=10)");

      // Past the median, it says by how much.
      writeFileSync(
        join(box.dir, "bun-node-heavy-history.tsv"),
        `${now}\t${key}\t1\t0\n`,
      );
      await until("the job to run past 1 s", () => {
        const since = readFileSync(
          join(box.dir, "bun-node-heavy-jobs", `pid-${running.pid}.state`),
          "utf8",
        ).split(" ")[1];
        return Date.now() / 1000 - Number(since) >= 3;
      });
      expect(row(await box.queue(), "RUNNING")).toMatch(
        /~0m01s, overrun \+\d+s/,
      );
      box.finish("long-done");
      const results = await Promise.all([running.done, waiting.done]);
      expect(results.map((r) => r.code)).toEqual([0, 0]);
    },
    SLOW,
  );

  scenario(
    "the queue ignores, and deletes, a state file whose wrapper is gone",
    async (box) => {
      const gone = Bun.spawn(["true"]);
      await gone.exited;
      const jobs = join(box.dir, "bun-node-heavy-jobs");
      mkdirSync(jobs, { recursive: true });
      const stale = join(jobs, `pid-${gone.pid}.state`);
      writeFileSync(stale, `running ${Math.floor(Date.now() / 1000)}\n`);
      const queue = await box.queue();
      expect(queue).toContain("Nothing holds or waits");
      expect(existsSync(stale)).toBe(false);
    },
  );
});

describe("heavy-run.sh: adaptive mode (HEAVY_MODE=auto, the default)", () => {
  /** A light job: well under 60 s and 2 cores. */
  const LIGHT = [2, 2, 3].map((seconds) => ({ seconds, cores: 0.3 }));
  /** A job between light and machine-wide: 5 min on 4 cores. */
  const MID = [300, 300].map((seconds) => ({ seconds, cores: 4 }));
  /** Machine-wide against HEAVY_EXCLUSIVE_CORES=8. */
  const WIDE = [300, 300].map((seconds) => ({ seconds, cores: 12 }));

  scenario(
    "CPU: two busy loops record about 2 CPU seconds, a sleep about none [slow, ~2 s]",
    async (box) => {
      const burn = box.run(["bash", "burn.sh", "burn", "2"]);
      const nap = box.runJob("nap", 1);
      const results = await Promise.all([burn.done, nap.done]);
      expect(results.map((r) => r.code)).toEqual([0, 0]);

      const of = (marker: string) =>
        box.lines().find((line) => line[1]!.endsWith(marker))!;
      const burnt = of("burn.sh burn 2");
      expect(burnt).toHaveLength(10);
      const [cpu, cores, loadStart, loadEnd] = burnt.slice(4, 8).map(Number);
      // Each loop stops once it has used 1 s of CPU, so the job's CPU is
      // about 2 s however loaded the machine is: both children counted.
      expect(cpu).toBeGreaterThan(1.9);
      expect(cpu).toBeLessThan(2.6);
      // Cores is that CPU over the job's wall time: about 2 on a machine with
      // two cores free. Under load the loops take longer and the figure is
      // lower, so it is checked against the job's own wall time, not 2.
      const job = box.jobs().get("burn")!;
      const wall = (job.end! - job.start) / 1000;
      expect(Math.abs(cores! - cpu! / wall)).toBeLessThan(0.25);
      expect(loadStart).toBeGreaterThanOrEqual(0);
      expect(loadEnd).toBeGreaterThanOrEqual(0);
      expect(burnt.slice(8)).toEqual([job.slot, "auto"]);

      const slept = of("job.sh nap 1");
      expect(Number(slept[4])).toBeLessThan(0.1);
      expect(Number(slept[5])).toBeLessThan(0.1);
    },
    SLOW,
  );

  scenario(
    "old four-field history lines still give an EST and a decision",
    async (box) => {
      // Only old lines: the wall time is known, the CPU is not, so a slot.
      const old = jobCommand("old", "@old-done");
      await box.seed(old, [{ seconds: 5 }, { seconds: 5 }, { seconds: 6 }]);
      const run = box.runJob("old", "@old-done");
      await box.phaseIs(run, "running");
      const queue = await box.queue();
      expect(row(queue, "@old-done")).toMatch(/RUNNING .*\[auto→slot\]/);
      expect(row(queue, "@old-done")).toMatch(
        /~0m05s, (~\ds left|overrun \+\d+s)/,
      );
      expect(row(queue, "@old-done")).not.toContain("cores");
      box.finish("old-done");
      const result = await run.done;
      expect(result.stderr).toContain(
        "auto → slot (median 0m05s, no CPU on record, n=3)",
      );
      expect(box.jobs().get("old")!.slot).toBe("1");

      // Old and new lines mixed: the wall median counts all of them, the
      // cores median those that recorded CPU.
      const mixed = jobCommand("mixed", 0);
      await box.seed(mixed, [{ seconds: 5 }, { seconds: 5 }, { seconds: 9 }]);
      await box.seed(mixed, [{ seconds: 5, cores: 0.5 }]);
      const stats = await exec(["bash", HEAVY_RUN, "--stats", ...mixed], {
        cwd: box.dir,
        env: box.env(),
      });
      expect(stats.stdout).toBe("5 4 0.50 1\n");
      const light = await box.runJob("mixed", 0).done;
      expect(light.stderr).toContain(
        "auto → direct (median 0m05s, 0.5 cores, n=4)",
      );
      expect(box.jobs().get("mixed")!.slot).toBe("direct");
    },
  );

  scenario("with no history, auto takes a slot", async (box) => {
    const result = await box.runJob("fresh", 0).done;
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("auto → slot (no history)");
    expect(box.jobs().get("fresh")!.slot).toBe("1");
    const [line] = box.lines();
    expect(line!.slice(8)).toEqual(["1", "auto"]);
    // A job of a few milliseconds counts as lasting a second, so its cores
    // are no more than its CPU seconds, not a few ticks over a few ms.
    expect(Number(line![5])).toBeLessThanOrEqual(Number(line![4]) + 0.01);
  });

  scenario(
    "light history runs at once, with both slots held by other jobs",
    async (box) => {
      await box.seed(jobCommand("light", 0), LIGHT);
      const release1 = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const release2 = await box.holdLock(box.lock("bun-node-heavy.2.lock"));
      // Both slots stay held throughout: a job that waited for one would
      // never end, and the case would time out.
      const result = await box.runJob("light", 0).done;
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        "auto → direct (median 0m02s, 0.3 cores, n=3)",
      );
      expect(box.jobs().get("light")!.slot).toBe("direct");
      expect(box.lines().at(-1)!.slice(8)).toEqual(["direct", "auto"]);
      await release1();
      await release2();
    },
  );

  scenario(
    "machine-wide history runs exclusive, under the job's own key",
    async (box) => {
      const env = { HEAVY_EXCLUSIVE_CORES: "8" };
      const wide = jobCommand("wide", 0);
      await box.seed(wide, WIDE);
      const result = await box.runJob("wide", 0, { env }).done;
      expect(result.stderr).toContain(
        "auto → exclusive (median 5m00s, 12.0 cores, n=2)",
      );
      expect(box.jobs().get("wide")!.slot).toBe("all");
      // An auto decision is not part of the key, so the run's history goes
      // where the next decision will read it.
      const last = box.lines().at(-1)!;
      expect(last[1]).toBe(await box.key(wide));
      expect(last[1]).not.toContain("[exclusive]");

      // The default threshold is 75% of the cores: all of them is above it.
      const cores = Number((await exec(["nproc"])).stdout);
      const all = jobCommand("all-cores", 0);
      await box.seed(all, [{ seconds: 300, cores }]);
      await box.runJob("all-cores", 0).done;
      expect(box.jobs().get("all-cores")!.slot).toBe("all");
    },
  );

  scenario(
    "mid history takes a slot when one is free, and runs at once when it fits",
    async (box) => {
      await box.seed(jobCommand("mid", 0), MID);
      const free = await box.runJob("mid", 0).done;
      expect(free.stderr).toContain(
        "auto → slot (median 5m00s, 4.0 cores, n=2)",
      );
      expect(box.jobs().get("mid")!.slot).toBe("1");

      // No slot free, a load of 1 and 4 cores of its own, under 8: it fits.
      const release1 = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const release2 = await box.holdLock(box.lock("bun-node-heavy.2.lock"));
      const env = { ...box.fixedLoad(1), HEAVY_MAX_LOAD: "8" };
      const fits = await box.runJob("mid", 0, { env }).done;
      expect(fits.stderr).toContain(
        "auto → direct, no slot free but it fits (load 1.0 + 0.0 starting + 4.0 < 8.0)",
      );
      expect(box.jobs().get("mid")!.slot).toBe("direct");
      await release1();
      await release2();
    },
  );

  scenario(
    "fits counts the jobs that started in the last minute: two do not both go [slow, ~3 s]",
    async (box) => {
      const command = jobCommand("mid", "@mid-done");
      await box.seed(command, MID);
      const release1 = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const release2 = await box.holdLock(box.lock("bun-node-heavy.2.lock"));
      // 1 + 4 < 8 for the first; 1 + 4 (the first, too new for the load to
      // show) + 4 is not, so the second waits at the head of the line.
      const env = { ...box.fixedLoad(1), HEAVY_MAX_LOAD: "8" };
      const first = box.runJob("mid", "@mid-done", { env });
      await box.phaseIs(first, "direct");
      const second = box.runJob("mid", "@mid-done", { env });
      await box.phaseIs(second, "head");
      await until("the second to look and nap", () => childOf(second, "sleep"));
      expect(box.starts("mid")).toBe(1);

      box.finish("mid-done");
      const results = await Promise.all([first.done, second.done]);
      expect(results.map((r) => r.code)).toEqual([0, 0]);
      expect(results[1]!.stderr).toContain("load 1.0 + 0.0 starting + 4.0");
      expect(box.starts("mid")).toBe(2);
      await release1();
      await release2();
    },
    SLOW,
  );

  scenario(
    "fits never jumps an exclusive job holding the reserve [slow, ~3 s]",
    async (box) => {
      await box.seed(jobCommand("mid", 0), MID);
      const release1 = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const release2 = await box.holdLock(box.lock("bun-node-heavy.2.lock"));
      const reserve = await box.holdLock(
        box.lock("bun-node-heavy.reserve.lock"),
      );
      const run = box.runJob("mid", 0, { env: box.fixedLoad(1) });
      await box.phaseIs(run, "head");
      await until("it to look and nap", () => childOf(run, "sleep"));
      expect(box.starts("mid")).toBe(0);
      await reserve();
      expect((await run.done).code).toBe(0);
      expect(box.jobs().get("mid")!.slot).toBe("direct");
      await release1();
      await release2();
    },
    SLOW,
  );

  scenario(
    "fits never runs beside a running exclusive job: it waits for a slot [slow, ~3 s]",
    async (box) => {
      await box.seed(jobCommand("mid", 0), MID);
      const exclusive = box.runJob("e", "@e-done", {
        env: { HEAVY_EXCLUSIVE: "1" },
      });
      await box.phaseIs(exclusive, "running");
      const run = box.runJob("mid", 0, { env: box.fixedLoad(1) });
      await box.phaseIs(run, "head");
      await until("it to look and nap", () => childOf(run, "sleep"));
      expect(box.starts("mid")).toBe(0);
      box.finish("e-done");
      const results = await Promise.all([exclusive.done, run.done]);
      expect(results.map((r) => r.code)).toEqual([0, 0]);
      expect(box.jobs().get("mid")!.slot).toBe("1");
    },
    SLOW,
  );

  scenario("HEAVY_EXCLUSIVE=1 wins over light history", async (box) => {
    const light = jobCommand("light", 0);
    const env = { HEAVY_EXCLUSIVE: "1" };
    // Under its own key and under the [exclusive] one.
    await box.seed(light, LIGHT);
    await box.seed(light, LIGHT, env);
    const result = await box.runJob("light", 0, { env }).done;
    expect(result.stderr).toContain("exclusive (HEAVY_EXCLUSIVE=1)");
    expect(box.jobs().get("light")!.slot).toBe("all");
    // It wins over an explicit HEAVY_MODE too.
    const both = { ...env, HEAVY_MODE: "direct" };
    await box.runJob("light2", 0, { env: both }).done;
    expect(box.jobs().get("light2")!.slot).toBe("all");
  });

  scenario(
    "HEAVY_MODE=slot wins over light history: it waits for a slot [slow, ~3 s]",
    async (box) => {
      await box.seed(jobCommand("light", 0), LIGHT);
      const release1 = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const release2 = await box.holdLock(box.lock("bun-node-heavy.2.lock"));
      const env = { ...box.fixedLoad(0), HEAVY_MODE: "slot" };
      const run = box.runJob("light", 0, { env });
      await box.phaseIs(run, "head");
      await until("it to look and nap", () => childOf(run, "sleep"));
      expect(box.starts("light")).toBe(0);
      await release1();
      const result = await run.done;
      expect(result.stderr).toContain("slot (HEAVY_MODE=slot)");
      expect(box.jobs().get("light")!.slot).toBe("1");
      await release2();
    },
    SLOW,
  );

  scenario(
    "HEAVY_MODE=direct runs at once with no history; an unknown mode exits 64",
    async (box) => {
      const release1 = await box.holdLock(box.lock("bun-node-heavy.lock"));
      const release2 = await box.holdLock(box.lock("bun-node-heavy.2.lock"));
      const env = { HEAVY_MODE: "direct" };
      const result = await box.runJob("now", 0, { env }).done;
      expect(result.stderr).toContain("direct (HEAVY_MODE=direct)");
      expect(box.jobs().get("now")!.slot).toBe("direct");
      expect(box.lines().at(-1)!.slice(8)).toEqual(["direct", "direct"]);

      const bad = await box.runJob("bad", 0, { env: { HEAVY_MODE: "fast" } })
        .done;
      expect(bad.code).toBe(64);
      expect(bad.stderr).toContain("HEAVY_MODE must be");
      expect(box.starts("bad")).toBe(0);
      await release1();
      await release2();
    },
  );

  scenario(
    "a direct run records its history and keeps its ticket",
    async (box) => {
      await box.seed(jobCommand("d", "@d-done", 3), LIGHT);
      const env = { HEAVY_TICKET: "t-direct" };
      const run = box.runJob("d", "@d-done", { status: 3, env });
      await box.phaseIs(run, "direct");
      const status = join(box.dir, "bun-node-heavy-jobs", "t-direct.status");
      expect(readFileSync(status, "utf8")).toMatch(/^running direct /);
      box.finish("d-done");
      expect((await run.done).code).toBe(3);
      expect(readFileSync(status, "utf8")).toMatch(/^done 3 /);
      const last = box.lines().at(-1)!;
      expect([last[3], ...last.slice(8)]).toEqual(["3", "direct", "auto"]);

      const again = await box.runJob("d", "@d-done", { status: 3, env }).done;
      expect(again.code).toBe(3);
      expect(again.stderr).toContain("finished with exit 3");
      expect(box.starts("d")).toBe(1);
    },
  );

  scenario(
    "the queue shows each decision, and the cores beside EST [slow, ~2 s]",
    async (box) => {
      const env = { HEAVY_EXCLUSIVE_CORES: "8" };
      await box.seed(jobCommand("s", "@s-done"), MID);
      await box.seed(jobCommand("x", "@x-done"), WIDE);
      await box.seed(jobCommand("d", "@d-done"), LIGHT);
      const s = box.runJob("s", "@s-done", { env });
      await box.phaseIs(s, "running");
      const x = box.runJob("x", "@x-done", { env });
      await box.phaseIs(x, "waiting-slots");
      const d = box.runJob("d", "@d-done", { env });
      await box.phaseIs(d, "direct");

      const queue = await box.queue();
      expect(row(queue, "@s-done")).toMatch(
        /RUNNING \d+m\d+s .*\[auto→slot\]\s+~5m00s, 4\.0 cores, ~5m left/,
      );
      expect(row(queue, "@x-done")).toMatch(
        /waiting .*, for slots \[auto→exclusive\]\s+~5m00s, 12\.0 cores \(n=2\)/,
      );
      expect(row(queue, "@d-done")).toMatch(
        /RUNNING \(direct\) .*\[auto→direct\]\s+~0m02s, 0\.3 cores, (~\ds left|overrun \+\d+s)/,
      );

      for (const name of ["s", "x", "d"]) box.finish(`${name}-done`);
      const results = await Promise.all([s, x, d].map((r) => r.done));
      expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    },
    SLOW,
  );
});

describe("install-heavy-run.ts", () => {
  function withDir(body: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "heavy-install-test-"));
    try {
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("installs both scripts atomically, executable, into a new directory", () => {
    withDir((base) => {
      const dir = join(base, "claude-1000");
      const steps = installHeavyRun({ dir });
      expect(steps.map((s) => s.action)).toEqual([
        "create-dir",
        "install",
        "install",
      ]);
      for (const [source, target] of [
        [HEAVY_RUN, "bun-node-heavy-run.sh"],
        [HEAVY_QUEUE, "bun-node-heavy-queue.sh"],
      ] as const) {
        const installed = join(dir, target);
        expect(readFileSync(installed, "utf8")).toBe(
          readFileSync(source, "utf8"),
        );
        expect(statSync(installed).mode & 0o111).toBe(0o111);
      }
      // No temporary file left behind, and no .prev with nothing to keep.
      expect(readdirSync(dir).sort()).toEqual([
        "bun-node-heavy-queue.sh",
        "bun-node-heavy-run.sh",
      ]);
    });
  });

  it("keeps the replaced wrapper as .prev, and a job's open copy is untouched", () => {
    withDir((dir) => {
      const wrapper = join(dir, "bun-node-heavy-run.sh");
      writeFileSync(wrapper, "#!/bin/bash\n# the old wrapper\n");
      chmodSync(wrapper, 0o755);
      const before = statSync(wrapper).ino;
      // What a running job holds: bash reads its script through an open fd.
      const fd = openSync(wrapper, "r");
      try {
        const steps = installHeavyRun({ dir });
        expect(steps.map((s) => s.action)).toEqual([
          "keep-previous",
          "install",
          "install",
        ]);
        expect(readFileSync(join(dir, PREVIOUS_WRAPPER), "utf8")).toContain(
          "the old wrapper",
        );
        expect(statSync(wrapper).ino).not.toBe(before);
        const buffer = Buffer.alloc(64);
        const read = readSync(fd, buffer, 0, 64, 0);
        expect(buffer.subarray(0, read).toString()).toContain(
          "the old wrapper",
        );
      } finally {
        closeSync(fd);
      }

      // Installing the same scripts again writes nothing, and .prev stays.
      const again = installHeavyRun({ dir });
      expect(again.map((s) => s.action)).toEqual(["unchanged", "unchanged"]);
      expect(readFileSync(join(dir, PREVIOUS_WRAPPER), "utf8")).toContain(
        "the old wrapper",
      );
    });
  });

  it("--dry-run reports the plan and writes nothing", () => {
    withDir((base) => {
      const fresh = join(base, "fresh");
      const plan = installHeavyRun({ dir: fresh, dryRun: true });
      expect(plan.map((s) => s.action)).toEqual([
        "create-dir",
        "install",
        "install",
      ]);
      expect(existsSync(fresh)).toBe(false);

      writeFileSync(join(base, "bun-node-heavy-run.sh"), "old\n");
      const replace = installHeavyRun({ dir: base, dryRun: true });
      expect(replace.map((s) => s.action)).toEqual([
        "keep-previous",
        "install",
        "install",
      ]);
      expect(readdirSync(base)).toEqual(["bun-node-heavy-run.sh"]);
      expect(readFileSync(join(base, "bun-node-heavy-run.sh"), "utf8")).toBe(
        "old\n",
      );
    });
  });

  it("parses its command line", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--dry-run", "--dir", "/x"])).toEqual({
      dryRun: true,
      dir: "/x",
    });
    expect(parseArgs(["--dir=/y"])).toEqual({ dir: "/y" });
    expect(parseArgs(["--dir"])).toEqual({ error: "--dir needs a path" });
    expect(parseArgs(["--nope"])).toEqual({
      error: "unknown argument: --nope",
    });
  });
});
