import type { WorkerTargetAttempt } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "bun:test";
import {
  FileTargetExecutor,
  TARGET_CLOSE_GRACE,
  TARGET_CLOSE_REAP,
} from "../lib/queue/workerTarget";
import { SpawnExecutor } from "../lib/runner/executors/spawn";
import { DEFAULT_CLOSE_TIMEOUT } from "../lib/shared/constants";
import { makeTmpDir } from "./helpers";
import { spawnBun } from "./helpers/spawnBun";

/**
 * `worker.close()` must not leave a child-process attempt running after the
 * process that closed it has gone (#166) — and must still give a child that
 * cleans up when asked the chance to: graceful first, killed only at
 * `TARGET_CLOSE_GRACE`.
 *
 * Tested in a real process that closes its worker and then ends, because that
 * is the only place the bug exists: the child and its kill timers are unref'd,
 * so inside a test runner — which keeps its own event loop alive — the timers
 * fire eventually and the child dies on schedule whatever `close()` does.
 *
 * **How the child is identified.** Not by searching command lines: the
 * child's names `spawn-entry.ts`, never the processor, and a search has three
 * times this week matched nothing, the wrong worktree or its own shell. The
 * processor writes its own pid and its parent's to a file before it spins,
 * so the test knows exactly which process to look at — and fails, rather than
 * passes, if that file never appears. `ps`, taken by the scenario while the
 * child is certainly alive, then confirms it runs this worktree's
 * `spawn-entry.ts` as a child of the scenario.
 */

const scenario = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "close-orphan.ts",
);

/** How long the graceful processor spends on its cleanup once asked to stop. */
const CLEANUP_MS = 300;

/** How far past the grace deadline a close may run on a loaded machine. */
const SLACK = 2_000;

/** What the scenario printed once it saw the attempt's child. */
interface ChildLine {
  /** Always `"child"`. */
  event: "child";
  /** The scenario's own pid. */
  self: number;
  /** The child's pid, from its own report. */
  pid: number;
  /** The child's parent, from its own report. */
  ppid: number;
  /** `ps -o ppid=,args=` for the child, while it was alive. */
  ps: string;
}

/** What the scenario printed once `worker.close()` returned. */
interface ClosedLine {
  /** Always `"closed"`. */
  event: "closed";
  /** How long `worker.close()` took. */
  closeMs: number;
  /** The job's state after the close (absent for `exit-at-close`). */
  state?: string;
  /** The job's return value after the close. */
  returnValue: unknown;
}

/** A process as `ps` sees it: gone, a zombie, or alive with its command. */
function inspect(pid: number): { alive: boolean; stat: string; args: string } {
  const { stdout } = Bun.spawnSync([
    "ps",
    "-o",
    "stat=,args=",
    "-p",
    String(pid),
  ]);
  const line = stdout.toString().trim();
  if (line.length === 0) {
    return { alive: false, stat: "", args: "" };
  }
  const [stat = "", ...args] = line.split(/\s+/);
  // A zombie has finished running and only waits to be reaped.
  return { alive: !stat.startsWith("Z"), stat, args: args.join(" ") };
}

/**
 * Whether `args` is a child this worktree's executor spawned: its absolute
 * `spawn-entry.ts`. Other sessions run the same entry from their own trees,
 * and nothing that is not ours is ever killed.
 */
function isOurs(args: string): boolean {
  return args.includes(SpawnExecutor.entry);
}

/**
 * Runs the scenario in `shape` and reports what happened to the child after
 * the scenario ended. Kills the child by its recorded pid afterwards, whatever
 * the assertions said, when it is still alive and still ours.
 */
