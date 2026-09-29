/**
 * The route cache evicts FIFO with `cache.delete(cache.keys().next().value)`
 * on a full `Map` (BunRouter.getMatchedLayers). Is that the ~16 µs a miss
 * pays once the cache is full (results/miss-cost.txt)? This times the same
 * pattern alone, against a Map that is simply cleared when full.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/map-fifo.ts
 */
function fifo(max: number, n: number) {
  const cache = new Map<string, number[]>();
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < n; i++) {
    if (cache.size >= max) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(`host:localhost:path:/r999/${i}:method:GET`, [i]);
  }
  return (Bun.nanoseconds() - t0) / n;
}
function insertOnly(max: number, n: number) {
  const cache = new Map<string, number[]>();
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < n; i++) {
    if (cache.size >= max) cache.clear();
    cache.set(`host:localhost:path:/r999/${i}:method:GET`, [i]);
  }
  return (Bun.nanoseconds() - t0) / n;
}
console.log(`Bun ${Bun.version} (${Bun.revision}); ns per insert, 200k inserts\n`);
for (const max of [2_000, 50_000]) {
  console.log(`cap ${String(max).padStart(6)}: FIFO evict-oldest ${fifo(max, 200_000).toFixed(0).padStart(6)} ns   clear-when-full ${insertOnly(max, 200_000).toFixed(0).padStart(4)} ns`);
}
