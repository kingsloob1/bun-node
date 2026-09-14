/* eslint-disable no-console -- a benchmark's output is its product */
import type {
  JobPayload,
  Measurement,
  QueueContender,
  QueueHandle,
  QueueScenario,
} from "./types";
import { deferred, waitFor } from "./harness";
import { rate, summarise } from "./stats";

/**
 * What each queue scenario actually does.
 *
 * Two rules hold across all of them. Every scenario starts from an empty queue
 * and empties it again afterwards, so one contender's leftovers can never
 * become another's backlog. And every scenario counts arrivals by sequence
 * number, so a contender that loses or repeats jobs is reported as failed
 * rather than as fast.
 */

/** Knobs a scenario is run with. */
export interface ScenarioConfig {
  /** Jobs per measured run. */
  jobs: number;
  /** How many jobs a worker processes at once. */
  concurrency: number;
  /** Bytes of filler per payload, for the payload scenario. */
  payloadBytes: number;
  /** Independent consumer instances, for the contention scenario. */
  consumers: number;
  /** Round-trip samples, for the latency scenario. */
  samples: number;
  /** Seconds before a scenario gives up and reports what it was waiting for. */
  budgetSeconds: number;
  /** Queue name, unique per run so a previous run cannot leak in. */
  name: string;
  /** Connection string for the contender's backend. */
  url: string;
}

/** Tracks arrivals by sequence number so loss and duplication are both visible. */
class Arrivals {
  /** One counter per expected sequence number. */
  readonly seen: Uint16Array;
  /** How many distinct sequence numbers have arrived. */
  distinct = 0;
  /** How many arrivals were of a sequence number already seen. */
  duplicates = 0;
  /** How many arrivals carried a sequence number outside the expected range. */
  strays = 0;
  /** `performance.now()` of the first arrival, for separating ramp-up from drain. */
  firstAt = 0;
  /** `performance.now()` of the most recent arrival. */
  lastAt = 0;

  constructor(expected: number) {
    this.seen = new Uint16Array(expected);
  }

  /** Records one arrival. */
  record(seq: number): void {
    const at = performance.now();
    if (this.distinct === 0 && this.duplicates === 0) this.firstAt = at;
    this.lastAt = at;

    if (!Number.isInteger(seq) || seq < 0 || seq >= this.seen.length) {
      this.strays++;
      return;
    }

    if (this.seen[seq]! > 0) {
      this.duplicates++;
      this.seen[seq]!++;
      return;
    }

    this.seen[seq] = 1;
    this.distinct++;
  }

  /** The problem with this run, or null when every job arrived exactly once. */
  problem(expected: number): string | null {
    if (this.strays > 0)
      return `${this.strays} jobs arrived with an unknown id`;
    if (this.duplicates > 0)
      return `${this.duplicates} jobs were delivered more than once`;
    if (this.distinct !== expected) {
      return `${expected - this.distinct} of ${expected} jobs never arrived`;
    }
    return null;
  }
}

/** Fills an array of payloads with sequence numbers. */
function payloads(count: number): JobPayload[] {
  return Array.from({ length: count }, (_unused, seq) => ({ seq, at: 0 }));
}

/** Adds jobs in batches, so a batch API is used the way it is meant to be. */
async function seed(
  handle: QueueHandle,
  items: JobPayload[],
  batch = 500,
): Promise<void> {
  for (let index = 0; index < items.length; index += batch) {
    await handle.addBulk(items.slice(index, index + batch));
  }
}

