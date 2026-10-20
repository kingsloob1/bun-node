// S2: while a graceful stop(false) drains a long request, does A's listener still accept new
// connections (with SO_REUSEPORT the kernel would split them between A and B)? And Bun's fetch pool:
// after A.stop(false) and B bound on the port, who answers the pooled client?
import { conn, sleep } from "./raw";
const reusePort = process.argv[2] === "reuse";
const out: Record<string, unknown> = { bun: Bun.revision, reusePort };
const A = Bun.serve({ port: 0, hostname: "127.0.0.1", reusePort, fetch: async (req) => {
  if (new URL(req.url).pathname === "/slow") await sleep(800);
  return new Response("A");
} });
const port = A.port!;
// warm Bun's fetch pool with several keep-alive connections to A
out.pooledWarm = await Promise.all([1, 2, 3, 4].map(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text())));
const busy = conn(port); await busy.ready;
const inflight = busy.request("/slow");
await sleep(50);
A.stop(false);
await sleep(10);
const B = Bun.serve({ port, hostname: "127.0.0.1", reusePort, fetch: () => new Response("B") });
const counts: Record<string, number> = {};
for (let i = 0; i < 20; i++) {
  const c = conn(port);
  await c.ready.catch(() => {});
  const r = await c.request("/", 1000);
  const k = /body="(.)"/.exec(r)?.[1] ?? r.slice(0, 30);
  counts[k] = (counts[k] ?? 0) + 1;
  c.end();
}
out.freshDuringDrain = counts;
out.pooledAfterRebind = await Promise.all([1, 2, 3, 4].map(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text(), (e) => String(e).slice(0, 40))));
out.inflight = await inflight;
console.log(JSON.stringify(out));
busy.end(); A.stop(true); B.stop(true); process.exit(0);
