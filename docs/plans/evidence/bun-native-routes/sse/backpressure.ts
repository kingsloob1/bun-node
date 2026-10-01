/**
 * A client that connects and then never reads: how much does each way of
 * writing an event stream buffer in the server? Each case runs in its own
 * process; the producer offers up to 64 MiB of 1 KiB events for up to 4 s,
 * yielding a macrotask every 64 events.
 *
 *   bun docs/plans/evidence/bun-native-routes/sse/backpressure.ts
 *
 * The stalled client is a Python socket with a 64 KiB receive buffer that
 * never calls recv(), so the kernel buffers fill and Bun sees backpressure.
 * Every event is a fresh 1 KiB buffer (as distinct events would be), so what
 * is queued is really held.
 */
import type { MessageEvent } from "@nestjs/common";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { Controller, Module, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunHttpAdapter as NestAdapter } from "@kingsleyweb/bun-nest";
import { Observable } from "rxjs";
import { encodeSseEvent, sse } from "./prototype-sse";
import "reflect-metadata";

const CASES = ["raw-push", "raw-pull", "common-write", "proto-await", "proto-nowait", "nest-sse"] as const;
type Case = (typeof CASES)[number];
const LIMIT = 64 * 1024 * 1024;
const SECONDS = 4;
const EVENT = encodeSseEvent({ data: "x".repeat(1016) }); // 1024 bytes
const tick = () => new Promise<void>((r) => setImmediate(r));

const which = process.argv[2] as Case | undefined;
if (!which) {
  console.log(`stalled client; producer offers ${LIMIT / 1048576} MiB of 1 KiB events for ${SECONDS} s`);
  for (const c of CASES) {
    const p = Bun.spawn(["bun", import.meta.path, c], { stdout: "pipe", stderr: "inherit" });
    console.log((await new Response(p.stdout).text()).trim());
  }
  process.exit(0);
}

let produced = 0;
let stoppedBy = "time";
const deadline = () => performance.now() > start + SECONDS * 1000;
let start = 0;
function rss(): number {
  Bun.gc(true);
  return process.memoryUsage().rss;
}

/** Offers events through `write` (which may return a promise to await) until the cap. */
async function produce(write: () => boolean | Promise<boolean>): Promise<void> {
  start = performance.now();
  while (produced < LIMIT && !deadline()) {
    for (let i = 0; i < 64; i++) {
      const r = write();
      const ok = r instanceof Promise ? await Promise.race([r, Bun.sleep(Math.max(0, start + SECONDS * 1000 - performance.now())).then(() => "time" as const)]) : r;
      if (ok === "time") return;
      if (ok === false) {
        stoppedBy = "write() returned false";
        return;
      }
      produced += EVENT.byteLength;
    }
    await tick();
  }
  if (produced >= LIMIT) stoppedBy = "limit";
}

let port = 0;
let ready: () => void;
const started = new Promise<void>((r) => (ready = r));
let done: Promise<void> = Promise.resolve();

if (which === "raw-push" || which === "raw-pull") {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 255,
    fetch() {
      if (which === "raw-push") {
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            ready();
            done = produce(() => {
              c.enqueue(EVENT.slice());
              return true;
            });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      start = performance.now();
      ready();
      // Pull-based: produce only when Bun asks for more.
      return new Response(new ReadableStream<Uint8Array>({
        pull(c) {
          if (produced < LIMIT && !deadline()) {
            c.enqueue(EVENT.slice());
            produced += EVENT.byteLength;
          }
        },
      }, new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 })), { headers: { "content-type": "text/event-stream" } });
    },
  });
  port = server.port!;
  if (which === "raw-pull") done = started.then(() => Bun.sleep(SECONDS * 1000));
} else if (which === "nest-sse") {
  @Controller()
  class C {
    @Sse("e")
    e(): Observable<MessageEvent> {
      return new Observable<MessageEvent>((sub) => {
        ready();
        const text = "x".repeat(1016);
        done = produce(() => {
          sub.next({ data: text });
          return true;
        });
      });
    }
  }
  @Module({ controllers: [C] })
  class M {}
  const app = await NestFactory.create(M, new NestAdapter(0, { server: { idleTimeout: 255 } }), { logger: false });
  await app.listen(0, "127.0.0.1");
  port = Number(new URL(await app.getUrl()).port);
} else {
  const a = new BunHttpAdapter(0, { logger: noopLogger, server: { idleTimeout: 255 } });
  a.get("/e", (req: BunRequest, res: BunResponse) => {
    ready();
    if (which === "common-write") {
      res.setHeader("Content-Type", "text/event-stream");
      done = produce(() => res.write(EVENT.slice()));
      return;
    }
    const s = sse(req, res, { heartbeatMs: 0, maxQueuedBytes: which === "proto-nowait" ? 8 * 1024 * 1024 : Infinity });
    done = which === "proto-await"
      ? produce(() => s.send(EVENT.slice()))
      : produce(() => {
          void s.send(EVENT.slice());
          return !s.closed;
        });
  });
  port = (await a.listen(0)).port!;
}

const before = rss();
const client = Bun.spawn(["python3", "-c", `
import socket, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
s.connect(("127.0.0.1", ${port}))
s.send(b"GET /e HTTP/1.1\\r\\nHost: x\\r\\nAccept: text/event-stream\\r\\n\\r\\n")
time.sleep(${SECONDS + 4})
`]);
await started;
await done;
await Bun.sleep(300);
const after = rss();
console.log(`${which.padEnd(13)} offered ${(produced / 1048576).toFixed(1).padStart(5)} MiB, stopped by ${stoppedBy.padEnd(22)} server RSS +${((after - before) / 1048576).toFixed(1)} MiB`);
client.kill();
process.exit(0);
