/**
 * One SSE fan-out server per process, for perf.ts. Every target serves:
 *
 *   GET  /e     an event stream (one ": ok" comment at once, then broadcasts)
 *   POST /go?m= broadcast m events to every open stream, 100 per stream per
 *               macrotask, then answer
 *   GET  /mem   RSS after a full GC, bytes
 *
 *   bun perf-server.ts <raw|raw-hwm|raw-direct|common-write|common-proto|nest-sse>
 *
 * `raw-hwm` is `raw` with the prototype's queuing strategy (64 KiB of bytes
 * rather than the default one chunk), to isolate that difference.
 *
 * Prints `PORT <n>` once listening.
 */
import type { MessageEvent } from "@nestjs/common";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { Controller, Get, HttpCode, Module, Post, Query, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunHttpAdapter as NestAdapter } from "@kingsleyweb/bun-nest";
import { map, Subject } from "rxjs";
import { encodeSseEvent, sse } from "./prototype-sse";
import "reflect-metadata";

const target = process.argv[2] ?? "raw";
const PAYLOAD = "x".repeat(50);
const EVENT = encodeSseEvent({ data: PAYLOAD }); // 58 bytes
const OPEN = encodeSseEvent({ comment: "ok" });
const sinks = new Set<(b: Uint8Array) => void>();
const tick = () => new Promise<void>((r) => setImmediate(r));

async function broadcast(m: number, each: (b: Uint8Array) => void = (b) => sinks.forEach((s) => s(b))): Promise<void> {
  for (let sent = 0; sent < m; sent += 100) {
    const n = Math.min(100, m - sent);
    for (let i = 0; i < n; i++) each(EVENT);
    await tick();
  }
}
function mem(): number {
  Bun.gc(true);
  return process.memoryUsage().rss;
}

if (target === "raw" || target === "raw-hwm" || target === "raw-direct") {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/mem") return new Response(String(mem()));
      if (url.pathname === "/go") {
        await broadcast(Number(url.searchParams.get("m")));
        return new Response("ok");
      }
      srv.timeout(req, 0);
      const headers = { "content-type": "text/event-stream", "cache-control": "no-cache" };
      if (target === "raw" || target === "raw-hwm") {
        let sink: (b: Uint8Array) => void;
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(OPEN);
            sink = (b) => c.enqueue(b);
            sinks.add(sink);
          },
          cancel() {
            sinks.delete(sink);
          },
        }, target === "raw-hwm" ? new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }) : undefined), { headers });
      }
      return new Response(new ReadableStream({
        type: "direct",
        async pull(c) {
          c.write(OPEN);
          c.flush();
          let pending = false;
          const sink = (b: Uint8Array) => {
            c.write(b);
            if (!pending) {
              pending = true;
              queueMicrotask(() => {
                pending = false;
                c.flush();
              });
            }
          };
          sinks.add(sink);
          await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
          sinks.delete(sink);
        },
      } as unknown as UnderlyingDefaultSource<Uint8Array>), { headers });
    },
  });
  console.log(`PORT ${server.port}`);
} else if (target === "common-write" || target === "common-proto") {
  const a = new BunHttpAdapter(0, { logger: noopLogger, server: { idleTimeout: 255 } });
  a.get("/mem", (_q, res) => res.send(String(mem())));
  a.post("/go", async (req, res) => {
    await broadcast(Number(req.query.m));
    res.send("ok");
  });
  a.get("/e", (req: BunRequest, res: BunResponse) => {
    if (target === "common-write") {
      req.server?.timeout(req.request, 0);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.write(OPEN);
      const sink = (b: Uint8Array) => void res.write(b);
      sinks.add(sink);
      res.on("close", () => sinks.delete(sink));
      return;
    }
    const s = sse(req, res, { heartbeatMs: 0 });
    const sink = (b: Uint8Array) => void s.send(b);
    sinks.add(sink);
    s.onClose(() => sinks.delete(sink));
  });
  const server = await a.listen(0);
  console.log(`PORT ${server.port}`);
} else if (target === "nest-sse") {
  const subject = new Subject<string>();
  @Controller()
  class C {
    @Get("mem")
    mem(): string {
      return String(mem());
    }

    @Post("go")
    @HttpCode(200)
    async go(@Query("m") m: string): Promise<string> {
      await broadcast(Number(m), () => subject.next(PAYLOAD));
      return "ok";
    }

    @Sse("e")
    e() {
      return subject.pipe(map((data): MessageEvent => ({ data })));
    }
  }
  @Module({ controllers: [C] })
  class M {}
  const adapter = new NestAdapter(0, { server: { idleTimeout: 255 } });
  const app = await NestFactory.create(M, adapter, { logger: false });
  await app.listen(0, "127.0.0.1");
  console.log(`PORT ${new URL(await app.getUrl()).port}`);
} else {
  throw new Error(`unknown target ${target}`);
}
