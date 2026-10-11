// Follow-up to http-header-flush.ts: does Bun.serve flush headers before the first body chunk
// depending on content-type? Raw TCP client and fetch, each with and without text/event-stream.
// Run: bun http-header-flush2.ts
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const enc = new TextEncoder();
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const ct = new URL(req.url).searchParams.get("ct");
    return new Response(new ReadableStream({ async start(c) { await sleep(500); c.enqueue(enc.encode("a")); c.close(); } }),
      ct ? { headers: { "content-type": ct } } : undefined);
  },
});
for (const ct of ["", "text/event-stream", "application/octet-stream", "application/x-ndjson"]) {
  const q = ct ? `?ct=${encodeURIComponent(ct)}` : "";
  const s = performance.now();
  const done = Promise.withResolvers<string>();
  const sock = await Bun.connect({ hostname: "127.0.0.1", port: server.port!, socket: { data(_s, d) { done.resolve(d.toString()); } } });
  sock.write(`GET /${q} HTTP/1.1\r\nHost: x\r\n\r\n`);
  const first = await done.promise; const rawMs = Math.round(performance.now() - s); sock.end();
  const s2 = performance.now();
  const r = await fetch(`http://127.0.0.1:${server.port}/${q}`); const fMs = Math.round(performance.now() - s2); await r.text();
  console.log(`RESULT ct=${ct || "(none)"}: raw first bytes ${rawMs}ms (${JSON.stringify(first.slice(0, 120))}); fetch resolved ${fMs}ms`);
}
server.stop(true);
