// S6: a client that holds an SSE response without reading it: when does the server see the request end?
const rounds = Number(process.argv[2] ?? 3);
const abortFirst = process.argv[3] !== "noabort";
for (let round = 0; round < rounds; round++) {
  let cancelledAt = -1;
  const t0 = performance.now();
  const S = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
    let t: Timer;
    return new Response(new ReadableStream({
      start(c) { t = setInterval(() => { try { c.enqueue(new TextEncoder().encode("data: x\n\n")); } catch {} }, 50); },
      cancel() { clearInterval(t); cancelledAt = Math.round(performance.now() - t0); },
    }), { headers: { "content-type": "text/event-stream" } });
  } });
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${S.port}/`, { signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read();
  await Bun.sleep(1500);
  console.log(JSON.stringify({ bun: Bun.revision.slice(0, 9), round, pendingAfter1500: S.pendingRequests, serverCancelledAtMs: cancelledAt }));
  if (abortFirst) ac.abort();
  await S.stop(true);
}
