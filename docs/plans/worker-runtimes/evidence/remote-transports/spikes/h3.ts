// HTTP/3 spike: Bun.serve({ http3 }) + fetch({ protocol: "http3" }); also default fetch's protocol choice vs http2.
// Run: bun h3.ts   (needs cert.pem / key.pem)
const dir = import.meta.dir;
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const enc = new TextEncoder(); const dec = new TextDecoder();
const key = await Bun.file(`${dir}/key.pem`).text();
const cert = await Bun.file(`${dir}/cert.pem`).text();
const tlsOpt = { ca: cert, serverName: "localhost" };

// 0. default fetch against an http2-capable server: h1 or h2? (count client ports over 5 concurrent requests)
{
  const ports = new Set<number | undefined>();
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", http2: true, tls: { key, cert }, async fetch(req, srv) { ports.add(srv.requestIP(req)?.port); await sleep(200); return new Response("x"); } });
  await Promise.all(Array.from({ length: 5 }, () => fetch(`https://127.0.0.1:${s.port}/`, { tls: tlsOpt } as any).then(r => r.text())));
  console.log(`RESULT 0 default fetch (no protocol) x5 concurrent vs http2 server: ${ports.size} client connection(s) (5 => HTTP/1.1, 1 => multiplexed h2)`);
  s.stop(true);
}

const events: string[] = [];
let srv: ReturnType<typeof Bun.serve> | undefined;
try {
  srv = Bun.serve({
    port: 0, hostname: "127.0.0.1", http3: true, tls: { key, cert },
    async fetch(req) {
      const url = new URL(req.url);
      events.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/echo") {
        const body = req.body!;
        return new Response(new ReadableStream({ async start(c) { for await (const ch of body) c.enqueue(enc.encode(`echo:${dec.decode(ch)}\n`)); c.close(); } }));
      }
      if (url.pathname === "/stream") {
        return new Response(new ReadableStream({ async start(c) { for (let i = 0; i < 4; i++) { c.enqueue(enc.encode(`c${i}\n`)); await sleep(150); } c.close(); } }));
      }
      if (url.pathname === "/big") return new Response(new Uint8Array(4 * 1024 * 1024));
      return new Response("hello h3");
    },
  });
  console.log(`RESULT 1 Bun.serve({ http3: true, tls }) started on port ${srv.port}`);
}
catch (e) { console.log(`RESULT 1 Bun.serve({ http3 }) threw: ${(e as Error).message}`); process.exit(0); }
const base = `https://127.0.0.1:${srv!.port}`;

// 2. Alt-Svc on the HTTP/1.1 response
{
  const r = await fetch(`${base}/`, { tls: tlsOpt, protocol: "http1.1" } as any);
  console.log(`RESULT 2 HTTP/1.1 response alt-svc: ${r.headers.get("alt-svc")}; body "${await r.text()}"`);
}
// 3. fetch over http3
const h3 = (path: string, init: any = {}) => fetch(`${base}${path}`, { ...init, tls: tlsOpt, protocol: "http3" } as any);
try {
  const s0 = performance.now();
  const r = await h3("/");
  console.log(`RESULT 3 fetch(protocol:"http3"): ${r.status} "${await r.text()}" in ${Math.round(performance.now() - s0)}ms`);
}
catch (e) { console.log(`RESULT 3 fetch(protocol:"http3") threw ${(e as Error).name}: ${(e as Error).message}`); }
// 4. streamed response over h3
try {
  const s0 = performance.now(); const r = await h3("/stream"); const rd = r.body!.getReader(); const t: number[] = [];
  for (;;) { const { done } = await rd.read(); if (done) break; t.push(Math.round(performance.now() - s0)); }
  console.log(`RESULT 4 streamed response over h3, read times (ms): ${JSON.stringify(t)}`);
}
catch (e) { console.log(`RESULT 4 streamed h3 threw ${(e as Error).message}`); }
// 5. duplex over h3
{
  let push!: (s: string) => void; let end!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(c) { push = s => c.enqueue(enc.encode(s)); end = () => c.close(); } });
  push("m0");
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(new Error("3s timeout")), 3000);
  try {
    const r = await h3("/echo", { method: "POST", body, duplex: "half", signal: ac.signal });
    const rd = r.body!.getReader(); const got: string[] = [];
    for (let i = 0; i < 3; i++) { const { value, done } = await rd.read(); if (done) break; got.push(dec.decode(value).trim()); if (i < 2) push(`m${i + 1}`); else end(); }
    console.log(`RESULT 5 duplex ping-pong over h3: ${JSON.stringify(got)}`);
  }
  catch (e) { console.log(`RESULT 5 duplex over h3: ${(e as Error).name} ${(e as Error).message}`); }
  clearTimeout(t);
}
// 6. 4 MiB body over h3, and 20 concurrent requests
try {
  const s0 = performance.now(); const b = await (await h3("/big")).arrayBuffer();
  console.log(`RESULT 6 4 MiB over h3: ${b.byteLength} bytes in ${Math.round(performance.now() - s0)}ms`);
  const s1 = performance.now(); const rs = await Promise.all(Array.from({ length: 20 }, () => h3("/").then(r => r.text())));
  console.log(`RESULT 6 20 concurrent h3 requests: ${rs.filter(x => x === "hello h3").length}/20 ok in ${Math.round(performance.now() - s1)}ms`);
}
catch (e) { console.log(`RESULT 6 threw ${(e as Error).message}`); }
// 7. WebSocket upgrade on an http3 server still works over HTTP/1.1? (not tested: no websocket handler) — http1:false check
{
  try {
    const only = Bun.serve({ port: 0, hostname: "127.0.0.1", http3: true, http1: false, tls: { key, cert }, fetch: () => new Response("h3-only") });
    let h1: string; try { const r = await fetch(`https://127.0.0.1:${only.port}/`, { tls: tlsOpt, protocol: "http1.1", signal: AbortSignal.timeout(2000) } as any); h1 = `${r.status}`; } catch (e) { h1 = `${(e as Error).name}`; }
    let h3r: string; try { const r = await fetch(`https://127.0.0.1:${only.port}/`, { tls: tlsOpt, protocol: "http3" } as any); h3r = `${r.status} ${await r.text()}`; } catch (e) { h3r = `${(e as Error).message}`; }
    console.log(`RESULT 7 http3:true http1:false: h1 fetch -> ${h1}; h3 fetch -> ${h3r}`);
    only.stop(true);
  }
  catch (e) { console.log(`RESULT 7 http1:false threw ${(e as Error).message}`); }
}
// 8. is WebTransport available?
console.log(`RESULT 8 typeof WebTransport=${typeof (globalThis as any).WebTransport}, typeof WebSocketStream=${typeof (globalThis as any).WebSocketStream}`);
console.log("server saw:", events.length, "requests");
srv!.stop(true);
process.exit(0);
