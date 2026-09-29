import type { LogEvent } from "@kingsleyweb/bun-common";
import type { BunRunnerOptions, RunRecord } from "../lib/index";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunRunner, MemoryDriver } from "../lib/index";
import { RUN_THREAD_REAP } from "../lib/runner/BunRunner";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
import { FakeWorker, installFakeWorker } from "./helpers/fakeWorker";

/**
 * A `worker-thread` run that `BunRunner` ends — `stop()`, `stop({ force })`,
 * `kill()`, a timeout — counts as ended once its thread has actually stopped,
 * not once `terminate()` has been called. `terminate()` returns at once and a
 * busy Bun `Worker` goes on running for tens of milliseconds after it, up to
 * a couple of seconds on a loaded machine (oven-sh/bun#44216), so a runner
 * that went by `done` resolved `stop()`, and wrote the run's final record,
 * with the thread still going.
 *
 * The real-thread tests place the thread's last side effect in time with the
 * stamp `spin-stamp.ts` writes on every turn; the stand-in `Worker` ones
 * decide exactly when the "thread" stops, which a real one never lets a test
 * do.
 */

const handlers = join(import.meta.dir, "fixtures", "handlers");
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** One clock across threads, in milliseconds (see `spin-stamp.ts`). */
function now(): number {
  return performance.timeOrigin + performance.now();
}

/** Resolves with whether `promise` settled within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true),
    Bun.sleep(ms).then(() => false),
  ]);
}

/**
 * A memory driver that stamps every write of a run's final state: the history
 * row leaving `running`, and the runner's `lastStatus` doing the same.
 */
class StampingDriver extends MemoryDriver {
  /** Each final-state write, in order, with when it was made. */
  readonly finals: { what: string; status: string; at: number }[] = [];

  override async updateHistory(
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    if (patch.status !== undefined && patch.status !== "running") {
      this.finals.push({ what: "history", status: patch.status, at: now() });
    }
    return await super.updateHistory(ns, key, runId, patch);
  }

  override async setState(
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ): Promise<void> {
    const status = fields.lastStatus;
    if (typeof status === "string" && status !== "running") {
      this.finals.push({ what: "state", status, at: now() });
    }
    await super.setState(ns, key, fields);
  }
}

/** A worker-thread runner over a stamping driver, stopped by force after. */
function makeRunner(options: Partial<BunRunnerOptions<any>> = {}): {
  runner: BunRunner<any, any>;
  driver: StampingDriver;
} {
  const driver = new StampingDriver();
  const runner = new BunRunner({
    id: "thread-stop",
    namespace: testNamespace(),
    file: join(handlers, "spin-stamp.ts"),
    executionMode: "worker-thread",
    driver,
    waitToExit: false,
    logger: noopLogger,
    captureLogs: false,
    ...options,
  } as BunRunnerOptions<any>);
  cleanups.push(async () => {
    await runner.stop({ force: true });
  });
  return { runner, driver };
}

/** The spinning handler's arguments, and where its stamp lands. */
async function spinning(): Promise<{
  beacon: string;
  args: { beaconFile: string; spinMs: number };
}> {
  const tmp = await makeTmpDir("runner-thread-stop");
  cleanups.push(tmp.cleanup);
  const beacon = join(tmp.path, "beacon");
  return { beacon, args: { beaconFile: beacon, spinMs: 30_000 } };
}

/**
 * Reads `file` every 15 ms until it has not changed for 300 ms, for 5 s at
 * most: the value a thread left once it stopped writing, and whether it did.
 */
async function lastWrite(
  file: string,
): Promise<{ value: string; settled: boolean }> {
  const deadline = Date.now() + 5_000;
  let value = await Bun.file(file).text();
  let since = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(15);
    const next = await Bun.file(file).text();
    if (next !== value) {
      value = next;
      since = Date.now();
    } else if (Date.now() - since >= 300) {
      return { value, settled: true };
    }
  }
  return { value, settled: false };
}

/** Records when the runner emitted each of `names`. */
function stampEvents(
  runner: BunRunner<any, any>,
  names: ("killed" | "timeout" | "failed" | "finished" | "stopped")[],
): { name: string; at: number }[] {
  const seen: { name: string; at: number }[] = [];
  for (const name of names) {
    runner.on(name, () => {
      seen.push({ name, at: now() });
    });
  }
  return seen;
}

/** The run's thread-overrun warnings in `events`. */
function overrunWarnings(events: LogEvent[]): LogEvent[] {
  return events.filter(
    (event) => event.level === "warn" && event.message.includes("44216"),
  );
}

/**
 * The claim, for a runner call that resolved at `endedAt`: the run's thread
 * had stopped by then — its last stamp came first — and so had it before
 * each of `marks` (the final-state writes, the events), unless it outlived
 * `RUN_THREAD_REAP`, which Bun's termination latency can on a loaded machine
 * (oven-sh/bun#44216); then the runner said so in exactly one warning naming
 * the run, and the marks exist.
 */
