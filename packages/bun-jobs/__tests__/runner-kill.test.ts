import type { BunRunnerOptions, ExecutionMode, RunRecord } from "../lib/index";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunRunner, MemoryDriver, RunKilledError } from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * Stopping a run that does not want to stop.
 *
 * The escalation is close → `SIGTERM` → `SIGKILL`, each step armed only if
 * the previous one did not end the process. The implementation this replaces
 * called `kill(0)` — signal zero only *checks* that a process exists — so a
 * wedged job was never killed at all. These tests assert the process really
 * is gone, not merely that a method was called.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const started: BunRunner<any, any>[] = [];

/** Temp directories to remove after each test, however it ended. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function makeRunner(
  mode: ExecutionMode,
  options: Partial<BunRunnerOptions<any>> = {},
): BunRunner<any, any> {
  const defaults = {
    id: "killable",
    namespace: testNamespace(),
    file: fixture("stubborn"),
    executionMode: mode,
    driver: new MemoryDriver(),
    waitToExit: false,
    logger: noopLogger,
  };

  const runner = new BunRunner({
    ...defaults,
    ...options,
  } as BunRunnerOptions<any>);

  started.push(runner);
  return runner;
}

/** Resolves when a run settles, however it settles. */
function settled(runner: BunRunner<any, any>): Promise<RunRecord> {
  return new Promise((resolve) => {
    runner.once("finished", resolve);
    runner.once("failed", resolve);
  });
}

/**
 * A path the handler writes once it is running, and a wait for it.
 *
 * A run's `timeout` counts from the spawn, and a child's start-up — Bun,
 * then the handler module's imports — measured 170ms to 1.7s under load. So
 * no fixed delay says the handler is running; the handler saying so does.
 */
async function readiness() {
  const dir = await makeTmpDir("runner-kill");
  cleanups.push(dir.cleanup);
  const path = join(dir.path, "ready");
  return {
    /** The file the handler writes; pass it as the run's `ready` argument. */
    path,
    /** Resolves once the handler has written it. */
    wait: () =>
      waitFor(() => existsSync(path), {
        timeout: 15_000,
        message: "the handler never reported it was running",
      }),
  };
}

