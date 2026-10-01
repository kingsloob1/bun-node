// Spike: RT §5.7's buffering probe, end to end on Bun 1.4.3.
//
// An executor (Bun.serve) answers a canary with an SSE stream: an immediate
// ": open" comment (RT §7.3's first-frame rule), then three `progress` events
// 100 ms apart, then `result`. A gateway (fetch + a hand-written SSE reader)
// records when each event ARRIVES. Measured through four paths:
//   direct      gateway -> executor
//   passthrough gateway -> Bun.serve proxy that returns `fetch(upstream)` as is
//   piped       gateway -> Bun.serve proxy that re-streams the body chunk by chunk
//   buffering   gateway -> Bun.serve proxy that reads the whole body, then answers
//   blocks64k   gateway -> proxy that forwards only in 64 KiB blocks (App Engine flex)
// The probe's rule: if progress events arrive within 20 ms of each other and of
// the result, the path buffers. Prints RESULT lines. Run: bun sse-canary-probe.ts
const STEP = 100;
const exec = Bun.serve({
  port: 0,
  idleTimeout: 30,
  fetch(req, server) {
    server.timeout(req, 0);
    const stream = new ReadableStream({
      async start(c) {
        const e = new TextEncoder();
        c.enqueue(e.encode(": open\n\n"));
        for (let i = 1; i <= 3; i++) {
          await Bun.sleep(STEP);
          c.enqueue(e.encode(`id: ${i}\nevent: progress\ndata: BJ1 ${i} 0 mac {"op":"progress","pseq":${i},"at":${Date.now()}}\n\n`));
        }
        c.enqueue(e.encode(`id: 4\nevent: result\ndata: BJ1 4 0 mac {"op":"result","at":${Date.now()}}\n\n`));
        c.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
    });
  },
});
const up = `http://127.0.0.1:${exec.port}/`;

const passthrough = Bun.serve({ port: 0, fetch: () => fetch(up) });
const piped = Bun.serve({
  port: 0,
  async fetch() {
    const r = await fetch(up);
    const reader = r.body!.getReader();
    return new Response(new ReadableStream({
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) c.close(); else c.enqueue(value);
      },
    }), { headers: r.headers });
  },
});
const buffering = Bun.serve({
  port: 0,
  async fetch() {
    const r = await fetch(up);
    const body = await r.arrayBuffer();
    return new Response(body, { headers: r.headers });
  },
});
const blocks64k = Bun.serve({
  port: 0,
  async fetch() {
    const r = await fetch(up);
    const reader = r.body!.getReader();
    let held: Uint8Array[] = [];
    let size = 0;
    return new Response(new ReadableStream({
      async pull(c) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { for (const h of held) c.enqueue(h); c.close(); return; }
          held.push(value); size += value.byteLength;
          if (size >= 65536) { for (const h of held) c.enqueue(h); held = []; size = 0; return; }
        }
      },
    }), { headers: r.headers });
  },
});

async function probe(name: string, port: number) {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/event-stream" } });
  const headersAt = performance.now() - t0;
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const arrivals: { ev: string; at: number }[] = [];
  let firstByteAt = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteAt < 0) firstByteAt = performance.now() - t0;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      if (ev) arrivals.push({ ev, at: performance.now() - t0 });
    }
  }
  const prog = arrivals.filter((a) => a.ev === "progress").map((a) => a.at);
  const result = arrivals.find((a) => a.ev === "result")!.at;
  const gaps = prog.slice(1).map((p, i) => p - prog[i]);
  const spread = result - prog[0];
  const buffered = Math.max(...gaps) < 20 && spread < 20;
  console.log(`RESULT ${name}: headers ${headersAt.toFixed(0)} ms, first byte ${firstByteAt.toFixed(0)} ms, progress at ${prog.map((p) => p.toFixed(0)).join("/")} ms, result ${result.toFixed(0)} ms, gaps ${gaps.map((g) => g.toFixed(0)).join("/")} ms -> probe says ${buffered ? "BUFFERED" : "streams"}`);
}

for (let run = 1; run <= 2; run++) {
  await probe(`direct#${run}`, exec.port);
  await probe(`passthrough#${run}`, passthrough.port);
  await probe(`piped#${run}`, piped.port);
  await probe(`buffering#${run}`, buffering.port);
  await probe(`blocks64k#${run}`, blocks64k.port);
}
for (const s of [exec, passthrough, piped, buffering, blocks64k]) s.stop(true);
console.log(`RESULT env: bun ${Bun.revision}`);
