import type { BunRunnerOptions, ExecutionMode, RunRecord } from "../lib/index";
import type { RunnerDriverEvent } from "../lib/shared/events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunRunner, MemoryDriver } from "../lib/index";
import { CLOSE_EXIT_CODE } from "../lib/runner/protocol";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * A run stopped before its handler begins.
 *
 * The parent sends `start` only once the child reports `ready`, so a timeout
 * or a non-forced `kill()`/`stop()` that lands while the child is still
 * booting reaches it *before* `start`. The child used to drop that `close`:
 * the handler then ran anyway, with a signal nothing would abort, until
 * `SIGTERM` (child-process) or `terminate()` (worker-thread) at
 * `closeTimeout`. Measured before the fix: 3,012–3,021 ms for a cooperative
 * handler with a 3,000 ms `closeTimeout`, against 11–33 ms for the same kill
 * a moment later.
 *
 * The same holds one step later, while the handler's module is importing —
 * which took up to 1.7 s under load. A stop then skips the handler too.
 *
 * Every test here holds the child at a point of the test's choosing, so the
 * stop is certain to land where the test says it does; none relies on how
 * fast Bun boots. Each one also runs the same kind of stop *after* the
 * handler began, alongside, and asserts both report exactly the same.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

/** Holds a spawned child before Bun starts, until a file exists. */
const GATED_START = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "gated-start.sh",
);

/** Long enough that settling by the escalation can never pass for a close. */
const CLOSE_TIMEOUT = 10_000;

/** The bound a close that was honoured settles within, from the stop. */
const HONOURED_WITHIN = 5_000;

/**
 * The deadline for the timeout cases: past the child's start-up — so the
 * handler of an unheld run is running by then — and short of the test's.
 */
const DEADLINE = 4_000;

