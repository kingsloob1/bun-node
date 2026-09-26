// HTTP/1.1 extras: header flush timing, idleTimeout bounds, maxRequestBodySize, duplex start timing.
// Run: bun http-extra.ts
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const enc = new TextEncoder();

// 1. idleTimeout bounds
for (const v of [0, 255, 256]) {
  try { const s = Bun.serve({ port: 0, idleTimeout: v, fetch: () => new Response("x") }); console.log(`RESULT idleTimeout=${v}: accepted`); s.stop(true); }
  catch (e) { console.log(`RESULT idleTimeout=${v}: threw ${(e as Error).message}`); }
}

const server = Bun.serve({
  port: 0,
  maxRequestBodySize: 1024, // bytes
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/late-first-chunk") {
      return new Response(new ReadableStream({
        async start(c) { await sleep(500); c.enqueue(enc.encode("a")); c.close(); },
      }));
    }
    if (url.pathname === "/late-first-chunk-direct") {
      return new Response(new ReadableStream({
        type: "direct",
        async pull(c: any) { c.flush(); await sleep(500); c.write("a"); c.flush(); c.close(); },
      } as any));
    }
    if (url.pathname === "/count") {
      let n = 0;
      try { for await (const c of req.body!) n += c.byteLength; return new Response(`read ${n}`); }
      catch (e) { return new Response(`read ${n} then threw ${(e as Error).message}`); }
    }
    return new Response("nf", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;

// 2. When does fetch() resolve if the server's stream has no first chunk yet?
for (const p of ["/late-first-chunk", "/late-first-chunk-direct"]) {
  const s = ms();
  const r = await fetch(base + p);
  const hdr = ms() - s;
  await r.text();
  console.log(`RESULT ${p}: fetch() resolved (headers) after ${hdr}ms; first chunk scheduled at 500ms`);
}

// 3. maxRequestBodySize=1024: fixed-length vs streamed (chunked) body of 4096 bytes
{
  const r = await fetch(`${base}/count`, { method: "POST", body: new Uint8Array(4096) }).catch(e => e as Error);
  console.log("RESULT maxRequestBodySize=1024, 4096-byte fixed body:", r instanceof Error ? `client error ${r.message}` : `${r.status} ${await r.text()}`);
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(1024)); c.close(); } });
  const r2 = await fetch(`${base}/count`, { method: "POST", body: stream, duplex: "half" } as RequestInit).catch(e => e as Error);
  console.log("RESULT maxRequestBodySize=1024, 4096-byte chunked body:", r2 instanceof Error ? `client error ${r2.message}` : `${r2.status} ${await r2.text()}`);
}

// 4. B-timing: in a duplex fetch, when do response headers arrive relative to the send start?
{
  let push!: (s: string) => void;
  const body = new ReadableStream<Uint8Array>({ start(c) { push = s => c.enqueue(enc.encode(s)); } });
  const echo = Bun.serve({ port: 0, fetch(req) { return new Response(req.body); } });
  push("x");
  const s = ms();
  const r = await fetch(`http://127.0.0.1:${echo.port}/`, { method: "POST", body, duplex: "half" } as RequestInit);
  console.log(`RESULT duplex echo (Response(req.body)): headers after ${ms() - s}ms`);
  const rd = r.body!.getReader();
  const first = await rd.read();
  console.log(`RESULT duplex echo first chunk after ${ms() - s}ms: ${new TextDecoder().decode(first.value)}`);
  await rd.cancel();
  echo.stop(true);
}

server.stop(true);
