/**
 * Proves the two bun-common fixes PR-sse2 proposes make NestJS's `@Sse()`
 * whole, by patching them in at runtime (no library change) and re-running
 * the failing cases of nest-sse.ts and idle-timeout.ts:
 *
 *   1. `BunResponse.headersSent` stops counting `req.socket.setKeepAlive(true)`
 *      as "headers sent" (SseStream's constructor calls it, so an exception
 *      filter's 500 was dropped and the request hung).
 *   2. `req.socket.setTimeout(0)` exempts the request from Bun's idleTimeout
 *      via `server.timeout(request, 0)`, as it disables the socket timeout on
 *      Node (SseStream calls it; today it is a no-op and quiet streams die).
 *
 *   bun docs/plans/evidence/bun-native-routes/sse/nest-fixes.ts [--no-patch]
 *
 * `--no-patch` is the negative control: the same cases, unpatched. The
 * patch itself is `fixes-preload.ts`, which also runs both packages' suites:
 *
 *   (cd packages/bun-common && bun test --preload ../../docs/plans/evidence/bun-native-routes/sse/fixes-preload.ts)
 */
import type { MessageEvent } from "@nestjs/common";
import { Controller, Module, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Observable, throwError } from "rxjs";
import { log, ms, readEvents, show } from "./lib";
import "reflect-metadata";

const patch = !process.argv.includes("--no-patch");
const WATCH = 16_000;

if (patch) {
  await import("./fixes-preload");
}

@Controller()
class C {
  @Sse("err-before")
  errBefore(): Observable<MessageEvent> {
    return throwError(() => new Error("before"));
  }

  @Sse("throws")
  throws(): Observable<MessageEvent> {
    throw new Error("sync");
  }

  @Sse("quiet")
  quiet(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((s) => s.next({ data: "first" }));
  }
}
@Module({ controllers: [C] })
class M {}

const app = await NestFactory.create(M, new BunHttpAdapter(), { logger: false });
await app.listen(0, "127.0.0.1");
const url = await app.getUrl();

async function get(path: string, timeoutMs: number): Promise<string> {
  const t0 = performance.now();
  try {
    const res = await Promise.race([fetch(url + path), Bun.sleep(timeoutMs).then(() => undefined)]);
    if (!res) return `no response within ${timeoutMs / 1000}s`;
    const out = await readEvents(res.body, t0, { timeoutMs });
    return `status=${res.status} type=${res.headers.get("content-type")} @${ms(t0)}ms ${out.end === "timeout" ? `still open after ${timeoutMs / 1000}s` : show(out)}`;
  } catch (error) {
    return `failed @${(ms(t0) / 1000).toFixed(1)}s: ${(error as Error).message.slice(0, 50)}`;
  }
}

log(`patched=${patch}`, "");
const results = await Promise.all([get("/err-before", 3000), get("/throws", 3000), get("/quiet", WATCH)]);
log("  @Sse observable errors before first event", results[0]);
log("  @Sse handler throws synchronously", results[1]);
log(`  @Sse one event then silent, watched ${WATCH / 1000}s`, results[2]);
await app.close();
process.exit(0);
