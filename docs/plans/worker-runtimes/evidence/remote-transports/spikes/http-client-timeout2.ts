// Granularity of fetch's per-request idle `timeout`: several values in parallel against a 20 s silent body.
// Run: bun http-client-timeout2.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const srv = Bun.serve({ port: 0, idleTimeout: 0, fetch() { return new Response(new ReadableStream({ async start(c) { c.enqueue("x"); await sleep(20000); try { c.close(); } catch {} } })); } });
const one = async (t: number) => { const s = performance.now(); try { await (await fetch(`http://127.0.0.1:${srv.port}/`, { timeout: t } as any)).text(); return `timeout=${t}: completed ${Math.round(performance.now() - s)}ms`; } catch (e) { return `timeout=${t}: ${(e as Error).name} after ${Math.round(performance.now() - s)}ms`; } };
for (const r of await Promise.all([100, 1000, 3000, 5000, 7000, 9000, 13000].map(one))) console.log("RESULT", r);
srv.stop(true); process.exit(0);
