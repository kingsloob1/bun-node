/**
 * What an uncached route lookup (a fresh path, the param-random case) spends,
 * piece by piece, on 1,000 `/r<i>/:id` routes: the candidate index, the
 * route regex, the params, and building the layer array. ns per op, best of 5.
 *
 *   NODE_ENV=production BUN_OPTIONS= PKG_ROOT=<snapshot> bun miss-breakdown.ts
 */
import process from "node:process";

const PKG_ROOT = process.env.PKG_ROOT ?? "@kingsleyweb";
const { BunRouter } = (await import(`${PKG_ROOT}/bun-common`)) as typeof import("@kingsleyweb/bun-common");
const { RouteCandidateIndex } = (await import(`${PKG_ROOT}/bun-common/lib/utils/routeIndex.ts`)) as {
  RouteCandidateIndex: new () => { candidates: (routes: unknown[], path: string) => number[] };
};
const N = 200_000;
const sink: unknown[] = [];
function time(label: string, fn: () => unknown) {
  for (let i = 0; i < 50_000; i++) sink[i & 7] = fn();
  let best = Infinity;
  for (let p = 0; p < 5; p++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) sink[i & 7] = fn();
    best = Math.min(best, (Bun.nanoseconds() - t0) / N);
  }
  console.log(`  ${label.padEnd(60)} ${best.toFixed(0).padStart(6)} ns`);
}
const h = ((_q: unknown, s: { send: (b: string) => void }) => s.send("ok")) as never;
const router = new BunRouter({ routeCacheMax: 0 } as never);
for (let i = 0; i < 1000; i++) router.get(`/r${i}/:id`, h);
const routes = (router as unknown as { routes: () => { pathRegexp: RegExp; params: string[] }[] }).routes();
const index = new RouteCandidateIndex();
let k = 0;
const fresh = () => `/r999/${10_000_000 + k++}`;
console.log(`Bun ${Bun.version}; ns/op, best of 5 x ${N}\n`);
time("fresh path string (the loop's own cost)", fresh);
time("candidate index: candidates(routes, path)", () => index.candidates(routes, fresh()));
const route = routes[999];
time("route regex exec", () => route.pathRegexp.exec(fresh()));
time("regex exec + params object + decodeURIComponent", () => {
  const m = route.pathRegexp.exec(fresh())!;
  const params: Record<string, string> = {};
  params[route.params[0]] = decodeURIComponent(m[1]);
  return params;
});
time("regex exec + params, decode only when '%' (Elysia: decodeParams)", () => {
  const m = route.pathRegexp.exec(fresh())!;
  const params: Record<string, string> = {};
  const v = m[1];
  params[route.params[0]] = v.indexOf("%") === -1 ? v : decodeURIComponent(v);
  return params;
});
const opts = (url: string) => ({ requestHost: "localhost", requestMethod: "GET", requestUrl: url });
time("whole getMatchedLayers, routeCacheMax: 0", () => router.getMatchedLayers(opts(fresh())));
process.exit(0);
