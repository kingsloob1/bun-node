import type { Deferred } from "@kingsleyweb/bun-common";
import { createDeferred } from "@kingsleyweb/bun-common";

/**
 * The writes one attempt at a job still has in flight, so the worker can put
 * them in front of the record of how that job ended.
 *
 * A worker does not wait for the write that completes a job — letting go there
 * is most of what makes it fast — and a deadline does not wait for the run it
 * gave up on. Both mean the moment an attempt ends is *not* a moment when
 * everything the processor asked for has necessarily landed: a progress value
 * chained behind another, a log line a child sent and did not wait for, a
 * write a driver is still chewing on. Written afterwards, they land on a job
 * that already says how it ended, and a reader that waited for `completed`
 * reads the value from before the last update.
 *
 * So the attempt keeps its own record of them, which every write goes through
 * — `Job.updateProgress` and `Job.log` are the single funnel for both, whether
 * the processor runs here, in a `Worker` or in a child process — and the
 * worker settles it before each ending. How long it then waits is the caller's
 * to decide, but it must always be a bounded wait: a driver that hangs rather
 * than rejects would otherwise hold a worker's concurrency slot for good.
 * `BunQueueWorker` gives an attempt that reached its own end the same budget
 * as the ending write, and one it gave up on a much shorter flat one.
 *
 * The two kinds of write are kept apart because they need different things:
 *
 * - **Progress is {@link AttemptWrites.chain}ed.** A job has one progress
 *   value, so the last one reported must be the one the store keeps, and two
 *   writes in flight at once could land either way round.
 * - **A log line is {@link AttemptWrites.track}ed only.** Lines are appended,
 *   each with its own sequence, so writing them at once loses nothing —
 *   whereas chaining would serialise a chatty processor into one driver round
 *   trip per line. Measured, a child firing 200 lines at a driver that takes
 *   20 ms each: 0.18 s tracked, 4.14 s chained.
 *
 * Neither is a queue the caller can drain twice: an attempt ends once.
 */
export class AttemptWrites {
  /**
   * Whether the attempt's own end has been declared — its processor settled,
   * and the worker is about to write how the job ended.
   */
  #closed = false;
  /** How many tracked writes have not answered yet. */
  #inFlight = 0;
  /**
   * The tail of the ordered lane: what a chained write waits for. Always
   * resolved, never rejected, so one write that failed does not take the
   * writes behind it with it.
   */
  #ordered: Promise<void> = Promise.resolve();
  /**
   * Resolved the next time nothing is in flight, built only when someone is
   * waiting. Cleared as it resolves, so a later settle builds its own.
   */
  #drained: Deferred<void> | undefined;

  constructor(
    /**
     * The attempt's abort signal, read rather than listened to: aborting is
     * the worker giving up on the attempt, which ends it for its writes too —
     * and a listener per job is a cost every job would pay for the sake of the
     * few that are ever abandoned.
     */
    readonly signal?: AbortSignal,
  ) {}

  /**
   * Whether the attempt is over — settled or given up on — so that nothing
   * more may join its ordered lane. A progress value asked for after that
   * belongs to a job whose ending is already being written, and would land on
   * top of it.
   */
  get closed(): boolean {
    return this.#closed || this.signal?.aborted === true;
  }

  /**
   * Runs a write after every chained write before it, and counts it as in
   * flight until it answers. Resolves with nothing, having written nothing,
   * once the attempt is over.
   *
   * The promise it returns is the caller's own: a failing write rejects it,
   * exactly as the unwrapped write would have. The lane itself swallows that
   * failure, because the write behind this one is a different write and has no
   * reason to be abandoned.
   */
  chain(
    /** The write, run when its turn comes. */
    write: () => Promise<void>,
  ): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }

    const ran = this.#ordered.then(write);
    this.#ordered = ran.catch(() => undefined);
    return this.#join(ran);
  }

  /**
   * Runs a write now, alongside whatever else is in flight, and counts it
   * until it answers.
   *
   * Nothing is dropped here: the write is started either way, and once the
   * attempt is over it simply runs untracked — a line stored late is still the
   * line, which is not true of a progress value.
   */
  track<T>(
    /** The write, started immediately. */
    write: () => Promise<T>,
  ): Promise<T> {
    const ran = write();
    return this.closed ? ran : this.#join(ran);
  }

  /**
   * Ends the attempt and answers with what is still in flight, or `undefined`
   * when nothing is — which is the ordinary job, and why this is not always a
   * promise: it sits between a processor returning and its completion being
   * written, the one place in the worker deliberately left un-awaited, and a
   * job that logged nothing should not pay a timer to learn that.
   *
   * Writes asked for afterwards are dropped ({@link AttemptWrites.chain}) or
   * run untracked ({@link AttemptWrites.track}), so what this answers with can
   * only shrink: it can never be held open by a processor that has not noticed
   * it was abandoned.
   */
  settle(): Promise<void> | undefined {
    this.close();

    if (this.#inFlight === 0) {
      return undefined;
    }

    this.#drained ??= createDeferred<void>();
    return this.#drained.promise;
  }

  /**
   * Ends the attempt without waiting for anything. An abort does this on its
   * own, through {@link AttemptWrites.signal}.
   */
  close(): void {
    this.#closed = true;
  }

  /** Counts `ran` as in flight until it answers, and hands it back unchanged. */
  #join<T>(ran: Promise<T>): Promise<T> {
    this.#inFlight++;
    // Both arms, on a branch of the caller's promise: this must not turn a
    // rejection the caller handles into one nothing does, nor swallow it.
    void ran.then(
      () => this.#answered(),
      () => this.#answered(),
    );
    return ran;
  }

  /** Records one write as answered, releasing a settle that waited for it. */
  #answered(): void {
    this.#inFlight--;

    if (this.#inFlight === 0 && this.#drained) {
      const drained = this.#drained;
      this.#drained = undefined;
      drained.resolve();
    }
  }
}
