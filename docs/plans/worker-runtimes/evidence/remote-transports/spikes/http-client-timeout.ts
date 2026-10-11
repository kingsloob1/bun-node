// fetch's non-standard per-request idle `timeout` (ms). Server: headers+1 byte now, then silent 12 s.
// Run: bun http-client-timeout.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const srv = Bun.serve({ port: 0, idleTimeout: 0, fetch(req) {
  const before = new URL(req.url).searchParams.has("before");
  return before ? sleep(12000).then(() => new Response("late"))
    : new Response(new ReadableStream({ async start(c) { c.enqueue("x"); await sleep(12000); try { c.enqueue("y"); c.close(); } catch {} } }));
} });
for (const [q, t] of [["", 500], ["", 2000], ["?before", 2000]] as const) {
  const s = performance.now();
  try { const r = await fetch(`http://127.0.0.1:${srv.port}/${q}`, { timeout: t } as any); const b = await r.text(); console.log(`RESULT timeout=${t} ${q || "mid-body"}: ok "${b}" after ${Math.round(performance.now() - s)}ms`); }
  catch (e) { console.log(`RESULT timeout=${t} ${q || "mid-body"}: ${(e as Error).name} "${(e as Error).message.split(".")[0]}" after ${Math.round(performance.now() - s)}ms`); }
}
srv.stop(true); process.exit(0);
