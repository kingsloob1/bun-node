/**
 * Why the candidate index lifts param-random only from 8k to 15k req/s: the
 * cost of a route-cache miss, split between the route scan and the cache's
 * own bookkeeping. `getMatchedLayers()` in process, 1,000 `/r<i>/:id` routes,
 * a fresh id per call (like `oha --rand-regex-url`), 100k calls after a
 * 60k-call warm-up that fills the cache past its 50,000 cap.
 *
 *   bun bench/miss-cost.ts
 */
import { BunRouter } from "../../../../../packages/bun-common/lib/BunRouter";
import { installCandidateIndex, installRingCache } from "../prototype/candidate-index";

function router(index: boolean, routeCacheMax?: number, ringCache = false) {
  const r = new BunRouter(routeCacheMax === undefined ? { caseSensitive: true } : { caseSensitive: true, routeCacheMax });
  r.use((_req, _res, next) => next());
  for (let i = 0; i < 1000; i++) r.get(`/r${i}/:id`, (_req, res) => res.send("x"));
  if (index) installCandidateIndex(r);
  if (ringCache) installRingCache(r);
  return r;
}
let id = 0;
function time(label: string, r: BunRouter) {
  const call = () => r.getMatchedLayers({ requestHost: "localhost", requestMethod: "GET", requestUrl: `/r999/${id++}` });
  for (let i = 0; i < 60_000; i++) call();
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < 100_000; i++) call();
  console.log(`${label.padEnd(44)} ${((Bun.nanoseconds() - t0) / 100_000 / 1000).toFixed(2).padStart(7)} µs per miss`);
}
console.log(`Bun ${Bun.version} (${Bun.revision})\n`);
time("stock, cache on (50,000, FIFO eviction)", router(false));
time("stock, cache off", router(false, 0));
time("index, cache on (50,000, FIFO eviction)", router(true));
time("index, cache off", router(true, 0));
time("stock, ring FIFO cache (50,000)", router(false, undefined, true));
time("index, ring FIFO cache (50,000)", router(true, undefined, true));
