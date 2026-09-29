/**
 * How long `Bun.serve({ routes })` takes to start, by route count and shape —
 * reload.ts showed the cost growing much faster than linearly. Minimal: no
 * code but Bun's.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/build-cost.ts
 */
const shapes: Record<string, (i: number) => string> = {
  "static, flat    /s<i>": (i) => `/s${i}`,
  "param, flat     /r<i>/:id": (i) => `/r${i}/:id`,
  "static, nested  /g<i/50>/s<i>": (i) => `/g${Math.floor(i / 50)}/s${i}`,
  "same-shape param /users/:id/p<i>": (i) => `/users/:id/p${i}`,
};
console.log(`Bun ${Bun.version} (${Bun.revision}); ms to Bun.serve() a table, best of 3\n`);
for (const [label, key] of Object.entries(shapes)) {
  const row: string[] = [];
  for (const n of [500, 1000, 2000, 4000]) {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < n; i++) routes[key(i)] = () => new Response("x");
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const s = Bun.serve({ port: 0, routes, fetch: () => new Response("nf") });
      best = Math.min(best, performance.now() - t0);
      s.stop(true);
    }
    row.push(`n=${n}: ${best.toFixed(1).padStart(7)}`);
  }
  console.log(`${label.padEnd(34)} ${row.join("  ")}`);
}
