// S3: the stale-server hazard that remains on Bun >= 1.4.2: long-lived responses (SSE) and WebSockets.
// design "graceful": close() = stop(false), resolved without waiting (what a graceful-only close does
//   if it must not hang forever on an SSE stream).
// design "drain":    close() = stop(false); wait until pendingRequests == 0 or cap; stop(true).
// design "force":    close() = stop(true) (today).
import { sleep } from "./raw";
const design = process.argv[2] ?? "drain";
const CAP = 1000;
const out: Record<string, unknown> = { bun: Bun.revision, design };
const A = Bun.serve<{ n: number }>({
  port: 0, hostname: "127.0.0.1", reusePort: true,
  fetch(req, server) {
    const p = new URL(req.url).pathname;
    if (p === "/ws" && server.upgrade(req, { data: { n: 0 } })) return undefined;
    if (p === "/sse") {
      let t: Timer;
      return new Response(new ReadableStream({
        start(c) { t = setInterval(() => c.enqueue(new TextEncoder().encode("data: A\n\n")), 50); },
        cancel() { clearInterval(t); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/slow") return sleep(300).then(() => new Response("A slow"));
    return new Response("A");
  },
  websocket: { message(ws, m) { ws.send(`A:${m}`); } },
});
const port = A.port!;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
await new Promise((r) => (ws.onopen = r));
let wsClosed = false; ws.onclose = () => (wsClosed = true);
const sse = await fetch(`http://127.0.0.1:${port}/sse`);
const reader = sse.body!.getReader();
await reader.read();
const slow = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text(), (e) => String(e).slice(0, 40));
await sleep(30);
out.before = { pendingRequests: A.pendingRequests, pendingWebSockets: A.pendingWebSockets };
const t0 = performance.now();
async function close() {
  if (design === "force") return A.stop(true);
  void A.stop(false);
  if (design === "graceful") return;
  const deadline = performance.now() + CAP;
  while (A.pendingRequests > 0 && performance.now() < deadline) await sleep(10);
  out.drainedPending = A.pendingRequests;
  await A.stop(true);
}
await close();
out.closeMs = Math.round(performance.now() - t0);
out.slow = await slow;
// a new server on the same port, as a restarted app or the next test would bind
const B = Bun.serve({ port, hostname: "127.0.0.1", reusePort: true, fetch: () => new Response("B"), websocket: { message(w, m) { w.send(`B:${m}`); } } });
await sleep(50);
// after close() resolved: is the old server still serving anything?
const sseAfter = await (async () => {
  const until = performance.now() + 600;
  let chunks = 0;
  while (performance.now() < until) {
    const r = await Promise.race([reader.read().then((x) => (x.done ? "done" : "chunk"), () => "error"), sleep(200).then(() => "idle")]);
    if (r === "done" || r === "error") return `<ended (${r}) after ${chunks} buffered chunks>`;
    if (r === "chunk") chunks++;
  }
  return `<still flowing: ${chunks} chunks in 600 ms after close()>`;
})();
out.sseAfterClose = sseAfter;
const reply = await new Promise<string>((r) => {
  if (ws.readyState !== WebSocket.OPEN) return r(`<ws ${ws.readyState === 3 ? "closed" : ws.readyState}>`);
  ws.onmessage = (e) => r(String(e.data)); ws.send("ping"); setTimeout(() => r("<no reply>"), 500);
});
out.wsAfterClose = reply;
out.after = { pendingRequests: A.pendingRequests, pendingWebSockets: A.pendingWebSockets, wsClosed };
out.freshAfter = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
console.log(JSON.stringify(out));
try { reader.cancel(); } catch {}
ws.close(); A.stop(true); B.stop(true); process.exit(0);
