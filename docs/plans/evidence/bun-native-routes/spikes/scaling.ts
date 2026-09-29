/**
 * How Bun's native route lookup scales with the route count, and whether the
 * position of a route in the table matters. For N in a few sizes, a server
 * with N param routes `/r<i>/:id` and N static routes `/s<i>`; `oha` then
 * drives the first and the last of each kind.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/scaling.ts [seconds]
 *
 * `oha` runs as a separate process (Bun.spawn, awaited), so the server's
 * event loop is free while it runs. One run per cell: this spike looks for a
 * factor, not a percentage.
 */
const seconds = Number(process.argv[2] ?? 3);

async function oha(url: string): Promise<number> {
  const proc = Bun.spawn(["oha", "-z", `${seconds}s`, "-c", "64", "--no-tui", "--output-format", "json", url], {
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Math.round((JSON.parse(out) as { summary: { requestsPerSec: number } }).summary.requestsPerSec);
}

console.log(`Bun ${Bun.version} (${Bun.revision}); req/s, oha -c 64, ${seconds}s per cell\n`);
console.log("N      | /r0/:id | /r<N-1>/:id | /s0    | /s<N-1> | mixed-shape /a<i>/:id/b/:x (last)");
for (const n of [1, 10, 100, 1000, 5000]) {
  const routes: Record<string, (req: Bun.BunRequest) => Response> = {};
  for (let i = 0; i < n; i++) {
    routes[`/r${i}/:id`] = (req) => new Response(req.params.id);
    routes[`/s${i}`] = () => new Response("s");
    routes[`/a${i}/:id/b/:x`] = (req) => new Response(req.params.x);
  }
  const server = Bun.serve({ port: 0, routes, fetch: () => new Response("nf", { status: 404 }) });
  const base = `http://127.0.0.1:${server.port}`;
  const cells = [
    await oha(`${base}/r0/7`),
    await oha(`${base}/r${n - 1}/7`),
    await oha(`${base}/s0`),
    await oha(`${base}/s${n - 1}`),
    await oha(`${base}/a${n - 1}/7/b/9`),
  ];
  console.log(`${String(n).padEnd(6)} | ${cells.map((c) => String(c).padStart(7)).join(" | ")}`);
  server.stop(true);
}