/** Whether a process id is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("kill escalation: spawn", () => {
  it("SIGKILLs a child that catches SIGTERM and blocks its loop", async () => {
    const ready = await readiness();
    const runner = makeRunner("child-process", {
      closeTimeout: 150,
      killTimeout: 150,
      args: { ms: 10_000, ready: ready.path },
    });
    await runner.start();

    const outcome = await runner.trigger();
    const record = settled(runner);
    expect(outcome.outcome).toBe("started");

    // The SIGTERM handler is installed and the loop is blocked: now neither
    // the close nor SIGTERM can end it.
    await ready.wait();
    await runner.kill(
      outcome.outcome === "started" ? outcome.runId : undefined,
      { reason: "test" },
    );

    const finished = await record;
    expect(finished.status).toBe("killed");
    expect(finished.signal).toBe("SIGKILL");

    const pid = finished.pid;
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => !isAlive(pid!), {
      message: "the child survived the escalation",
    });
  }, 20_000);

  it("stays a timeout when a signal is what ends it", async () => {
    const ready = await readiness();
    const runner = makeRunner("child-process", {
      // Past the child's start-up (1.7s at worst, measured under load), so the
      // handler is running and blocked when the deadline comes: a deadline
      // that beat `start` would end the run with no signal at all.
      timeout: 3_000,
      closeTimeout: 150,
      killTimeout: 150,
      args: { ms: 20_000, ready: ready.path },
    });
    await runner.start();

    await runner.trigger();
    const record = await settled(runner);

    // The premise: the handler was running, SIGTERM handler installed.
    expect(existsSync(ready.path)).toBe(true);
    // The deadline is what it missed, so the outcome stays a timeout even
    // though a signal is what ended it.
    expect(record.status).toBe("timeout");
    expect(record.signal).toBe("SIGKILL");
    const pid = record.pid;
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => !isAlive(pid!), {
      message: "the child survived the escalation",
    });
  }, 20_000);

  it("lets a well-behaved child unwind before any signal", async () => {
    const runner = makeRunner("child-process", {
      file: fixture("graceful"),
      timeout: 100,
      closeTimeout: 10_000,
      killTimeout: 10_000,
      args: { ms: 30_000 },
    });
    await runner.start();

    const started = Date.now();
    await runner.trigger();
    const record = await settled(runner);

    expect(record.status).toBe("timeout");
    // It exited itself — the handler unwound, or was never called because the
    // deadline beat its `start` or its import — so no signal, and well before
    // SIGTERM was due. Which of those depends on the machine's load, so the
    // bound is the close window itself, not a guess at the start-up time.
    expect(record.signal).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("kills immediately when forced", async () => {
    const runner = makeRunner("child-process", {
      closeTimeout: 10_000,
      killTimeout: 10_000,
      args: { ms: 10_000 },
    });
    await runner.start();

    const outcome = await runner.trigger();
    const record = settled(runner);

    const startedAt = Date.now();
    await runner.kill(
      outcome.outcome === "started" ? outcome.runId : undefined,
      { force: true, reason: "test" },
    );

    const finished = await record;
    // Forced means now, not after the two grace periods.
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(finished.signal).toBe("SIGKILL");
    expect(finished.status).toBe("killed");
  }, 20_000);

  it("fails a child that never reports readiness", async () => {
    const runner = makeRunner("child-process", {
      file: fixture("echo"),
      spawn: {
        startTimeout: 50,
        // A process that starts and then stays silent. Standing our own
        // bootstrap up against a small timeout would only be measuring how
        // fast it imports, which is not what this asserts.
        execPath: join(
          import.meta.dir,
          "fixtures",
          "processes",
          "never-ready.sh",
        ),
      },
    });
    await runner.start();

    await runner.trigger();
    const record = await settled(runner);

    expect(record.status).toBe("failed");
    expect(record.error?.name).toBe("ChildExitError");
  }, 20_000);

  it("stops every run when the runner stops", async () => {
    const runner = makeRunner("child-process", {
      file: fixture("graceful"),
      closeTimeout: 300,
      args: { ms: 10_000 },
    });
    await runner.start();

    const outcome = await runner.trigger();
    const pid = [...runner.activeRuns.values()][0]?.record.pid;

    await runner.stop({ timeout: 100 });

    expect(outcome.outcome).toBe("started");
    expect(runner.activeRuns.size).toBe(0);
    if (pid) {
      await waitFor(() => !isAlive(pid), {
        message: "a child outlived the runner",
      });
    }
  }, 20_000);
});

describe("kill escalation: worker", () => {
  it("terminates a worker that will not stop", async () => {
    const runner = makeRunner("worker-thread", {
      timeout: 100,
      closeTimeout: 150,
      args: { ms: 10_000 },
    });
    await runner.start();

    await runner.trigger();
    const record = await settled(runner);

    expect(record.status).toBe("timeout");
    expect(runner.activeRuns.size).toBe(0);
  }, 20_000);

  it("kills a worker immediately when forced", async () => {
    const runner = makeRunner("worker-thread", {
      closeTimeout: 10_000,
      args: { ms: 10_000 },
    });
    await runner.start();

    const outcome = await runner.trigger();
    const record = settled(runner);

    const startedAt = Date.now();
    await runner.kill(
      outcome.outcome === "started" ? outcome.runId : undefined,
      { force: true },
    );

    expect((await record).status).toBe("killed");
    expect(Date.now() - startedAt).toBeLessThan(2000);
  }, 20_000);
});

describe("kill escalation: in-process", () => {
  it("cannot kill a blocked handler, and says so", async () => {
    const runner = makeRunner("in-process", {
      file: fixture("hang"),
      timeout: 20,
      closeTimeout: 30,
      args: { ms: 300 },
    });
    await runner.start();

    await runner.trigger();
    const record = await settled(runner);

    expect(record.status).toBe("timeout");
    // The honest answer: the work is still going somewhere in this process.
    expect(record.detached).toBe(true);
  }, 20_000);
});

describe("the reason a run was killed", () => {
  /** Kills a cooperative run and reports what the runner said about it. */
  async function killGracefully(
    mode: ExecutionMode,
    reason: string | undefined,
  ) {
    const ready = await readiness();
    const runner = makeRunner(mode, {
      file: fixture("graceful"),
      closeTimeout: 2_000,
      killTimeout: 2_000,
      args: { ms: 10_000, ready: ready.path },
    });
    await runner.start();

    const killed = new Promise<string>((resolve) => {
      runner.once("killed", (_run, why) => resolve(why));
    });
    const failed = new Promise<{ record: RunRecord; error: Error }>(
      (resolve) => {
        runner.once("failed", (record, error) => resolve({ record, error }));
      },
    );

    const outcome = await runner.trigger();
    const runId = outcome.outcome === "started" ? outcome.runId : undefined;
    expect(runId).toBeDefined();
    // The handler is running and watching its signal: the kill is one after
    // start, whatever the machine's load. (A fixed 300ms sleep was shorter
    // than the handler's import under load.)
    await ready.wait();

    await runner.kill(runId, reason === undefined ? undefined : { reason });

    return { why: await killed, ...(await failed) };
  }

  for (const mode of [
    "child-process",
    "worker-thread",
    "in-process",
  ] as const) {
    it(`carries the caller's reason, and says it was a kill: ${mode}`, async () => {
      const { why, record, error } = await killGracefully(
        mode,
        "operator cancelled",
      );

      expect(why).toBe("operator cancelled");
      expect(record.status).toBe("killed");
      // Not "Child exited (code null, signal null) before reporting a result":
      // the handler saw its signal and unwound, which is not a crash.
      expect(record.error?.name).toBe("RunKilledError");
      expect(error.message).toBe("Run was killed: operator cancelled");
    }, 20_000);
  }

  it('says "killed" when no reason was given', async () => {
    const { why, record } = await killGracefully("child-process", undefined);
    expect(why).toBe("killed");
    expect(record.error?.message).toBe("Run was killed: killed");
  }, 20_000);

  it("is an error with a stable code and the reason on it", () => {
    const error = new RunKilledError("operator cancelled", { runId: "r1" });
    expect(error.code).toBe("RUN_KILLED");
    expect(error.reason).toBe("operator cancelled");
    expect(error.message).toBe("Run was killed: operator cancelled");
  });
});
