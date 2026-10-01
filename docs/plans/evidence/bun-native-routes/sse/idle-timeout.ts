/**
 * Bun.serve's `idleTimeout` (default 10 s) against a quiet event stream,
 * raw and through both adapters. Every case runs at once on its own server;
 * the whole probe takes ~`WATCH` seconds.
 *
 *   bun docs/plans/evidence/bun-native-routes/sse/idle-timeout.ts [watchSeconds=30]
 *
 * Each stream sends one comment at once (so headers go out; Bun holds them
 * until the first chunk), then only what the case says. A case "survives" if
 * the client's read is still open at the end of the watch.
 */
import type { MessageEvent } from "@nestjs/common";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { Controller, Module, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunHttpAdapter as NestAdapter } from "@kingsleyweb/bun-nest";
import { Observable } from "rxjs";
import { log, ms, readEvents } from "./lib";
import { sse } from "./prototype-sse";
import "reflect-metadata";

const WATCH = Number(process.argv[2] ?? 30) * 1000;
const enc = new TextEncoder();

async function watch(url: string): Promise<string> {
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    const out = await readEvents(res.body, t0, { timeoutMs: WATCH });
    return out.end === "timeout"
      ? `survived ${WATCH / 1000}s (${out.events.length} blocks)`
      : `cut at ${(out.endAt / 1000).toFixed(1)}s: ${out.end.slice(0, 60)} (${out.events.length} blocks)`;
  } catch (error) {
    return `fetch failed at ${(ms(t0) / 1000).toFixed(1)}s: ${(error as Error).message.slice(0, 50)}`;
  }
}

/** Raw Bun.serve, a ReadableStream that sends one comment and then nothing. */
function raw(exempt: boolean): Bun.Server<unknown> {
  return Bun.serve({
    port: 0,
    fetch(req, server) {
      if (exempt) server.timeout(req, 0);
      return new Response(
        new ReadableStream({ start: (c) => c.enqueue(enc.encode(": open\n\n")) }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}

/** bun-common adapter; `mode` picks what keeps (or fails to keep) it alive. */
async function common(mode: "silent" | "heartbeat5" | "heartbeat9" | "exempt" | "socketTimeout0" | "noWrite" | "proto"): Promise<number> {
  const a = new BunHttpAdapter(0, { logger: noopLogger });
  a.get("/e", (req: BunRequest, res: BunResponse) => {
    if (mode === "proto") {
      sse(req, res, { heartbeatMs: 0 }); // the helper exempts the request; no heartbeat
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    if (mode === "noWrite") return; // never answers at all
    if (mode === "exempt") req.server?.timeout(req.request, 0);
    if (mode === "socketTimeout0") req.socket.setTimeout(0); // what Node code (and Nest's SseStream) does
    res.write(": open\n\n");
    if (mode === "heartbeat5" || mode === "heartbeat9") {
      const t = setInterval(() => res.write(": ping\n\n"), mode === "heartbeat5" ? 5000 : 9000);
      res.on("close", () => clearInterval(t));
    }
  });
  const server = await a.listen(0);
  return server.port!;
}

@Controller()
class Quiet {
  @Sse("quiet")
  quiet(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((s) => s.next({ data: "first" })); // one event, then silence
  }
}
@Module({ controllers: [Quiet] })
class M {}

const rawSilent = raw(false);
const rawExempt = raw(true);
const ports = {
  silent: await common("silent"),
  heartbeat5: await common("heartbeat5"),
  heartbeat9: await common("heartbeat9"),
  exempt: await common("exempt"),
  socketTimeout0: await common("socketTimeout0"),
  noWrite: await common("noWrite"),
  proto: await common("proto"),
};
const nest = await NestFactory.create(M, new NestAdapter(), { logger: false });
await nest.listen(0, "127.0.0.1");
const nestUrl = await nest.getUrl();

const results = await Promise.all([
  watch(`http://127.0.0.1:${rawSilent.port}/`),
  watch(`http://127.0.0.1:${rawExempt.port}/`),
  watch(`http://127.0.0.1:${ports.silent}/e`),
  watch(`http://127.0.0.1:${ports.heartbeat5}/e`),
  watch(`http://127.0.0.1:${ports.heartbeat9}/e`),
  watch(`http://127.0.0.1:${ports.exempt}/e`),
  watch(`http://127.0.0.1:${ports.socketTimeout0}/e`),
  watch(`http://127.0.0.1:${ports.noWrite}/e`),
  watch(`${nestUrl}/quiet`),
  watch(`http://127.0.0.1:${ports.proto}/e`),
]);
const labels = [
  "raw Bun.serve, silent after one comment",
  "raw Bun.serve, server.timeout(req, 0)",
  "bun-common adapter, silent after one comment",
  "bun-common adapter, ': ping' every 5 s",
  "bun-common adapter, ': ping' every 9 s",
  "bun-common adapter, req.server.timeout(req.request, 0)",
  "bun-common adapter, req.socket.setTimeout(0) (Node idiom)",
  "bun-common adapter, handler never writes",
  "bun-nest @Sse(), one event then silent",
  "prototype sse() helper, no heartbeat, silent",
];
log(`idleTimeout default (10 s), watched ${WATCH / 1000} s`, "");
labels.forEach((l, i) => log(`  ${l}`, results[i]));
process.exit(0);
