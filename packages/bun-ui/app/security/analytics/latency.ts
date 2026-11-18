/** The decision-latency histogram's reading (PR-U2). */

/** The p95 of a latency histogram (`le` bucket edges, ms, `+Inf` last), as text. */
export function p95(buckets: ReadonlyMap<string, number>): string {
  const edges = [...buckets]
    .map(([le, count]) => ({
      le,
      edge: le === "+Inf" ? Infinity : Number(le),
      count,
    }))
    .filter((bucket) => !Number.isNaN(bucket.edge))
    .sort((a, b) => a.edge - b.edge);
  const total = edges.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total === 0) return "—";
  let seen = 0;
  for (const bucket of edges) {
    seen += bucket.count;
    if (seen >= total * 0.95)
      return bucket.edge === Infinity
        ? "over the last edge"
        : `≤ ${bucket.le} ms`;
  }
  return "—";
}
