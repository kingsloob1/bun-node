// HTTP/1.1 spike: Bun.serve + fetch. Run: bun http.ts
// Every section prints one or more "RESULT" lines; the evidence doc quotes them.
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
const enc = new TextEncoder();
const dec = new TextDecoder();

const serverLog: string[] = [];
let aborted: Record<string, boolean> = {};

const server = Bun.serve({
  port: 0,
  idleTimeout: 3, // seconds; tested in section E
  async fetch(req, srv) {
    const url = new URL(req.url);
    const ip = srv.requestIP(req);
    if (url.pathname === "/peer") {
      return new Response(`${ip?.port}`);
    }
    if (url.pathname === "/upload") {
      // read request body incrementally, record when each chunk arrived
      const times: number[] = [];
      let bytes = 0;
      for await (const c of req.body!) { times.push(ms()); bytes += c.byteLength; }
      return Response.json({ times, bytes });
    }
    if (url.pathname === "/echo") {
      // full duplex attempt: respond immediately with a stream fed by the request body
      const body = req.body!;
      return new Response(new ReadableStream({
        async start(ctrl) {
          for await (const c of body) ctrl.enqueue(enc.encode(`echo:${dec.decode(c)}\n`));
          ctrl.close();
        },
      }));
    }
    if (url.pathname === "/stream") {
      // server streams 5 chunks, 200 ms apart
      return new Response(new ReadableStream({
        async start(ctrl) {
          for (let i = 0; i < 5; i++) { ctrl.enqueue(enc.encode(`chunk${i}\n`)); await sleep(200); }
          ctrl.close();
        },
      }));
    }
    if (url.pathname === "/silent") {
      // streams one chunk then stays silent for `s` seconds, then one more
      const s = Number(url.searchParams.get("s"));
      const key = url.searchParams.get("key")!;
      req.signal.addEventListener("abort", () => { aborted[key] = true; serverLog.push(`${ms()} server saw abort ${key}`); });
      return new Response(new ReadableStream({
        async start(ctrl) {
          ctrl.enqueue(enc.encode("first\n"));
          await sleep(s * 1000);
          try { ctrl.enqueue(enc.encode("second\n")); ctrl.close(); }
          catch (e) { serverLog.push(`${ms()} enqueue after silence threw: ${(e as Error).message}`); }
        },
      }));
    }
    if (url.pathname === "/slow-headers") {
      const s = Number(url.searchParams.get("s"));
      const key = url.searchParams.get("key")!;
      req.signal.addEventListener("abort", () => { aborted[key] = true; serverLog.push(`${ms()} server saw abort ${key}`); });
      await sleep(s * 1000);
      return new Response("late");
    }
    if (url.pathname === "/timeout-override") {
      srv.timeout(req, 0); // disable idle timeout for this request
      await sleep(4500);
      return new Response("survived");
    }
    if (url.pathname === "/big") {
      return new Response(new Uint8Array(8 * 1024 * 1024));
    }
    return new Response("nf", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
console.log("bun", Bun.version, "port", server.port);

// A. streamed request body: does the server see chunks as they're sent?
{
  const start = ms();
  const body = new ReadableStream({
    async start(ctrl) {
      for (let i = 0; i < 4; i++) { ctrl.enqueue(enc.encode(`part${i}`)); await sleep(250); }
      ctrl.close();
    },
  });
  const r = await fetch(`${base}/upload`, { method: "POST", body, duplex: "half" } as RequestInit);
  const j = await r.json() as { times: number[]; bytes: number };
  console.log("RESULT A streamed-request chunk arrival (ms after send start):", j.times.map(t => t - start), "bytes", j.bytes);
}

// B. full duplex: server echoes while client still sending. Client waits for each echo before sending the next.
{
  let push!: (s: string) => void; let end!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) { push = s => ctrl.enqueue(enc.encode(s)); end = () => ctrl.close(); },
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("duplex-timeout")), 3000);
  push("m0");
  try {
    const r = await fetch(`${base}/echo`, { method: "POST", body, duplex: "half", signal: ac.signal } as RequestInit);
    console.log(`  B headers arrived at ${ms()}ms while request body still open`);
    const reader = r.body!.getReader();
    const got: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      got.push(dec.decode(value).trim());
      if (i < 2) push(`m${i + 1}`); else end();
    }
    clearTimeout(timer);
    console.log("RESULT B full-duplex ping-pong over one fetch:", got);
  }
  catch (e) {
    clearTimeout(timer);
    console.log("RESULT B full-duplex ping-pong FAILED:", (e as Error).message);
  }
}

