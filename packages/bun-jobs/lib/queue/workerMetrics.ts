import type {
  BufferWriteResult,
  BusynessSample,
  JobCounters,
  JobsDriver,
  QueueRef,
  ResolvedMetricsOptions,
} from "../drivers/index";
import type { Logger } from "../shared/logger";
import { SECOND_BUCKET_MS } from "../api/contract/constants";
import { bucketStart, PendingBuffer } from "../drivers/index";

/** One second's worth of a worker's outcomes, waiting to be written. */
interface PendingWorkerCount extends JobCounters {
  /** The namespace, for `PendingBuffer.forget`. */
  ns: string;
  /** The start of the second the outcomes landed in, epoch ms. */
  at: number;
}

/** What {@link WorkerMetricsRecorder} needs from the worker it records for. */
export interface WorkerMetricsRecorderOptions {
  /** The worker's driver; the recorder uses only its optional analytics methods. */
  driver: JobsDriver;
  /** The queue the worker consumes. */
  ref: QueueRef;
  /**
   * The worker's **stable** key (`WorkerInfo.key`), never its per-incarnation
   * id: keyed by incarnation, a rolling redeploy would shred the series into
   * one per replica.
   */
  key: string;
  /** The worker's resolved `metrics` option; only `workers` is read here. */
  metrics: ResolvedMetricsOptions;
  /** Where the first failed write is reported. */
  logger: Logger;
  /** How long outcomes are gathered before they are written, ms. A second by default. */
  flushMs?: number;
}

/**
 * A worker's own analytics: the jobs it completed and the attempts it failed,
 * and how busy it was at each heartbeat.
 *
 * **The worker counts, not the driver.** The driver knows a lock token, not a
 * worker, and attributing a completion inside the queue's hot script would
 * push per-worker cardinality into the one path that must stay cheap. So the
 * worker counts in memory and writes once a second through
 * `countWorkerJobs` — a buffer whose timer is armed by the first count and
 * unref'd, so an idle worker writes nothing at all. Busyness has no timer of
 * its own: {@link WorkerMetricsRecorder.sample} is called from the heartbeat
 * report, the only moment it is observed.
 *
 * **Capture never changes an outcome.** A driver without the methods records
 * nothing; a write that throws is logged once and its counts are dropped — not
 * put back, since a backend refusing every write would otherwise grow the
 * buffer by one entry a second for as long as the worker lives.
 *
 * The cumulative {@link WorkerMetricsRecorder.completed} and
 * {@link WorkerMetricsRecorder.failed} are kept whatever `metrics` says: they
 * ride the heartbeat record, a write that happens anyway.
 */
export class WorkerMetricsRecorder {
  /** Jobs completed by this incarnation, for the heartbeat record. */
  completed = 0;
  /** Attempts failed by this incarnation, for the heartbeat record. */
  failed = 0;

  /** The worker's driver. */
  readonly #driver: JobsDriver;
  /** The queue the worker consumes. */
  readonly #ref: QueueRef;
  /** The stable key every series is written under. */
  readonly #key: string;
  /** Where the first failure is logged. */
  readonly #logger: Logger;
  /** Outcomes gathered and not yet written; absent when nothing is recorded. */
  readonly #buffer: PendingBuffer<PendingWorkerCount> | undefined;
  /** Whether busyness samples are written. */
  readonly #samples: boolean;
  /** Whether a failure has been logged yet; only the first one is. */
  #failed = false;
  /** Set by {@link WorkerMetricsRecorder.close}: nothing is gathered after it. */
  #closed = false;
  /**
   * The current second's counts, kept here and handed to the buffer only when
   * the second changes or the flush timer fires. Counting into the buffer
   * directly cost an entry object, a `String(at)` key and a map merge per job
   * (A6); this is two comparisons and an increment.
   */
  #current: PendingWorkerCount | undefined;
  /** When {@link #current}'s second ends, epoch ms. */
  #currentEnd = 0;
  /** The timer that hands {@link #current} over, while one is armed. */
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** How long outcomes are gathered before they are written, ms. */
  readonly #flushMs: number;

