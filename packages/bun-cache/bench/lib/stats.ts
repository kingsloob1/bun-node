import type { LatencySummary } from "./types";

/**
 * Turning a list of samples into the few numbers worth printing; copied from
 * bun-jobs' `bench/lib/stats.ts`.
 *
 * Latency is reported as percentiles rather than a mean, because a cache's
 * mean hides exactly what matters: the tail where a lock wait or a cold round
 * trip lands.
 */

/** Reads one percentile out of an already-sorted ascending sample. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

/** Summarises a latency sample. The input is copied, not sorted in place. */
export function summarise(samples: number[]): LatencySummary {
  if (samples.length === 0) {
    return { p50: 0, p90: 0, p99: 0, max: 0, mean: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: total / sorted.length,
  };
}

/** Operations per second from a count and an elapsed wall-clock time. */
export function rate(count: number, elapsedMs: number): number {
  return elapsedMs <= 0 ? 0 : (count * 1000) / elapsedMs;
}
