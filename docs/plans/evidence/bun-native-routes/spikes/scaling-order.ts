/**
 * Follow-up to scaling.ts: is the slow end of Bun's route table the end
 * *registered last*, or the end that sorts last? 5000 static routes
 * `/s<i>` registered in reverse (s4999 first), then the same probes.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/scaling-order.ts
 */
async function oha(url: string): Promise<number> {
  const proc = Bun.spawn(["oha", "-z", "3s", "-c", "64", "--no-tui", "--output-format", "json", url], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return Math.round((JSON.parse(out) as { summary: { requestsPerSec: number } }).summary.requestsPerSec);
}
const n = 5000;
const routes: Record<string, () => Response> = {};
for (let i = n - 1; i >= 0; i--) routes[`/s${i}`] = () => new Response("s");
// nested: 5000 siblings one level down, under a shared prefix
for (let i = 0; i < n; i++) routes[`/api/v1/t${i}`] = () => new Response("t");
const server = Bun.serve({ port: 0, routes, fetch: () => new Response("nf", { status: 404 }) });
const base = `http://127.0.0.1:${server.port}`;
console.log(`Bun ${Bun.version} (${Bun.revision}); req/s, oha -c 64, 3s\n`);
console.log(`reverse-registered, /s${n - 1} (registered first): ${await oha(`${base}/s${n - 1}`)}`);
console.log(`reverse-registered, /s0 (registered last):         ${await oha(`${base}/s0`)}`);
console.log(`nested siblings, /api/v1/t0 (first):               ${await oha(`${base}/api/v1/t0`)}`);
console.log(`nested siblings, /api/v1/t${n - 1} (last):            ${await oha(`${base}/api/v1/t${n - 1}`)}`);
console.log(`unmatched → fetch, /nope:                          ${await oha(`${base}/nope`)}`);
server.stop(true);
