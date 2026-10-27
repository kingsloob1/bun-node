/**
 * The counters behind `cache.stats()` (plan §3.12), shared by a cache and its
 * namespace views. Load durations feed percentiles over a rolling 60 s
 * window.
 */
import type { CacheStats } from "./types";

/** How long a load sample counts toward the percentiles, in ms. */
const LOAD_WINDOW_MS = 60_000;

/** One load sample: when it finished, how long it took. */
interface LoadSample {
  /** When the load finished, epoch ms on the cache's clock. */
  at: number;
  /** How long it took, in ms. */
  duration: number;
}

/** The mutable counts {@link CacheStats} reports. */
export class CacheStatsCounter {
  /** Fresh reads served. */
  hits = 0;
  /** Stale reads served. */
  staleHits = 0;
  /** Reads that found nothing usable. */
  misses = 0;
  /** Entries stored. */
  sets = 0;
  /** Keys deleted. */
  deletes = 0;
  /** Loader runs. */
  loads = 0;
  /** Loader failures. */
  loadErrors = 0;
  /** Lock waits. */
  lockWaits = 0;
  /** Driver-side evictions. */
  evictions = 0;
  /** Encoded bytes read. */
  bytesRead = 0;
  /** Encoded bytes written. */
  bytesWritten = 0;

  /** The load samples inside the rolling window. */
  #loads: LoadSample[] = [];

  /** The cache's clock (real, or a test's fake). */
  readonly #now: () => number;

  constructor(/** The cache's clock. */ now: () => number) {
    this.#now = now;
  }

  /** Records one load's duration. */
  recordLoad(duration: number): void {
    this.loads++;
    this.#loads.push({ at: this.#now(), duration });
  }

  /** Records one failed load's duration. */
  recordLoadError(duration: number): void {
    this.loads++;
    this.loadErrors++;
    this.#loads.push({ at: this.#now(), duration });
  }

  /** A snapshot of every counter; `reset` zeroes them after reading. */
  stats(options?: { reset?: boolean }): CacheStats {
    const now = this.#now();
    this.#loads = this.#loads.filter(
      (sample) => now - sample.at <= LOAD_WINDOW_MS,
    );
    const durations = this.#loads
      .map((sample) => sample.duration)
      .sort((a, b) => a - b);
    const percentile = (p: number): number =>
      durations.length === 0
        ? 0
        : durations[
            Math.min(
              durations.length - 1,
              Math.max(0, Math.ceil((p / 100) * durations.length) - 1),
            )
          ];
    const reads = this.hits + this.misses;
    const snapshot: CacheStats = {
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      loads: this.loads,
      loadErrors: this.loadErrors,
      lockWaits: this.lockWaits,
      evictions: this.evictions,
      bytesRead: this.bytesRead,
      bytesWritten: this.bytesWritten,
      hitRate: reads === 0 ? 0 : this.hits / reads,
      loadDurations: {
        count: durations.length,
        p50: percentile(50),
        p95: percentile(95),
        p99: percentile(99),
      },
    };
    if (options?.reset === true) {
      this.hits = 0;
      this.staleHits = 0;
      this.misses = 0;
      this.sets = 0;
      this.deletes = 0;
      this.loads = 0;
      this.loadErrors = 0;
      this.lockWaits = 0;
      this.evictions = 0;
      this.bytesRead = 0;
      this.bytesWritten = 0;
      this.#loads = [];
    }
    return snapshot;
  }
}