const runners: BunRunner<any, any>[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await Promise.allSettled(
    runners.map((runner) => runner.stop({ force: true })),
  );
  runners.length = 0;
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function makeRunner(
  mode: ExecutionMode,
  options: Partial<BunRunnerOptions<any>> = {},
): BunRunner<any, any> {
  const runner = new BunRunner({
    id: "early",
    namespace: testNamespace(),
    file: fixture("graceful"),
    executionMode: mode,
    driver: new MemoryDriver(),
    waitToExit: false,
    logger: noopLogger,
    publish: true,
    closeTimeout: CLOSE_TIMEOUT,
    killTimeout: CLOSE_TIMEOUT,
    ...options,
  } as BunRunnerOptions<any>);

  runners.push(runner);
  return runner;
}

/** Fresh paths in a temp directory, removed after the test. */
async function paths() {
  const dir = await makeTmpDir("early-close");
  cleanups.push(dir.cleanup);
  return {
    /** Written by the handler once it is running: it was called. */
    ready: join(dir.path, "ready"),
    /** Written by `slow-import.ts` when its import begins. */
    importing: join(dir.path, "importing"),
    /** Opens whichever gate a test holds the child at. */
    gate: join(dir.path, "gate"),
  };
}

/** Waits for a file, failing with `message` if it never appears. */
async function waitForFile(path: string, message: string): Promise<void> {
  await waitFor(() => existsSync(path), { timeout: 15_000, message });
}

/**
 * Everything a run's outcome shows a reader: the record, the emitted events
 * and the published ones. Run ids, timings, stacks and the pid are left out —
 * they differ between any two runs — so two runs stopped the same way compare
 * equal.
 */
interface Observed {
  /** The settled record. */
  record: RunRecord;
  /** `status`, the error's `name` and `message`: what the record says. */
  outcome: { status: string; error?: { name: string; message: string } };
  /** Emitted events, in order, as `name[:detail]`. */
  emitted: string[];
  /** Published events, in order, as `type` and payload without the run id. */
  published: string[];
}

/** The part of a serialized error two equivalent outcomes share. */
function errorShape(error: { name?: string; message?: string } | undefined) {
  return error
    ? { name: String(error.name), message: String(error.message) }
    : undefined;
}

/**
 * Starts watching a runner's one run, resolving once it has settled and its
 * terminal event has been published.
 */
async function observe(
  runner: BunRunner<any, any>,
): Promise<() => Promise<Observed>> {
  const emitted: string[] = [];
  const published: string[] = [];
  const events: RunnerDriverEvent[] = [];

  const unsubscribe = await runner.driver.subscribe(
    runner.namespace,
    "runner",
    runner.id,
    (event) => {
      events.push(event);
    },
  );
  cleanups.push(() => unsubscribe());

  runner.on("killed", (_record, reason) => emitted.push(`killed:${reason}`));
  runner.on("timeout", () => emitted.push("timeout"));
  runner.on("finished", () => emitted.push("finished"));
  const record = new Promise<RunRecord>((resolve) => {
    runner.on("failed", (settled, error) => {
      emitted.push(`failed:${error.name}:${error.message}`);
      resolve(settled);
    });
    runner.once("finished", resolve);
  });

  return async () => {
    const settled = await record;
    const terminal = ["succeeded", "killed", "timeout"];
    await waitFor(() => events.some((event) => terminal.includes(event.type)), {
      message: "the run's outcome was never published",
    });

    for (const event of events) {
      if (event.type === "started" || event.type === "logs") {
        continue;
      }
      const {
        runId: _runId,
        error,
        ...rest
      } = event.payload as {
        runId?: string;
        error?: { name?: string; message?: string };
      };
      published.push(
        `${event.type}:${JSON.stringify({ ...rest, ...(error ? { error: errorShape(error) } : {}) })}`,
      );
    }

    return {
      record: settled,
      outcome: {
        status: settled.status,
        ...(settled.error ? { error: errorShape(settled.error) } : {}),
      },
      emitted,
      published,
    };
  };
}

/** What a reader can compare between two runs. */
function comparable(observed: Observed) {
  const { record: _record, ...rest } = observed;
  return rest;
}

/**
 * The same kind of stop, made once the handler is running: the reference a
 * run stopped early must match.
 */
async function afterStart(
  mode: ExecutionMode,
  stop: { kill: string } | { timeout: number },
): Promise<Observed> {
  const { ready } = await paths();
  const runner = makeRunner(mode, {
    ...("timeout" in stop ? { timeout: stop.timeout } : {}),
    args: { ms: 60_000, ready },
  });
  await runner.start();
  const done = await observe(runner);

  const outcome = await runner.trigger();
  const runId = outcome.outcome === "started" ? outcome.runId : undefined;
  expect(runId).toBeDefined();

  if ("kill" in stop) {
    await waitForFile(ready, "the reference handler never started");
    await runner.kill(runId, { reason: stop.kill });
  }

  const observed = await done();
  // The premise: the handler was running when the stop came.
  expect(existsSync(ready)).toBe(true);
  return observed;
}

describe("a close that reaches the child before `start`", () => {
  for (const mode of ["child-process", "worker-thread"] as const) {
    it(`never calls the handler, and reports the kill as a kill after start does: ${mode}`, async () => {
      const { ready } = await paths();
      const runner = makeRunner(mode, { args: { ms: 60_000, ready } });
      await runner.start();
      const done = await observe(runner);

      // `started` is emitted synchronously in the same turn that spawns the
      // child or creates the worker, and `kill()` sends its `close`
      // synchronously too. The parent sends `start` only from its `ready`
      // handler, which cannot run before this turn ends — so the close is
      // certain to be ahead of the start. It is also exactly what an
      // example's `notifier.ts` does: kill on `started`.
      let killing: Promise<void> | undefined;
      let stoppedAt = 0;
      runner.once("started", (record) => {
        stoppedAt = Date.now();
        killing = runner.kill(record.runId, { reason: "enough" });
      });

      const [early, reference] = await Promise.all([
        (async () => {
          await runner.trigger();
          const observed = await done();
          await killing;
          return observed;
        })(),
        afterStart(mode, { kill: "enough" }),
      ]);

      expect(early.record.status).toBe("killed");
      expect(early.record.signal ?? null).toBeNull();
      expect(Date.now() - stoppedAt).toBeLessThan(HONOURED_WITHIN);
      expect(existsSync(ready)).toBe(false);
      if (mode === "child-process") {
        expect(early.record.exitCode).toBe(CLOSE_EXIT_CODE);
      }

      expect(early.outcome).toEqual({
        status: "killed",
        error: { name: "RunKilledError", message: "Run was killed: enough" },
      });
      expect(early.emitted).toEqual([
        "killed:enough",
        "failed:RunKilledError:Run was killed: enough",
      ]);
      expect(comparable(early)).toEqual(comparable(reference));
    }, 30_000);

    it(`still kills at once when the kill is forced: ${mode}`, async () => {
      const { ready } = await paths();
      const runner = makeRunner(mode, { args: { ms: 60_000, ready } });
      await runner.start();
      const done = await observe(runner);

      let killing: Promise<void> | undefined;
      let stoppedAt = 0;
      runner.once("started", (record) => {
        stoppedAt = Date.now();
        killing = runner.kill(record.runId, { force: true, reason: "now" });
      });

      await runner.trigger();
      const observed = await done();
      await killing;

      // The forced path is untouched: `SIGKILL` for a child, `terminate()`
      // for a worker, straight away and not after any grace.
      expect(Date.now() - stoppedAt).toBeLessThan(2_000);
      expect(observed.outcome).toEqual({
        status: "killed",
        error: { name: "RunKilledError", message: "Run was killed: now" },
      });
      expect(observed.emitted[0]).toBe("killed:now");
      if (mode === "child-process") {
        expect(observed.record.signal).toBe("SIGKILL");
      }
    }, 30_000);
  }

  it("never boots the handler of a run killed before Bun started: child-process", async () => {
    const { ready, gate } = await paths();
    const runner = makeRunner("child-process", {
      args: { ms: 60_000, ready },
      spawn: {
        execPath: GATED_START,
        env: { RUNNER_TEST_GATE: gate, RUNNER_TEST_BUN: process.execPath },
      },
    });
    await runner.start();
    const done = await observe(runner);

    const outcome = await runner.trigger();
    const stoppedAt = Date.now();
    // The child is held before Bun even starts, so this close is certain to
    // be sent ahead of the `start` its `ready` will prompt. `kill()` resolves
    // once the run has ended, so the gate opens meanwhile.
    const killing = runner.kill(
      outcome.outcome === "started" ? outcome.runId : undefined,
      { reason: "early" },
    );
    await Bun.write(gate, "");
    await killing;

    const observed = await done();
    expect(observed.outcome).toEqual({
      status: "killed",
      error: { name: "RunKilledError", message: "Run was killed: early" },
    });
    // Not SIGTERM after the whole close window: the close was honoured.
    expect(observed.record.signal).toBeNull();
    expect(Date.now() - stoppedAt).toBeLessThan(HONOURED_WITHIN);
    // And the handler never ran at all.
    expect(existsSync(ready)).toBe(false);
  }, 30_000);

  it("stays a timeout, and never boots the handler, when the deadline passes first: child-process", async () => {
    const { ready, gate } = await paths();
    const runner = makeRunner("child-process", {
      timeout: DEADLINE,
      args: { ms: 60_000, ready },
      spawn: {
        execPath: GATED_START,
        env: { RUNNER_TEST_GATE: gate, RUNNER_TEST_BUN: process.execPath },
      },
    });
    await runner.start();
    const done = await observe(runner);

    const [early, reference] = await Promise.all([
      (async () => {
        await runner.trigger();
        // Armed after the run's deadline, and due later: when this resolves
        // the timeout has fired, and its close was sent to a child that has
        // not started Bun yet.
        await Bun.sleep(DEADLINE + 300);
        const openedAt = Date.now();
        await Bun.write(gate, "");
        const observed = await done();
        return { observed, sinceGate: Date.now() - openedAt };
      })(),
      afterStart("child-process", { timeout: DEADLINE }),
    ]);

    expect(early.observed.outcome).toEqual({
      status: "timeout",
      error: {
        name: "JobTimeoutError",
        message: `Timed out after ${DEADLINE}ms`,
      },
    });
    expect(early.observed.record.signal).toBeNull();
    expect(early.sinceGate).toBeLessThan(HONOURED_WITHIN);
    expect(existsSync(ready)).toBe(false);
    expect(comparable(early.observed)).toEqual(comparable(reference));
  }, 30_000);
});

describe("a close that lands while the handler's module is importing", () => {
  /**
   * Runs `slow-import.ts`, held mid-import. A child or worker is released by
   * the `close` itself reaching it, so the close is certain to land first; an
   * in-process run — whose `kill()` aborts synchronously — by the gate file,
   * and reads the variables from this process's environment.
   */
  async function heldMidImport(
    mode: ExecutionMode,
    options: Partial<BunRunnerOptions<any>> = {},
  ) {
    const files = await paths();
    const env: Record<string, string> =
      mode === "in-process"
        ? {
            RUNNER_TEST_IMPORTING: files.importing,
            RUNNER_TEST_GATE: files.gate,
          }
        : {
            RUNNER_TEST_IMPORTING: files.importing,
            RUNNER_TEST_UNTIL_CLOSE: "1",
          };
    if (mode === "in-process") {
      Object.assign(process.env, env);
      cleanups.push(() => {
        delete process.env.RUNNER_TEST_IMPORTING;
        delete process.env.RUNNER_TEST_GATE;
      });
    }

    const runner = makeRunner(mode, {
      file: fixture("slow-import"),
      args: { ms: 60_000, ready: files.ready },
      ...(mode === "child-process" ? { spawn: { env } } : {}),
      ...(mode === "worker-thread" ? { worker: { env } } : {}),
      // A fresh module per run, so the import (and its gate) happens even
      // when another file in this process has imported it already.
      ...(mode === "in-process" ? { reloadOnEachRun: true } : {}),
      ...options,
    });
    await runner.start();
    const done = await observe(runner);
    return { runner, done, ...files };
  }

  for (const mode of [
    "child-process",
    "worker-thread",
    "in-process",
  ] as const) {
    it(`skips the handler, and reports the kill as a kill after start does: ${mode}`, async () => {
      const [early, reference] = await Promise.all([
        (async () => {
          const held = await heldMidImport(mode);
          const outcome = await held.runner.trigger();
          await waitForFile(held.importing, "the handler's import never began");

          const stoppedAt = Date.now();
          const killing = held.runner.kill(
            outcome.outcome === "started" ? outcome.runId : undefined,
            { reason: "enough" },
          );
          await Bun.write(held.gate, "");
          await killing;
          const observed = await held.done();
          return {
            observed,
            elapsed: Date.now() - stoppedAt,
            ready: held.ready,
          };
        })(),
        afterStart(mode, { kill: "enough" }),
      ]);

      // The module was evaluated — its top-level code ran — but the handler
      // it exports was never called.
      expect(existsSync(early.ready)).toBe(false);
      expect(early.observed.record.signal ?? null).toBeNull();
      expect(early.elapsed).toBeLessThan(HONOURED_WITHIN);
      expect(early.observed.outcome).toEqual({
        status: "killed",
        error: { name: "RunKilledError", message: "Run was killed: enough" },
      });
      expect(comparable(early.observed)).toEqual(comparable(reference));
    }, 30_000);
  }

  for (const mode of ["child-process", "worker-thread"] as const) {
    it(`stays a timeout, and skips the handler: ${mode}`, async () => {
      const [early, reference] = await Promise.all([
        (async () => {
          const held = await heldMidImport(mode, { timeout: DEADLINE });
          const triggeredAt = Date.now();
          await held.runner.trigger();
          // Had the deadline passed before `start`, the module would never be
          // imported at all; its import beginning means the close is still
          // to come, and only that close lets the import finish.
          await waitForFile(held.importing, "the handler's import never began");
          const observed = await held.done();
          return {
            observed,
            pastDeadline: Date.now() - triggeredAt - DEADLINE,
            ready: held.ready,
          };
        })(),
        afterStart(mode, { timeout: DEADLINE }),
      ]);

      expect(existsSync(early.ready)).toBe(false);
      expect(early.observed.record.signal ?? null).toBeNull();
      // Not `terminate()`/SIGTERM at the end of the close window.
      expect(early.pastDeadline).toBeLessThan(HONOURED_WITHIN);
      expect(early.observed.outcome).toEqual({
        status: "timeout",
        error: {
          name: "JobTimeoutError",
          message: `Timed out after ${DEADLINE}ms`,
        },
      });
      expect(comparable(early.observed)).toEqual(comparable(reference));
    }, 30_000);
  }
});
