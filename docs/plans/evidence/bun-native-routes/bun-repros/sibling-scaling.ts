/**
 * Minimal reproduction (no dependencies): with many sibling routes at one
 * level, Bun.serve's `routes` table is quadratic to build (Bun.serve() and
 * server.reload()) and linear to look up, in the route's registration position.
 *
 *   bun sibling-scaling.ts
 *
 * Expected: build roughly linear in the route count; lookup independent of how
 * many siblings were registered before the matched route.
 * Actual (Bun 1.4.3-canary.1+5f554969b, linux x64): see the printed lines.
 * Cause (read from source): uWS HttpRouter keeps each node's children in a
 * std::vector, scanned linearly on insert (getNode) and on match
 * (packages/bun-uws/src/HttpRouter.h); a bare-function route is inserted once
 * per HTTP method (36).
 */
console.log(`Bun ${Bun.version} (${Bun.revision}) ${process.platform} ${process.arch}`);
for (const n of [500, 1000, 2000, 4000]) {
  const routes: Record<string, () => Response> = {};
  for (let i = 0; i < n; i++) routes[`/s${i}`] = () => new Response("x");
  const t0 = performance.now();
  const server = Bun.serve({ port: 0, routes, fetch: () => new Response("fetch") });
  const build = performance.now() - t0;
  const time = async (path: string) => {
    const t = performance.now();
    for (let k = 0; k < 2000; k++) await (await fetch(`${server.url}${path.slice(1)}`)).text();
    return ((performance.now() - t) / 2000) * 1000;
  };
  const first = await time("/s0");
  const last = await time(`/s${n - 1}`);
  console.log(`${String(n).padStart(4)} routes: Bun.serve() ${build.toFixed(1).padStart(7)} ms; GET first-registered ${first.toFixed(1)} µs, last-registered ${last.toFixed(1)} µs (sequential fetch, same process)`);
  server.stop(true);
}