/** Runs one scenario against one contender and returns what it measured. */
export async function runQueueScenario(
  contender: QueueContender,
  scenario: QueueScenario,
  config: ScenarioConfig,
): Promise<Measurement> {
  const identity = {
    contender: contender.id,
    scenario,
    backend: contender.backend,
  };

  const unsupported = contender.unsupported?.[scenario];
  if (unsupported) {
    return { ...identity, count: 0, elapsedMs: 0, skipped: unsupported };
  }

  const errors: unknown[] = [];
  const handles: QueueHandle[] = [];
  let arrivals = new Arrivals(1);
  let onArrive: (payload: JobPayload) => void = () => {};

  const makeHandle = (payloadBytes: number) =>
    contender.setup({
      name: config.name,
      url: config.url,
      payloadBytes,
      onComplete: (payload) => onArrive(payload),
      onError: (error) => errors.push(error),
    });

  try {
    switch (scenario) {
      case "enqueue":
      case "enqueue-bulk": {
        const handle = await makeHandle(0);
        handles.push(handle);
        await handle.reset();

        const items = payloads(config.jobs);
        const bulk = scenario === "enqueue-bulk";

        // A short warm-up so a first-call connection or prepared statement is
        // not charged to the measured loop.
        if (bulk) await handle.addBulk(payloads(10));
        else for (let i = 0; i < 10; i++) await handle.add({ seq: 0, at: 0 });
        await handle.reset();

        const started = performance.now();
        if (bulk) await seed(handle, items);
        else for (const item of items) await handle.add(item);
        const elapsedMs = performance.now() - started;

        await handle.reset();

        return {
          ...identity,
          opsPerSec: rate(config.jobs, elapsedMs),
          count: config.jobs,
          elapsedMs,
        };
      }

      case "throughput":
      case "payload": {
        const bytes = scenario === "payload" ? config.payloadBytes : 0;
        const handle = await makeHandle(bytes);
        handles.push(handle);
        await handle.reset();

        arrivals = new Arrivals(config.jobs);
        onArrive = (payload) => arrivals.record(payload.seq);

        await seed(handle, payloads(config.jobs));

        const started = performance.now();
        await handle.startWorker(config.concurrency);
        await waitFor(() => arrivals.distinct >= config.jobs, {
          timeoutMs: config.budgetSeconds * 1000,
          message: `only ${arrivals.distinct}/${config.jobs} jobs were processed`,
        });

        // The last arrival, not the poll that noticed it: on the in-process
        // backends the whole drain is a few milliseconds and the poll interval
        // would be a tenth of the figure.
        const elapsedMs = arrivals.lastAt - started;

        await handle.stopWorker();
        await handle.reset();

        const problem = arrivals.problem(config.jobs);
        if (problem)
          return {
            ...identity,
            count: arrivals.distinct,
            elapsedMs,
            failed: problem,
          };

        return {
          ...identity,
          opsPerSec: rate(config.jobs, elapsedMs),
          count: config.jobs,
          elapsedMs,
        };
      }

      case "roundtrip": {
        const handle = await makeHandle(0);
        handles.push(handle);
        await handle.reset();

        let pending: { seq: number; settle: () => void } | null = null;
        onArrive = (payload) => {
          if (pending && payload.seq === pending.seq) {
            const settle = pending.settle;
            pending = null;
            settle();
          }
        };

        await handle.startWorker(1);

        /**
         * Adds one job and resolves when that same job comes back. A job that
         * never returns fails the run rather than hanging it, so a contender
         * whose consumer has stalled is reported instead of stalling the
         * benchmark.
         */
        const roundTrip = async (seq: number): Promise<number> => {
          const gate = deferred<void>();
          pending = { seq, settle: gate.resolve };
          const started = performance.now();
          await handle.add({ seq, at: started });
          // A timer, not a poll loop. Polling alongside the measurement would
          // put a `setTimeout` on the event loop for every sample, and these
          // round trips are measured in microseconds on the fast backends.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const expiry = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`job ${seq} was never delivered`));
            }, config.budgetSeconds * 1000);
            timer.unref?.();
          });

          try {
            await Promise.race([gate.promise, expiry]);
          } finally {
            clearTimeout(timer);
          }

          return performance.now() - started;
        };

        // Warm up connections, prepared statements and the poll loop's phase
        // before anything is recorded.
        for (let i = 0; i < 5; i++) await roundTrip(i);

        const samples: number[] = [];
        const started = performance.now();
        for (let i = 0; i < config.samples; i++) {
          samples.push(await roundTrip(i));
        }
        const elapsedMs = performance.now() - started;

        await handle.stopWorker();
        await handle.reset();

        return {
          ...identity,
          latency: summarise(samples),
          opsPerSec: rate(samples.length, elapsedMs),
          count: samples.length,
          elapsedMs,
        };
      }

      case "contention": {
        arrivals = new Arrivals(config.jobs);
        onArrive = (payload) => arrivals.record(payload.seq);

        for (let i = 0; i < config.consumers; i++) {
          handles.push(await makeHandle(0));
        }

        const producer = handles[0]!;
        await producer.reset();
        await seed(producer, payloads(config.jobs));

        // Sequential, not concurrent. Bringing several clients up at once
        // measures connection setup contention rather than claim contention,
        // and at least one library (Agenda's Postgres backend) races its own
        // schema migration when two instances start together.
        const started = performance.now();
        for (const handle of handles) {
          await handle.startWorker(config.concurrency);
        }
        await waitFor(() => arrivals.distinct >= config.jobs, {
          timeoutMs: config.budgetSeconds * 1000,
          message: `only ${arrivals.distinct}/${config.jobs} jobs were processed`,
        });
        const elapsedMs = arrivals.lastAt - started;

        for (const handle of handles) await handle.stopWorker();
        await producer.reset();

        const problem = arrivals.problem(config.jobs);
        if (problem)
          return {
            ...identity,
            count: arrivals.distinct,
            elapsedMs,
            failed: problem,
          };

        return {
          ...identity,
          opsPerSec: rate(config.jobs, elapsedMs),
          count: config.jobs,
          elapsedMs,
        };
      }
    }
    // Every member of the union is handled above; this is the compiler's
    // proof, and it fires only if a scenario is added without a branch.
    throw new Error(`unhandled scenario: ${String(scenario)}`);
  } catch (error) {
    return {
      ...identity,
      count: arrivals.distinct,
      elapsedMs: 0,
      failed: error instanceof Error ? error.message : String(error),
    };
  } finally {
    for (const handle of handles) {
      await handle.close().catch(() => {});
    }
    if (errors.length > 0) {
      const first = errors[0];
      console.error(
        `  ! ${contender.id}/${scenario}: ${errors.length} runtime error(s), first: ${
          first instanceof Error ? first.message : String(first)
        }`,
      );
    }
  }
}