async function runScenario(
  shape:
    | "timeout"
    | "close-timeout"
    | "graceful"
    | "drain"
    | "exit-at-close"
    | "force"
    | "exit-at-force",
  spinMs: number,
  check: (seen: {
    child: ChildLine;
    closed: ClosedLine | undefined;
    exitCode: number;
    after: { alive: boolean; stat: string; args: string };
    /** Whether the graceful processor finished its cleanup. */
    cleanedUp: boolean;
    /** Whether the child ended itself: its `exit` handler ran. */
    exitedItself: boolean;
  }) => void,
): Promise<void> {
  const tmp = await makeTmpDir("close-orphan");
  const pidFile = join(tmp.path, "child.json");
  const markerFile = join(tmp.path, "cleaned-up");
  const exitFile = join(tmp.path, "exited");
  let childPid: number | undefined;

  try {
    const run = spawnBun(scenario, {
      SHAPE: shape,
      PID_FILE: pidFile,
      SPIN_MS: String(spinMs),
      MARKER_FILE: markerFile,
      EXIT_FILE: exitFile,
      CLEANUP_MS: String(CLEANUP_MS),
    });
    const exitCode = await Promise.race([
      run.exited,
      Bun.sleep(40_000).then(() => {
        run.proc.kill("SIGKILL");
        return -1;
      }),
    ]);

    // Nothing of the scenario's output is read until the child has been
    // looked at and dealt with. The child inherits the scenario's stdout, so
    // that pipe reaches its end only when the *child* exits as well: waiting
    // on it first would wait out an orphan's whole spin, and then find it
    // gone — a detector that measures nothing, and passes on the bug.

    // The child's own report. No report means no child was ever seen, and a
    // test that saw no child has proved nothing: that is a failure.
    const report = await Bun.file(pidFile)
      .text()
      .catch(() => "");
    if (report.length === 0) {
      run.proc.kill("SIGKILL");
      const [stdout, stderr] = await Promise.all([run.output, run.errors]);
      throw new Error(
        `No child was ever seen: ${pidFile} was never written.\nscenario exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    const reported = JSON.parse(report) as { pid: number; ppid: number };
    childPid = reported.pid;

    // The scenario has exited; give a signal sent on its way out, and the
    // reaping of what it killed, a moment to land.
    let after = inspect(childPid);
    const deadline = Date.now() + 3_000;
    while (after.alive && Date.now() < deadline) {
      await Bun.sleep(50);
      after = inspect(childPid);
    }
    // Recorded; now end an orphan, so the pipes it holds close.
    if (after.alive && isOurs(after.args)) {
      process.kill(childPid, "SIGKILL");
    }

    const [stdout, stderr] = await Promise.all([run.output, run.errors]);
    const context = `scenario exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`;

    const lines = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as ChildLine | ClosedLine);
    const child = lines.find(
      (line): line is ChildLine => line.event === "child",
    );
    const closed = lines.find(
      (line): line is ClosedLine => line.event === "closed",
    );
    if (!child) {
      throw new Error(`The scenario never reported the child.\n${context}`);
    }

    // The right process: the one that wrote the report, a child of the
    // scenario, running this worktree's entry point while it was alive.
    expect(child.pid).toBe(reported.pid);
    expect(reported.ppid).toBe(run.proc.pid);
    expect(child.self).toBe(run.proc.pid);
    expect(child.ps).toContain(SpawnExecutor.entry);
    expect(child.ps.split(/\s+/)[0]).toBe(String(run.proc.pid));

    check({
      child,
      closed,
      exitCode,
      after,
      cleanedUp: await Bun.file(markerFile).exists(),
      exitedItself: await Bun.file(exitFile).exists(),
    });
  } finally {
    if (childPid !== undefined) {
      const left = inspect(childPid);
      if (left.alive && isOurs(left.args)) {
        process.kill(childPid, "SIGKILL");
      }
    }
    await tmp.cleanup();
  }
}

/** Fails, naming the process, when the child outlived the scenario. */
function expectGone(
  pid: number,
  after: { alive: boolean; stat: string; args: string },
): void {
  if (after.alive) {
    throw new Error(
      `child ${pid} outlived the process that closed its worker: ${after.stat} ${after.args}`,
    );
  }
}

describe("worker.close() and a child-process attempt (#166)", () => {
  it("gives the grace period the target's close() has to a child that unwinds when asked", async () => {
    await runScenario("graceful", 0, (seen) => {
      expect(seen.exitCode).toBe(0);
      // Its cleanup ran, and it ended itself: a SIGKILL runs no exit handler.
      expect(seen.cleanedUp).toBe(true);
      expect(seen.exitedItself).toBe(true);
      // The 200ms close timeout, then about the cleanup — not the deadline.
      expect(seen.closed!.closeMs).toBeGreaterThanOrEqual(CLEANUP_MS);
      expect(seen.closed!.closeMs).toBeLessThan(TARGET_CLOSE_GRACE / 2);
      expectGone(seen.child.pid, seen.after);
    });
  }, 60_000);

  it("kills an attempt whose kill sequence is still running, at the deadline, when the process ends straight after", async () => {
    await runScenario("timeout", 30_000, (seen) => {
      expect(seen.exitCode).toBe(0);
      expect(seen.closed?.state).toBe("dead");
      // It ignored the request, so it had the whole grace period and no more.
      expect(seen.closed!.closeMs).toBeGreaterThanOrEqual(
        TARGET_CLOSE_GRACE - 50,
      );
      expect(seen.closed!.closeMs).toBeLessThan(TARGET_CLOSE_GRACE + SLACK);
      expect(seen.exitedItself).toBe(false);
      expectGone(seen.child.pid, seen.after);
    });
  }, 60_000);

  it("kills an attempt close({ timeout }) ran out of patience with, at the deadline", async () => {
    await runScenario("close-timeout", 30_000, (seen) => {
      expect(seen.exitCode).toBe(0);
      expect(seen.closed!.closeMs).toBeGreaterThanOrEqual(
        200 + TARGET_CLOSE_GRACE - 50,
      );
      expect(seen.closed!.closeMs).toBeLessThan(
        200 + TARGET_CLOSE_GRACE + SLACK,
      );
      expectGone(seen.child.pid, seen.after);
    });
  }, 60_000);

  it("kills at the deadline with nothing but close() holding the process open", async () => {
    await runScenario("exit-at-close", 30_000, (seen) => {
      expect(seen.exitCode).toBe(0);
      expectGone(seen.child.pid, seen.after);
      // close() resolved — the process lived long enough to say so — and
      // took the grace period, which only a ref'd timer can wait out here.
      expect(seen.closed).toBeDefined();
      expect(seen.closed!.closeMs).toBeGreaterThanOrEqual(
        TARGET_CLOSE_GRACE - 50,
      );
      expect(seen.closed!.closeMs).toBeLessThan(TARGET_CLOSE_GRACE + SLACK);
    });
  }, 60_000);

  it("kills at once, skipping the cleanup, when the close is forced", async () => {
    await runScenario("force", 0, (seen) => {
      expect(seen.exitCode).toBe(0);
      expectGone(seen.child.pid, seen.after);
      // `force` said not to wait: no grace, so no cleanup, and a SIGKILL.
      expect(seen.cleanedUp).toBe(false);
      expect(seen.exitedItself).toBe(false);
      expect(seen.closed!.closeMs).toBeLessThan(1_000);
    });
  }, 60_000);

  it("kills inside a forced close() itself, before anything is awaited", async () => {
    await runScenario("exit-at-force", 30_000, (seen) => {
      expect(seen.exitCode).toBe(0);
      expectGone(seen.child.pid, seen.after);
      // The process exited on the line after close(): nothing else ran.
      expect(seen.closed).toBeUndefined();
    });
  }, 60_000);

  it("still waits for an attempt a plain close() is draining, rather than killing it", async () => {
    await runScenario("drain", 2_500, (seen) => {
      expect(seen.exitCode).toBe(0);
      expect(seen.closed?.state).toBe("completed");
      expect(seen.closed?.returnValue).toBe("survived");
      expectGone(seen.child.pid, seen.after);
    });
  }, 60_000);

  it("kills, and resolves, strictly before the worker's bound on a target's close()", () => {
    // The worker forces nothing when its bound wins, and a close that
    // resolved right at it could race it into a false warning.
    expect(TARGET_CLOSE_GRACE).toBeGreaterThan(0);
    expect(TARGET_CLOSE_REAP).toBeGreaterThan(0);
    expect(TARGET_CLOSE_GRACE + TARGET_CLOSE_REAP).toBeLessThan(
      DEFAULT_CLOSE_TIMEOUT,
    );
  });
});

describe("the built-in target once closed", () => {
  it("refuses to start another attempt", async () => {
    const executor = new FileTargetExecutor(
      { kind: "child-process" },
      join(import.meta.dir, "fixtures", "handlers", "job-spin-report.ts"),
      { namespace: "closed-target", queue: "closed-target", workerId: "w" },
    );
    await executor.close();

    // Refused before it looks at the attempt, so none is needed.
    await expect(
      executor.run({} as unknown as WorkerTargetAttempt),
    ).rejects.toThrow("is closed");
  });
});
