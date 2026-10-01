/**
 * N raw-TCP SSE clients in one process, for perf.ts. Raw sockets rather than
 * `fetch`, which queues past 256 concurrent requests per process.
 *
 *   bun perf-clients.ts <port> <clients> <eventsEach>
 *
 * Opens every stream, waits for each to receive its first body bytes, reads
 * `/mem` (N idle streams), POSTs `/go?m=`, waits until every client has
 * counted `eventsEach` more blank-line terminators, reads `/mem` again, and
 * prints one JSON line.
 */
const [port, n, m] = process.argv.slice(2).map(Number);
const base = `http://127.0.0.1:${port}`;

interface C {
  pairs: number;
  last: number;
  ready: boolean;
  target: number;
  done: boolean;
}
const clients: C[] = [];
let readyCount = 0;
let doneCount = 0;
let onReady: () => void = () => {};
let onDone: () => void = () => {};

const t0 = performance.now();
await Promise.all(Array.from({ length: n }, async () => {
  const c: C = { pairs: 0, last: 0, ready: false, target: Infinity, done: false };
  clients.push(c);
  await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(s) {
        s.write("GET /e HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n");
      },
      data(_s, buf) {
        let prev = c.last;
        let pairs = 0;
        for (let i = 0; i < buf.length; i++) {
          const b = buf[i];
          if (b === 10 && prev === 10) pairs++;
          prev = b;
        }
        c.last = prev;
        c.pairs += pairs;
        if (!c.ready) {
          // Headers end in CRLFCRLF; the first body chunk is ": ok\n\n" (or Nest's "\n").
          c.ready = true;
          if (++readyCount === n) onReady();
        }
        if (!c.done && c.pairs >= c.target) {
          c.done = true;
          if (++doneCount === n) onDone();
        }
      },
    },
  });
}));
if (readyCount < n) await new Promise<void>((r) => (onReady = r));
// Let late first chunks (Nest's deferred header commit) land.
await Bun.sleep(200);
const connectMs = performance.now() - t0;
const memIdle = Number(await (await fetch(`${base}/mem`)).text());
for (const c of clients) c.target = c.pairs + m;
const allDone = new Promise<void>((r) => (onDone = r));
const g0 = performance.now();
const go = fetch(`${base}/go?m=${m}`, { method: "POST" });
await allDone;
const deliverMs = performance.now() - g0;
await go;
const memAfter = Number(await (await fetch(`${base}/mem`)).text());
console.log(JSON.stringify({ n, m, connectMs: Math.round(connectMs), deliverMs: Math.round(deliverMs), eventsPerSec: Math.round((n * m) / (deliverMs / 1000)), memIdle, memAfter }));
process.exit(0);