async function expectStoppedBy(
  endedAt: number,
  spin: { beacon: string; events: LogEvent[]; runId: string },
  marks: { label: string; at: number }[],
): Promise<void> {
  const last = await lastWrite(spin.beacon);
  // Not left running, whatever else: the handler spins for 30 s.
  expect(last.settled).toBe(true);
  expect(marks.length).toBeGreaterThan(0);
  const warned = overrunWarnings(spin.events);
  if (warned.length > 0) {
    expect(warned).toHaveLength(1);
    expect(warned[0]!.fields.runId).toBe(spin.runId);
    return;
  }
  const lastStamp = Number(last.value);
  // A real stamp, so the comparisons below cannot pass on an empty file.
  expect(lastStamp).toBeGreaterThan(0);
  // The thread's last side effect came before the call resolved...
  expect(lastStamp).toBeLessThanOrEqual(endedAt);
  // ...and before anything said the run was over.
  for (const mark of marks) {
    expect({ label: mark.label, after: mark.at >= lastStamp }).toEqual({
      label: mark.label,
      after: true,
    });
  }
}

/** A started run's id, or a thrown error naming what happened instead. */
function startedId(outcome: Awaited<ReturnType<BunRunner["trigger"]>>): string {
  if (outcome.outcome !== "started") {
    throw new Error(`expected a run, got ${outcome.outcome}`);
  }
  return outcome.runId;
}

describe("BunRunner worker-thread: ending a run waits for its thread", () => {
  it("stop({ force }) resolves, and the run is recorded killed, only after the thread's last stamp", async () => {
    const { beacon, args } = await spinning();
    const { logger, events } = createTestLogger();
    const { runner, driver } = makeRunner({ args, logger });
    const seen = stampEvents(runner, ["killed", "failed", "stopped"]);
    await runner.start();
    const runId = startedId(await runner.trigger());
    await waitFor(async () => await Bun.file(beacon).exists(), {
      timeout: 10_000,
    });

    await runner.stop({ force: true });
    const stoppedAt = now();

    expect(driver.finals.map((f) => `${f.what}:${f.status}`)).toEqual([
      "history:killed",
      "state:killed",
    ]);
    expect(seen.map((s) => s.name)).toEqual(["killed", "failed", "stopped"]);
    await expectStoppedBy(stoppedAt, { beacon, events, runId }, [
      ...driver.finals.map((f) => ({ label: f.what, at: f.at })),
      ...seen.map((s) => ({ label: s.name, at: s.at })),
    ]);
  }, 30_000);

  it("kill(runId) resolves, with the run still active until then, only after the thread's last stamp", async () => {
    const { beacon, args } = await spinning();
    const { logger, events } = createTestLogger();
    const { runner, driver } = makeRunner({ args, logger });
    const seen = stampEvents(runner, ["killed"]);
    await runner.start();
    const runId = startedId(await runner.trigger());
    await waitFor(async () => await Bun.file(beacon).exists(), {
      timeout: 10_000,
    });

    await runner.kill(runId, { force: true });
    const killedAt = now();
    expect(runner.activeRuns.has(runId)).toBe(false);

    expect(driver.finals[0]?.status).toBe("killed");
    await expectStoppedBy(killedAt, { beacon, events, runId }, [
      ...driver.finals.map((f) => ({ label: f.what, at: f.at })),
      ...seen.map((s) => ({ label: s.name, at: s.at })),
    ]);
  }, 30_000);

  it("a timeout — and a stop() waiting on it — ends the run only after the thread's last stamp", async () => {
    const { beacon, args } = await spinning();
    const { logger, events } = createTestLogger();
    const { runner, driver } = makeRunner({
      args,
      logger,
      // Long enough for the thread to boot and start stamping first.
      timeout: 4_000,
      closeTimeout: 100,
    });
    const seen = stampEvents(runner, ["timeout"]);
    await runner.start();
    const runId = startedId(await runner.trigger());
    const triggeredAt = Date.now();
    await waitFor(async () => await Bun.file(beacon).exists(), {
      timeout: 10_000,
    });
    // The run must still be going, or this is not the timeout path.
    expect(Date.now() - triggeredAt).toBeLessThan(4_000);

    // Graceful, and long enough that the run's own timeout ends it first.
    await runner.stop({ timeout: 10_000 });
    const stoppedAt = now();

    expect(driver.finals[0]?.status).toBe("timeout");
    expect(seen).toHaveLength(1);
    await expectStoppedBy(stoppedAt, { beacon, events, runId }, [
      ...driver.finals.map((f) => ({ label: f.what, at: f.at })),
      ...seen.map((s) => ({ label: s.name, at: s.at })),
    ]);
  }, 30_000);
});

