// S7: S6 with a raw TCP client that never reads after the headers (socket paused): does Bun.serve cancel the stream?
import net from "node:net";
let cancelledAt = -1;
const t0 = performance.now();
const S = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
  let t: Timer;
  return new Response(new ReadableStream({
    start(c) { t = setInterval(() => { try { c.enqueue(new TextEncoder().encode("data: x\n\n")); } catch {} }, 50); },
    cancel() { clearInterval(t); cancelledAt = Math.round(performance.now() - t0); },
  }), { headers: { "content-type": "text/event-stream" } });
} });
const s = net.connect(S.port!, "127.0.0.1");
await new Promise((r) => s.once("connect", r));
s.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
await new Promise((r) => s.once("data", r));
s.pause();
await Bun.sleep(3000);
console.log(JSON.stringify({ bun: Bun.revision.slice(0, 9), pendingAfter3s: S.pendingRequests, serverCancelledAtMs: cancelledAt }));
s.destroy(); S.stop(true);
