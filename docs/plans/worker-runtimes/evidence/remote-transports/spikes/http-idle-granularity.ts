// When does Bun.serve's idleTimeout actually cut a silent streamed response?
// For each idleTimeout, one stream: first chunk, then 12 s of silence. Run: bun http-idle-granularity.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
async function one(idle: number) {
  const server = Bun.serve({
    port: 0, idleTimeout: idle,
    fetch() { return new Response(new ReadableStream({ async start(c) { c.enqueue("x"); await sleep(12000); try { c.close(); } catch {} } })); },
  });
  const s = performance.now();
  const r = await fetch(`http://127.0.0.1:${server.port}/`); const rd = r.body!.getReader(); await rd.read();
  let how = "clean";
  try { while (!(await rd.read()).done); } catch { how = "reset"; }
  const out = `idleTimeout=${idle}: ${how} after ${Math.round(performance.now() - s)}ms`;
  server.stop(true); return out;
}
const results = await Promise.all([1, 2, 3, 4, 5, 6, 8, 10].map(one));
for (const r of results) console.log("RESULT", r);