describe("BunRunner worker-thread: the wait is capped (stand-in Worker)", () => {
  it("a thread that never closes: stop() resolves at the cap with one warn, and the run is not recorded killed before it", async () => {
    cleanups.push(installFakeWorker(false));
    const { logger, events } = createTestLogger();
    const { runner, driver } = makeRunner({
      logger,
      file: join(handlers, "echo.ts"),
    });
    await runner.start();
    const outcome = await runner.trigger();
    if (outcome.outcome !== "started") {
      throw new Error(`expected a run, got ${outcome.outcome}`);
    }
    const fake = FakeWorker.instances[0]!;
    await waitFor(() => fake.received.some((message) => message.t === "start"));

    const startedAt = Date.now();
    const stopping = runner.stop({ force: true });

    // Terminated, and still running: nothing says the run is over.
    expect(await within(stopping, RUN_THREAD_REAP / 2)).toBe(false);
    expect(fake.terminations).toBe(1);
    expect(driver.finals).toEqual([]);
    expect(runner.activeRuns.has(outcome.runId)).toBe(true);
    const [row] = await runner.history(1);
    expect(row?.status).toBe("running");

    await stopping;
    const took = Date.now() - startedAt;
    expect(took).toBeGreaterThanOrEqual(RUN_THREAD_REAP - 20);
    expect(took).toBeLessThan(RUN_THREAD_REAP + 1_500);
    expect(driver.finals.map((f) => f.status)).toEqual(["killed", "killed"]);

    const warnings = overrunWarnings(events);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fields.runId).toBe(outcome.runId);
    expect(warnings[0]!.fields).toMatchObject({
      runId: outcome.runId,
      reapMs: RUN_THREAD_REAP,
    });

    // A second stop, and the thread closing at last, add nothing.
    await runner.stop({ force: true });
    fake.exit();
    await Bun.sleep(20);
    expect(overrunWarnings(events)).toHaveLength(1);
  });

  it("a thread that closes inside the cap: stop() resolves on its close, with no warn", async () => {
    cleanups.push(installFakeWorker(80));
    const { logger, events } = createTestLogger();
    const { runner, driver } = makeRunner({
      logger,
      file: join(handlers, "echo.ts"),
    });
    await runner.start();
    await runner.trigger();
    const fake = FakeWorker.instances[0]!;
    await waitFor(() => fake.received.some((message) => message.t === "start"));

    let closedAt = 0;
    fake.addEventListener("close", () => {
      closedAt = now();
    });
    await runner.stop({ force: true });
    const stoppedAt = now();

    expect(fake.closed).toBe(true);
    expect(stoppedAt).toBeGreaterThanOrEqual(closedAt);
    expect(driver.finals[0]!.at).toBeGreaterThanOrEqual(closedAt);
    expect(stoppedAt - closedAt).toBeLessThan(RUN_THREAD_REAP);
    expect(overrunWarnings(events)).toEqual([]);
  });

  it("kill(runId) — the management API's kill — resolves on the thread's close, not on terminate()", async () => {
    cleanups.push(installFakeWorker(80));
    const { logger, events } = createTestLogger();
    const { runner, driver } = makeRunner({
      logger,
      file: join(handlers, "echo.ts"),
    });
    const seen = stampEvents(runner, ["killed"]);
    await runner.start();
    const outcome = await runner.trigger();
    if (outcome.outcome !== "started") {
      throw new Error(`expected a run, got ${outcome.outcome}`);
    }
    const fake = FakeWorker.instances[0]!;
    await waitFor(() => fake.received.some((message) => message.t === "start"));

    let closedAt = 0;
    fake.addEventListener("close", () => {
      closedAt = now();
    });
    const killing = runner.kill(outcome.runId, { force: true });
    expect(await within(killing, 40)).toBe(false);
    expect(fake.terminations).toBe(1);
    expect(runner.activeRuns.has(outcome.runId)).toBe(true);
    expect(driver.finals).toEqual([]);

    await killing;
    expect(fake.closed).toBe(true);
    expect(driver.finals[0]!.at).toBeGreaterThanOrEqual(closedAt);
    expect(seen[0]!.at).toBeGreaterThanOrEqual(closedAt);
    expect(overrunWarnings(events)).toEqual([]);
  });

  it("does not hold back a run's own result: success is recorded without waiting for the close", async () => {
    cleanups.push(installFakeWorker(false));
    const { logger, events } = createTestLogger();
    const { runner, driver } = makeRunner({
      logger,
      file: join(handlers, "echo.ts"),
    });
    const seen = stampEvents(runner, ["finished"]);
    await runner.start();
    const outcome = await runner.trigger();
    if (outcome.outcome !== "started") {
      throw new Error(`expected a run, got ${outcome.outcome}`);
    }
    const fake = FakeWorker.instances[0]!;
    await waitFor(() => fake.received.some((message) => message.t === "start"));

    const reportedAt = now();
    fake.emit({ t: "done", runId: outcome.runId, result: "ok" });
    await waitFor(() => seen.length === 1, { timeout: 1_000 });
    expect(fake.closed).toBe(false);
    expect(seen[0]!.at - reportedAt).toBeLessThan(RUN_THREAD_REAP / 2);
    expect(driver.finals[0]?.status).toBe("success");

    // stop() still waits for the thread, capped, and says so once.
    const startedAt = Date.now();
    await runner.stop();
    expect(Date.now() - startedAt).toBeLessThan(RUN_THREAD_REAP + 1_500);
    expect(overrunWarnings(events)).toHaveLength(1);
  });
});
