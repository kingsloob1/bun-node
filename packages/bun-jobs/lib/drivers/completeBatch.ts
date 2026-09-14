import type { QueueDriver, QueueRef, Retention } from "./driver";

/**
 * Settling finished jobs together, without ever waiting to gather them.
 *
 * A worker at concurrency 16 finishes jobs in bursts, and one statement per job
 * is what its own claim loop then contends with — profiled on Postgres, a claim
 * that costs 2.33ms alone costs 9.9ms while sixteen completions are in flight
 * beside it.
 *
 * The batching is opportunistic, never timed. A completion with nothing in
 * flight goes out immediately, alone; completions that arrive while that write
 * is running collect, and go out together the moment it returns. So an idle
 * queue behaves exactly as it did before — no added latency, which is the whole
 * reason not to use an accumulation window — and a busy one batches harder the
 * busier it gets, which is when it matters.
 */

/** One finished job waiting to be recorded. */
export interface PendingCompletion {
  /** The job's id. */
  id: string;
  /** What its processor returned. */
  result: unknown;
  /** What should become of the record. */
  retention: Retention;
  /** Called with whether the job was still this worker's to settle. */
  settle: (kept: boolean) => void;
  /** Called when the write itself failed. */
  fail: (error: unknown) => void;
}

/** Collects completions and writes them in as few round trips as it can. */
export class CompletionBatcher {
  /** Where the completions are written. */
  readonly #driver: QueueDriver;
  /** The queue they belong to. */
  readonly #ref: QueueRef;
  /** The token they were claimed under. */
  readonly #token: string;
  /** Completions that have not been written yet. */
  #pending: PendingCompletion[] = [];
  /** The write currently in flight, if any. */
  #flushing: Promise<void> | undefined;

  constructor(
    /** Where the completions are written. */
    driver: QueueDriver,
    /** The queue they belong to. */
    ref: QueueRef,
    /** The token they were claimed under. */
    token: string,
  ) {
    this.#driver = driver;
    this.#ref = ref;
    this.#token = token;
  }

  /** Records one finished job, joining whatever batch comes next. */
  add(completion: PendingCompletion): void {
    this.#pending.push(completion);

    if (!this.#flushing) {
      this.#flushing = this.#drain().finally(() => {
        this.#flushing = undefined;
      });
    }
  }

  /** Resolves once nothing is pending or in flight. */
  async idle(): Promise<void> {
    while (this.#flushing) {
      await this.#flushing;
    }
  }

  /** Writes batches until nothing is left, taking each as it stands. */
  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const batch = this.#pending;
      this.#pending = [];
      await this.#write(batch);
    }
  }

  /** Writes one batch, telling each completion how it went. */
  async #write(batch: PendingCompletion[]): Promise<void> {
    // A lone completion is the idle case, and the singular call is what every
    // driver optimises. Taking the plural path for one job can be slower.
    if (batch.length === 1 || !this.#driver.completeJobs) {
      for (const one of batch) {
        try {
          const kept = await this.#driver.completeJob(
            this.#ref,
            one.id,
            this.#token,
            one.result,
            one.retention,
            Date.now(),
          );
          one.settle(kept);
        } catch (error) {
          one.fail(error);
        }
      }
      return;
    }

    try {
      const settled = new Set(
        await this.#driver.completeJobs(
          this.#ref,
          this.#token,
          batch.map((one) => ({
            id: one.id,
            result: one.result,
            retention: one.retention,
          })),
          Date.now(),
        ),
      );

      for (const one of batch) {
        one.settle(settled.has(one.id));
      }
    } catch (error) {
      // The batch is one statement, so a failure is every job's failure. Each
      // is told, because each has a listener waiting to hear what happened.
      for (const one of batch) {
        one.fail(error);
      }
    }
  }
}