// C. incremental read of a streamed response
{
  const start = ms();
  const r = await fetch(`${base}/stream`);
  const reader = r.body!.getReader();
  const times: number[] = [];
  for (;;) { const { done } = await reader.read(); if (done) break; times.push(ms() - start); }
  console.log("RESULT C streamed-response reads (ms):", times);
}

// D. AbortSignal: client aborts a slow request; does the server's req.signal fire?
{
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  try { await fetch(`${base}/slow-headers?s=1&key=d1`, { signal: ac.signal }); }
  catch (e) { console.log(`  D client abort error: ${(e as Error).name} at ${ms()}`); }
  // abort mid-body
  const ac2 = new AbortController();
  const r = await fetch(`${base}/silent?s=1&key=d2`, { signal: ac2.signal });
  const rd = r.body!.getReader(); await rd.read();
  ac2.abort();
  try { await rd.read(); } catch (e) { console.log(`  D mid-body abort read error: ${(e as Error).name}`); }
  await sleep(1300);
  console.log("RESULT D server req.signal fired on client abort: before-headers =", !!aborted.d1, ", mid-body =", !!aborted.d2);
  // AbortSignal.timeout
  const s = ms();
  try { await fetch(`${base}/slow-headers?s=1&key=d3`, { signal: AbortSignal.timeout(200) }); }
  catch (e) { console.log(`RESULT D AbortSignal.timeout(200): ${(e as Error).name} after ${ms() - s}ms`); }
}

// E. server idleTimeout (3 s): a response stream silent for 5 s, and a handler that takes 5 s before headers
{
  const s = ms();
  const r = await fetch(`${base}/silent?s=5&key=e1`);
  const reader = r.body!.getReader();
  const parts: string[] = [];
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(dec.decode(value).trim()); }
    console.log(`RESULT E1 silent-5s stream under idleTimeout=3: got ${JSON.stringify(parts)} after ${ms() - s}ms (no error)`);
  }
  catch (e) { console.log(`RESULT E1 silent-5s stream under idleTimeout=3: got ${JSON.stringify(parts)} then ${(e as Error).name}: ${(e as Error).message} after ${ms() - s}ms`); }
  const s2 = ms();
  try {
    const r2 = await fetch(`${base}/slow-headers?s=5&key=e2`);
    console.log(`RESULT E2 5s-before-headers under idleTimeout=3: status ${r2.status} "${await r2.text()}" after ${ms() - s2}ms`);
  }
  catch (e) { console.log(`RESULT E2 5s-before-headers under idleTimeout=3: ${(e as Error).name}: ${(e as Error).message} after ${ms() - s2}ms`); }
  const s3 = ms();
  try {
    const r3 = await fetch(`${base}/timeout-override`);
    console.log(`RESULT E3 server.timeout(req,0) then 4.5s: status ${r3.status} "${await r3.text()}" after ${ms() - s3}ms`);
  }
  catch (e) { console.log(`RESULT E3 server.timeout(req,0): ${(e as Error).name}: ${(e as Error).message} after ${ms() - s3}ms`); }
}

// F. keep-alive: is the client's source port reused across sequential fetches?
{
  const ports: string[] = [];
  for (let i = 0; i < 5; i++) ports.push(await (await fetch(`${base}/peer`)).text());
  console.log("RESULT F client source ports over 5 sequential fetches:", ports, "distinct:", new Set(ports).size);
  const ports2: string[] = [];
  for (let i = 0; i < 3; i++) ports2.push(await (await fetch(`${base}/peer`, { keepalive: false } as RequestInit)).text());
  console.log("RESULT F2 with keepalive:false:", ports2, "distinct:", new Set(ports2).size);
}

// G. large response, backpressure-free read
{
  const s = ms();
  const buf = await (await fetch(`${base}/big`)).arrayBuffer();
  console.log(`RESULT G 8 MiB response: ${buf.byteLength} bytes in ${ms() - s}ms`);
}

console.log("server log:", serverLog);
server.stop(true);
