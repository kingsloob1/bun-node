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
  /**
   * The lock this job was claimed under, which the write must match. Defaults
   * to the batcher's own `token`; a completion with neither fails. A worker
   * mints a token per claim, so completions arriving together may carry
   * different ones — each is written under its own.
   */
  token?: string;
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
  /** The token a completion that names none was claimed under, if any. */
  readonly #token: string | undefined;
  /** Completions that have not been written yet. */
  #pending: PendingCompletion[] = [];
  /**
   * The drain loop currently running, if any. Cleared by the loop itself, in
   * the same synchronous step that finds nothing left pending — see
   * {@link #drain} for why that matters.
   */
  #flushing: Promise<void> | undefined;

  constructor(
    /** Where the completions are written. */
    driver: QueueDriver,
    /** The queue they belong to. */
    ref: QueueRef,
    /**
     * The token a completion that names none was claimed under. Optional:
     * a caller whose claims each carry their own token passes it on every
     * {@link PendingCompletion} instead.
     */
    token?: string,
  ) {
    this.#driver = driver;
    this.#ref = ref;
    this.#token = token;
  }

  /** Records one finished job, joining whatever batch comes next. */
  add(completion: PendingCompletion): void {
    this.#pending.push(completion);

    if (!this.#flushing) {
      this.#flushing = this.#drain();
    }
  }

  /** Resolves once nothing is pending or in flight. */
  async idle(): Promise<void> {
    while (this.#flushing) {
      await this.#flushing;
    }
  }

  /**
   * Writes batches until nothing is left, taking each as it stands.
   *
   * `#flushing` is cleared here, not by a `.finally()` chained onto this
   * promise. That callback ran a microtask or more after the loop had seen
   * nothing pending, and a completion added in between found a drain still
   * "in flight", joined its queue and was never written: its job stayed
   * `active` under a live lock, with no event, until the lock lapsed — and
   * `close()` waited on it. Clearing it in the `finally` below leaves no gap:
   * the last `pending` check and the clear are one synchronous step.
   *
   * `add` pushes before calling this, so the loop always awaits at least one
   * write and `#flushing` is assigned before the `finally` can run.
   */
  async #drain(): Promise<void> {
    try {
      while (this.#pending.length > 0) {
        const batch = this.#pending;
        this.#pending = [];
        await this.#write(batch);
      }
    } finally {
      this.#flushing = undefined;
    }
  }

  /**
   * Writes one batch, telling each completion how it went.
   *
   * The plural write takes one token for all its jobs, so the batch is split
   * by token first. Completions from one claim share it; a job claimed again
   * later has a different one, and writing it under another claim's token is
   * exactly the mistake the guard exists to refuse.
   */
  async #write(batch: PendingCompletion[]): Promise<void> {
    const byToken = new Map<string, PendingCompletion[]>();

    for (const one of batch) {
      const token = one.token ?? this.#token;

      if (token === undefined) {
        one.fail(
          new Error(`No lock token for the completion of job ${one.id}`),
        );
        continue;
      }

      const group = byToken.get(token);
      if (group) {
        group.push(one);
      } else {
        byToken.set(token, [one]);
      }
    }

    for (const [token, group] of byToken) {
      await this.#writeGroup(token, group);
    }
  }

  /** Writes completions that share one token. */
  async #writeGroup(token: string, batch: PendingCompletion[]): Promise<void> {
    // A lone completion is the idle case, and the singular call is what every
    // driver optimises. Taking the plural path for one job can be slower.
    if (batch.length === 1 || !this.#driver.completeJobs) {
      for (const one of batch) {
        try {
          const kept = await this.#driver.completeJob(
            this.#ref,
            one.id,
            token,
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
          token,
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