  constructor(options: WorkerMetricsRecorderOptions) {
    this.#driver = options.driver;
    this.#ref = options.ref;
    this.#key = options.key;
    this.#logger = options.logger;

    this.#flushMs = options.flushMs ?? SECOND_BUCKET_MS;

    const recording = options.metrics.workers;
    this.#samples =
      recording && typeof options.driver.sampleWorkerBusyness === "function";
    this.#buffer =
      recording && typeof options.driver.countWorkerJobs === "function"
        ? new PendingBuffer<PendingWorkerCount>({
            write: async (batch) => await this.#write(batch),
            key: (entry) => String(entry.at),
            merge: (into, from) => {
              into.completed += from.completed;
              into.failed += from.failed;
            },
            flushMs: options.flushMs,
          })
        : undefined;
  }

  /**
   * Counts one outcome this worker's write landed: a completion, or a failed
   * attempt. No I/O — the count joins the current second's entry.
   */
  count(outcome: keyof JobCounters, now: number = Date.now()): void {
    this[outcome] += 1;

    if (this.#closed || !this.#buffer) {
      return;
    }

    const current = this.#current;
    if (current && now < this.#currentEnd && now >= current.at) {
      current[outcome] += 1;
      return;
    }

    this.#handOver();
    const at = bucketStart(now, SECOND_BUCKET_MS);
    this.#current = {
      ns: this.#ref.ns,
      at,
      completed: outcome === "completed" ? 1 : 0,
      failed: outcome === "failed" ? 1 : 0,
    };
    this.#currentEnd = at + SECOND_BUCKET_MS;

    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#handOver();
        void this.#buffer?.flush().catch(() => undefined);
      }, this.#flushMs);
      this.#timer.unref?.();
    }
  }

  /** Moves the current second's counts into the buffer, to be written. */
  #handOver(): void {
    if (this.#current) {
      this.#buffer?.add(this.#current);
      this.#current = undefined;
    }
  }

  /**
   * Records the busyness a heartbeat report observed. Called from the report
   * and nowhere else, so it adds no timer and no write of its own beyond the
   * driver's buffered row. Never awaited by the report: a slow backend must
   * not hold the heartbeat chain, or the control adoption behind it, up.
   */
  sample(sample: BusynessSample, at: number): void {
    if (this.#closed || !this.#samples) {
      return;
    }

    try {
      void this.#driver.sampleWorkerBusyness!(
        this.#ref,
        this.#key,
        at,
        sample,
      ).catch((error: unknown) => this.#failure(error));
    } catch (error) {
      this.#failure(error);
    }
  }

  /**
   * Writes what is gathered, then asks the driver to write what *it* has
   * gathered — so a shutdown keeps the last second. Stops gathering first.
   * Never throws.
   */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#handOver();
    await this.#buffer?.close();

    if (typeof this.#driver.flushMetrics !== "function") {
      return;
    }

    try {
      await this.#driver.flushMetrics();
    } catch (error) {
      this.#failure(error);
    }
  }

  /** Writes one batch, one `countWorkerJobs` per second in it; drops what fails. */
  async #write(
    batch: PendingWorkerCount[],
  ): Promise<BufferWriteResult<PendingWorkerCount>> {
    for (const entry of batch) {
      const counts: Partial<JobCounters> = {};
      if (entry.completed > 0) {
        counts.completed = entry.completed;
      }
      if (entry.failed > 0) {
        counts.failed = entry.failed;
      }

      try {
        await this.#driver.countWorkerJobs!(
          this.#ref,
          this.#key,
          entry.at,
          counts,
        );
      } catch (error) {
        this.#failure(error);
      }
    }

    return { unwritten: [] };
  }

  /** Logs the first failed analytics write; every later one is dropped quietly. */
  #failure(error: unknown): void {
    if (this.#failed) {
      return;
    }

    this.#failed = true;
    this.#logger.warn(
      "Could not record worker analytics; further failures will not be logged",
      { error, workerKey: this.#key },
    );
  }
}
