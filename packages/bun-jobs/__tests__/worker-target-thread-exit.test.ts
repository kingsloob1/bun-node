import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  Job,
  ProcessorContext,
  WorkerTargetAttempt,
  WorkerTargetFactory,
} from "../lib/index";
import type { LocalWorkerTarget } from "../lib/queue/workerTarget";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, createDriver } from "../lib/index";
import {
  FileTargetExecutor,
  TARGET_CLOSE_GRACE,
  TARGET_CLOSE_REAP,
} from "../lib/queue/workerTarget";
import { makeJob, makeTmpDir, testNamespace, waitFor } from "./helpers";
import { FakeWorker, installFakeWorker } from "./helpers/fakeWorker";

/**
 * The built-in target's `close()` promises nothing is left running when it
 * resolves. For a `worker-thread` target that was not true: the executor
 * settles a run the moment it calls `terminate()`, which does not wait, and
 * the close awaited that — so a forced or deadline close resolved in the next
 * microtask with the thread still going. A busy Bun `Worker` runs on for tens
 * of milliseconds after `terminate()`, seconds on a loaded machine
 * (oven-sh/bun#44216). The close now waits for the thread's `close` event
 * (the handle's `exited`), still bounded by `TARGET_CLOSE_REAP`, and logs one
 * `warn` when a thread outlives that bound.
 *
 * The real-thread tests pin the thread's last side effect against the moment
 * the close resolved with a stamp the processor writes on every turn
 * (`job-spin-stamp.ts`), and the moment of its `close` event with a recording
 * `Worker`. They wait for that event, with a generous deadline, rather than
 * for any fixed window: how long a killed thread runs on is Bun's to decide
 * and grows with the machine's load. Those with a stand-in `Worker` decide
 * when the "thread" stops, which is the only way to test a thread that
 * outlives the bound.
 */

const handlers = join(import.meta.dir, "fixtures", "handlers");
const cleanups: (() => Promise<unknown> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** One clock across threads, in milliseconds (see `job-spin-stamp.ts`). */
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

/** The overrun warnings among `events`. */
function overruns(events: LogEvent[]): LogEvent[] {
  return events.filter(
    (event) => event.level === "warn" && event.message.includes("#44216"),
  );
}

/** A thread's `close` event: when it fired, and what had been logged by then. */
interface ThreadClose {
  /** When the event fired, on {@link now}'s clock. */
  at: number;
  /** How many overrun warnings had been logged when it fired. */
  warnedBefore: number;
}

/**
 * Replaces the global `Worker` with a subclass that records each instance's
 * `close` event, and the overrun warnings among `events` at that moment.
 * Restored after the test.
 */
function recordWorkerCloses(events: LogEvent[]): ThreadClose[] {
  const closes: ThreadClose[] = [];
  const Real = globalThis.Worker;
  class Recorded extends Real {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      const record = () => {
        closes.push({ at: now(), warnedBefore: overruns(events).length });
      };
      this.addEventListener("close", record);
    }
  }
  globalThis.Worker = Recorded;
  cleanups.push(() => {
    globalThis.Worker = Real;
  });
  return closes;
}

/**
 * Waits for the thread's `close` event, 15 s at most, then reads the stamp it
 * left in `file`: its last side effect, and whether it stopped at all.
 *
 * Not "the file stopped changing": that read a thread starved of CPU for
 * 300 ms on a loaded machine as stopped, and a thread still running for 5 s
 * after a close as left running, where Bun was only slow to end it
 * (oven-sh/bun#44216). The `close` event is the only certain sign.
 */
