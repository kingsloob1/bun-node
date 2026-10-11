// Spike: WebSocket backpressure with protocol-sized frames, both directions,
// on Bun 1.4.3. Complements bun-transports.md §3.6–§3.8 (1 MiB frames).
//
// A. Server -> paused client. ~200 B text frames (a heartbeat or progress
//    frame) sent in a loop until send() returns 0, with backpressureLimit
//    1 MiB and closeOnBackpressureLimit false. Records how many were sent (>0),
//    queued (-1) and dropped (0), getBufferedAmount() at the first -1 and the
//    first 0, whether `drain` fires after the client resumes, and how many
//    frames the client finally received.
// B. Client -> server whose event loop is blocked (a child process that
//    busy-waits 1500 ms on request). The client sends 4,000 x 1 KiB frames and
//    polls `bufferedAmount` every 10 ms: is it a usable drain signal for an
//    executor that dials out (ws-reverse, where the executor is the client)?
// Prints RESULT lines. Run: bun ws-backpressure.ts
import { spawn } from "bun";

// ---- A ----------------------------------------------------------------------
{
  let sent = 0, queued = 0, dropped = 0, firstQueuedBuf = -1, firstDropBuf = -1, drains = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const frame = `BJ1 1 0 ${"m".repeat(43)} ${JSON.stringify({ op: "heartbeat", running: [{ job: "01JB7Q2M8ZRT9V", attempt: 1, since: 1790000000470 }], capacity: { inFlight: 1, max: 8, accepting: true }, at: 1790000010470 })}`;
  const server = Bun.serve({
    port: 0,
    fetch(req, s) { return s.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: false,
      open(ws) {
        // Give the client a moment to pause.
        setTimeout(() => {
          for (let i = 0; i < 200_000; i++) {
            const r = ws.send(frame);
            if (r > 0) sent++;
            else if (r === -1) { if (queued === 0) firstQueuedBuf = ws.getBufferedAmount(); queued++; }
            else { if (dropped === 0) firstDropBuf = ws.getBufferedAmount(); dropped++; if (dropped >= 10) break; }
          }
          console.log(`RESULT A send loop: frame ${frame.length} B, sent ${sent}, queued(-1) ${queued}, dropped(0) ${dropped} (stopped after 10), buffered at first -1 ${firstQueuedBuf} B, at first 0 ${firstDropBuf} B`);
          // An "END" sent now would itself be dropped (send() returns 0), so
          // the count is read on a timer after the client resumes instead.
          setTimeout(resolveDone, 2500);
        }, 100);
      },
      drain() { drains++; },
      message() {},
    },
  });
  let received = 0;
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  client.onopen = () => {
    (client as unknown as { pause(): void }).pause();
    setTimeout(() => (client as unknown as { resume(): void }).resume(), 1500);
  };
  client.onmessage = () => {
    received++;
  };
  await done;
  console.log(`RESULT A after resume: client received ${received} of ${sent + queued + dropped} send() calls (sent+queued = ${sent + queued}); drain events ${drains}; lost ${sent + queued - received} of the sent+queued`);
  client.close();
  server.stop(true);
}

// ---- B ----------------------------------------------------------------------
{
  const child = spawn({
    cmd: ["bun", "-e", `
      let got = 0;
      const s = Bun.serve({ port: 0, fetch(r, s) { return s.upgrade(r) ? undefined : new Response("no"); },
        websocket: { maxPayloadLength: 16 * 1024 * 1024, message(ws, m) {
          if (m === "BLOCK") { const t = Date.now(); while (Date.now() - t < 1500) {} ws.send("UNBLOCKED " + Date.now()); return; }
          got++; if (got === 4000) ws.send("GOT-ALL " + Date.now());
        } } });
      console.log(s.port);
    `],
    stdout: "pipe",
  });
  const reader = child.stdout.getReader();
  const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise((r) => (ws.onopen = r));
  const samples: string[] = [];
  let unblockedAt = 0, gotAllAt = 0;
  ws.onmessage = (e) => {
    const [tag, at] = String(e.data).split(" ");
    if (tag === "UNBLOCKED") unblockedAt = Number(at);
    if (tag === "GOT-ALL") gotAllAt = Number(at);
  };
  ws.send("BLOCK");
  await Bun.sleep(50);
  const payload = "p".repeat(1024);
  const t0 = Date.now();
  for (let i = 0; i < 4000; i++) ws.send(payload);
  const afterSend = ws.bufferedAmount;
  let zeroAt = 0;
  const poll = setInterval(() => {
    const b = ws.bufferedAmount;
    samples.push(`${Date.now() - t0}:${b}`);
    if (b === 0 && zeroAt === 0) zeroAt = Date.now();
  }, 10);
  while (gotAllAt === 0 && Date.now() - t0 < 10_000) await Bun.sleep(10);
  await Bun.sleep(50);
  clearInterval(poll);
  const thinned = samples.filter((_, i) => i % 15 === 0).join(" ");
  console.log(`RESULT B bufferedAmount right after 4,000 x 1 KiB sends: ${afterSend} B`);
  console.log(`RESULT B samples (ms:bytes, every 150 ms): ${thinned}`);
  console.log(`RESULT B server unblocked at +${unblockedAt - t0} ms; client bufferedAmount reached 0 at +${zeroAt ? zeroAt - t0 : -1} ms; server had all 4,000 at +${gotAllAt - t0} ms`);
  ws.close();
  child.kill();
}
console.log(`RESULT env: bun ${Bun.revision}`);
process.exit(0);
