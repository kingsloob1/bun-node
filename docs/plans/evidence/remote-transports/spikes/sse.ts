// SSE spike: serve text/event-stream from Bun.serve, consume it from Bun.
// Run: bun sse.ts
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const sleep = (n: number) => new Promise(r => setTimeout(r, n));

// 1. Is EventSource a runtime global? (bun-types declares one.)
let esResult: string;
try { new (globalThis as any).EventSource("http://127.0.0.1:1/"); esResult = "constructed"; }
catch (e) { esResult = `${(e as Error).name}: ${(e as Error).message}`; }
console.log(`RESULT typeof EventSource = ${typeof (globalThis as any).EventSource}; new EventSource(...) -> ${esResult}`);

const seenLastEventId: (string | null)[] = [];
let cancelled = 0;
let nextId = 1;
const server = Bun.serve({
  port: 0,
  idleTimeout: 2,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/events") {
      srv.timeout(req, 0);
      const last = req.headers.get("last-event-id");
      seenLastEventId.push(last);
      if (last) nextId = Number(last) + 1;
      const conn = seenLastEventId.length;
      return new Response(new ReadableStream({
        async start(c) {
          c.enqueue(`retry: 300\n\n`);
          // three events per connection; the second is split across two writes 100 ms apart
          for (let i = 0; i < 3; i++) {
            const id = nextId++;
            if (i === 1) { c.enqueue(`id: ${id}\nevent: prog`); await sleep(100); c.enqueue(`ress\ndata: {"pct":${id * 10}}\n\n`); }
            else c.enqueue(`id: ${id}\ndata: line one of ${id}\ndata: line two\n\n`);
            await sleep(50);
          }
          if (conn < 2) c.close(); // first connection ends -> client must reconnect with Last-Event-ID
        },
        cancel() { cancelled++; },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    if (url.pathname === "/quiet") {
      // no server.timeout(req,0): an SSE stream that goes quiet for 3 s under idleTimeout=2
      return new Response(new ReadableStream({
        async start(c) { c.enqueue(": open\n\n"); await sleep(3000); try { c.enqueue("data: late\n\n"); c.close(); } catch {} },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("nf", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;

// Minimal WHATWG-conformant-enough SSE parser over fetch(): the thing bun-jobs would have to ship itself.
type Ev = { id?: string; event: string; data: string };
async function* sse(url: string, lastEventId: string | null, signal: AbortSignal): AsyncGenerator<Ev | { retry: number }> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (lastEventId) headers["last-event-id"] = lastEventId;
  const r = await fetch(url, { headers, signal });
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let cur: Ev = { event: "message", data: "" }; let hasData = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let nl: number;
    while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf.startsWith("\r\n", nl) ? 2 : 1));
      if (line === "") { if (hasData) yield { ...cur, data: cur.data.replace(/\n$/, "") }; cur = { event: "message", data: "", id: cur.id }; hasData = false; continue; }
      if (line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const f = i < 0 ? line : line.slice(0, i);
      let v = i < 0 ? "" : line.slice(i + 1); if (v.startsWith(" ")) v = v.slice(1);
      if (f === "data") { cur.data += `${v}\n`; hasData = true; }
      else if (f === "event") cur.event = v;
      else if (f === "id") cur.id = v;
      else if (f === "retry" && /^\d+$/.test(v)) yield { retry: Number(v) };
    }
  }
}

// 2. Consume with reconnect + Last-Event-ID
{
  const ac = new AbortController();
  const got: string[] = [];
  let last: string | null = null; let retry = 3000; let connections = 0;
  outer: while (connections < 3) {
    connections++;
    const start = ms();
    for await (const ev of sse(`${base}/events`, last, ac.signal)) {
      if ("retry" in ev) { retry = ev.retry; continue; }
      got.push(`${ev.id}:${ev.event}:${JSON.stringify(ev.data)}@${ms() - start}`);
      if (ev.id) last = ev.id;
      if (got.length === 6) break outer;
    }
    await sleep(retry);
  }
  ac.abort();
  await sleep(100);
  console.log("RESULT events received:", got);
  console.log("RESULT Last-Event-ID seen by server per connection:", seenLastEventId, "retry applied:", retry);
  console.log("RESULT server stream cancel() called after client abort:", cancelled);
}

// 3. SSE without server.timeout(req, 0) under idleTimeout=2, quiet for 3 s
{
  const s = ms(); const parts: string[] = [];
  try { for await (const ev of sse(`${base}/quiet`, null, new AbortController().signal)) parts.push(JSON.stringify(ev)); console.log(`RESULT quiet SSE: ended cleanly after ${ms() - s}ms, events ${parts}`); }
  catch (e) { console.log(`RESULT quiet SSE (idleTimeout=2, 3s gap): ${(e as Error).message.slice(0, 60)} after ${ms() - s}ms, events ${JSON.stringify(parts)}`); }
}
server.stop(true);