async function lastWrite(
  file: string,
  closes: ThreadClose[],
): Promise<{ value: string; stopped: boolean }> {
  const deadline = Date.now() + 15_000;
  while (closes.length === 0 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  return { value: await Bun.file(file).text(), stopped: closes.length > 0 };
}

/**
 * A worker on the memory driver whose `worker-thread` target runs
 * `job-spin-stamp.ts`, with one job already spinning: resolves once the
 * thread has written its first stamp.
 */
async function spinning(
  target: Extract<LocalWorkerTarget, { kind: "worker-thread" }>,
): Promise<{
  worker: BunQueueWorker;
  beacon: string;
  events: LogEvent[];
  closes: ThreadClose[];
}> {
  const { logger, events } = createTestLogger();
  const closes = recordWorkerCloses(events);
  const tmp = await makeTmpDir("thread-exit");
  cleanups.push(tmp.cleanup);
  const beacon = join(tmp.path, "beacon");
  const processor = join(handlers, "job-spin-stamp.ts");
  const factory: WorkerTargetFactory = (context) =>
    new FileTargetExecutor(target, processor, {
      namespace: context.namespace,
      queue: context.queue,
      workerId: context.workerId,
      logger,
    });
  const driver = createDriver({ type: "memory" });
  const namespace = testNamespace("thread-exit");
  const worker = new BunQueueWorker("thread-exit", processor, {
    namespace,
    driver,
    logger: noopLogger,
    pollInterval: 20,
    lockDuration: 60_000,
    target: factory,
  });
  worker.on("error", () => {});
  cleanups.push(async () => await worker.close({ force: true }));
  const queue = new BunQueue("thread-exit", {
    namespace,
    driver,
    logger: noopLogger,
  });
  void worker.run();
  await queue.add(
    "spin",
    { beaconFile: beacon, spinMs: 30_000 },
    { attempts: 1 },
  );
  await waitFor(async () => await Bun.file(beacon).exists(), {
    timeout: 10_000,
  });
  return { worker, beacon, events, closes };
}

/**
 * The claim, for a close that resolved at `closedAt`: the thread had stopped
 * by then — its `close` event and its last stamp came first — unless it
 * outlived `TARGET_CLOSE_REAP`, which Bun's termination latency can on a
 * loaded machine, and then the close said so in exactly one warning, logged
 * while the thread was indeed still running.
 */
async function expectStoppedBy(
  closedAt: number,
  spin: Awaited<ReturnType<typeof spinning>>,
): Promise<void> {
  const last = await lastWrite(spin.beacon, spin.closes);
  // Not left running, whatever else: the processor spins for 30 s.
  expect(last.stopped).toBe(true);
  expect(spin.closes.length).toBe(1);
  expect(Number(last.value)).toBeGreaterThan(0);
  const warned = overruns(spin.events);
  if (warned.length > 0) {
    expect(warned.length).toBe(1);
    // The warning was true when it was logged: the thread closed after it.
    expect(spin.closes[0]!.warnedBefore).toBe(1);
    return;
  }
  // The thread's last side effect came before the close resolved...
  expect(Number(last.value)).toBeLessThanOrEqual(closedAt);
  // ...and so did its `close` event, the only certain sign it had stopped.
  expect(spin.closes[0]!.at).toBeLessThanOrEqual(closedAt);
}

describe("a worker-thread target's close waits for the thread to stop", () => {
  it("forced: resolves only after the busy thread's close, and its last side effect", async () => {
    const spin = await spinning({
      kind: "worker-thread",
      closeTimeout: 10_000,
    });
    await spin.worker.close({ force: true });
    const closedAt = now();
    await expectStoppedBy(closedAt, spin);
  }, 30_000);

  it("graceful: when the executor's own escalation ends the run, the close still waits for the thread", async () => {
    // A `closeTimeout` far inside the target's grace: the executor terminates
    // the thread itself, and the graceful close sees the run end then.
    const spin = await spinning({ kind: "worker-thread", closeTimeout: 100 });
    await spin.worker.close({ timeout: 50 });
    const closedAt = now();
    await expectStoppedBy(closedAt, spin);
  }, 30_000);

  it(
    "graceful: at the grace deadline, the close waits for the thread it killed",
    async () => {
      const spin = await spinning({
        kind: "worker-thread",
        closeTimeout: 60_000,
      });
      const startedAt = now();
      await spin.worker.close({ timeout: 50 });
      const closedAt = now();
      expect(closedAt - startedAt).toBeGreaterThanOrEqual(
        TARGET_CLOSE_GRACE - 100,
      );
      await expectStoppedBy(closedAt, spin);
    },
    TARGET_CLOSE_GRACE + 30_000,
  );
});

/** A minimal attempt for `FileTargetExecutor.run`, which a stand-in ignores. */
function attempt(controller = new AbortController()): WorkerTargetAttempt {
  return {
    job: {
      updateProgress: async () => {},
    } as unknown as Job<unknown, unknown>,
    record: makeJob({ attemptsMade: 1 }),
    context: {
      signal: controller.signal,
      logger: noopLogger,
    } as unknown as ProcessorContext,
  };
}

/**
 * A `worker-thread` target over a stand-in `Worker`, with one attempt running:
 * resolves once the executor has sent the stand-in its `start`.
 */
async function standIn(closeAfter: number | false): Promise<{
  target: FileTargetExecutor;
  fake: FakeWorker;
  run: Promise<unknown>;
  events: LogEvent[];
  runId: string;
}> {
  cleanups.push(installFakeWorker(closeAfter));
  const { logger, events } = createTestLogger();
  const target = new FileTargetExecutor(
    { kind: "worker-thread", closeTimeout: 60_000 },
    join(handlers, "job-spin-stamp.ts"),
    { namespace: "thread-exit", queue: "thread-exit", workerId: "w", logger },
  );
  const job = attempt();
  const run = target.run(job).catch((error: unknown) => error);
  const fake = FakeWorker.instances[0]!;
  await waitFor(() => fake.received.some((message) => message.t === "start"));
  cleanups.push(() => fake.exit());
  return {
    target,
    fake,
    run,
    events,
    runId: `${job.record.id}.${job.record.attemptsMade}`,
  };
}

describe("a worker-thread target's close, with a stand-in Worker", () => {
  it("forced: waits for the thread's close within the reap bound, and warns about nothing", async () => {
    const { target, fake, events } = await standIn(150);
    const startedAt = now();
    let closedAt = 0;
    await Promise.resolve(target.close({ force: true })).then(() => {
      closedAt = now();
    });
    expect(fake.closed).toBe(true);
    expect(closedAt - startedAt).toBeGreaterThanOrEqual(140);
    expect(closedAt - startedAt).toBeLessThan(TARGET_CLOSE_REAP);
    expect(overruns(events)).toEqual([]);
  });

  it("forced: resolves at the reap bound when the thread outlives it, warning once, naming the run", async () => {
    const { target, fake, events, runId } = await standIn(false);
    const startedAt = now();
    const forced = target.close({ force: true });
    await forced;
    const tookMs = now() - startedAt;
    expect(fake.closed).toBe(false);
    expect(tookMs).toBeGreaterThanOrEqual(TARGET_CLOSE_REAP - 20);
    expect(tookMs).toBeLessThan(TARGET_CLOSE_REAP + 1_500);

    const warned = overruns(events);
    expect(warned.length).toBe(1);
    expect(warned[0]!.message).toContain(runId);
    expect(warned[0]!.fields.runIds).toEqual([runId]);

    // Asked again, forced or not: the same wait, and no second warning.
    expect(target.close({ force: true })).toBe(forced);
    expect(target.close()).toBe(forced);
    await forced;
    expect(overruns(events).length).toBe(1);

    // Once the thread does stop, nothing is left for a close to wait on.
    fake.exit();
    await Bun.sleep(10);
    expect(fake.terminations).toBe(1);
  });

  it("forced over a graceful close: one warning for a thread that outlives the bound", async () => {
    const { target, events } = await standIn(false);
    const graceful = target.close();
    const forced = target.close({ force: true });
    await Promise.all([graceful, forced]);
    expect(overruns(events).length).toBe(1);
  });

  it(
    "graceful: the deadline's reap warns once, and a force after it warns no more",
    async () => {
      const { target, events } = await standIn(false);
      await target.close();
      expect(overruns(events).length).toBe(1);
      // The thread is still dying, so a later force waits on it again — and
      // stays quiet about a thread already reported.
      await target.close({ force: true });
      expect(overruns(events).length).toBe(1);
    },
    TARGET_CLOSE_GRACE + 10_000,
  );

  it("graceful: a run that ends on its own resolves the close once its thread closes, with no warning", async () => {
    const { target, fake, events, run } = await standIn(20);
    const closing = target.close();
    // The processor unwinds when asked, as a well-behaved one does.
    await waitFor(() => fake.received.some((message) => message.t === "close"));
    fake.emit({ t: "done", runId: "ignored", result: "unwound" });
    // A run asked to stop is recorded as killed however it unwound.
    expect(await run).toBeInstanceOf(Error);
    expect(fake.closed).toBe(false);
    await closing;
    expect(fake.closed).toBe(true);
    expect(overruns(events)).toEqual([]);
  });

  it("an attempt that settled with its thread still dying: the attempt is not held, a close after it is", async () => {
    const { target, fake, events, run } = await standIn(150);
    fake.emit({ t: "done", runId: "ignored", result: "finished" });
    // The attempt's result is not held for the thread.
    expect(await run).toBe("finished");
    expect(fake.terminations).toBe(1);
    expect(fake.closed).toBe(false);

    // But a close that starts now waits for it, where it used to return at
    // once with the thread still running.
    const closing = target.close();
    expect(closing).toBeInstanceOf(Promise);
    expect(await within(closing as Promise<void>, 50)).toBe(false);
    await closing;
    expect(fake.closed).toBe(true);
    expect(overruns(events)).toEqual([]);

    // And once it has stopped, there is nothing to wait for.
    expect(target.close()).toBeUndefined();
  });
});
