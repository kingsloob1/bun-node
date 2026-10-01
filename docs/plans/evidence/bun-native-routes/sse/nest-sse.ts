/**
 * The key feasibility question: does NestJS's own `@Sse()` work on bun-nest's
 * BunHttpAdapter today, served and socket-free, and what happens at its
 * edges (errors before and after the first event, disconnect, app.close(),
 * Last-Event-ID, an imperative `@Res()` stream)?
 *
 *   bun docs/plans/evidence/bun-native-routes/sse/nest-sse.ts
 */
import type { INestApplication, MessageEvent } from "@nestjs/common";
import type { BunResponse } from "@kingsleyweb/bun-common";
import { Controller, Get, Headers, Module, Res, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { concat, interval, map, Observable, of, take, throwError, timer } from "rxjs";
import { log, ms, readEvents, show } from "./lib";
import "reflect-metadata";

const teardown: string[] = [];
let t0 = 0;

@Controller()
class C {
  @Sse("ticks")
  ticks(): Observable<MessageEvent> {
    return interval(200).pipe(take(3), map((n) => ({ data: { n }, type: "tick" })));
  }

  @Sse("multiline")
  multiline(): Observable<MessageEvent> {
    return of({ data: "a\nb\r\nc", id: "7", retry: 1500 }, { data: "" }, { data: 0 } as unknown as MessageEvent);
  }

  @Sse("err-before")
  errBefore(): Observable<MessageEvent> {
    return throwError(() => new Error("before"));
  }

  @Sse("err-after")
  errAfter(): Observable<MessageEvent> {
    return concat(of({ data: "e1" }), timer(50).pipe(map(() => { throw new Error("after"); })));
  }

  @Sse("throws")
  throws(): Observable<MessageEvent> {
    throw new Error("sync");
  }

  @Sse("endless")
  endless(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sub) => {
      let n = 0;
      const t = setInterval(() => sub.next({ data: `n${++n}` }), 100);
      return () => {
        clearInterval(t);
        teardown.push(`unsubscribed@${ms(t0)}`);
      };
    });
  }

  @Sse("resume")
  resume(@Headers("last-event-id") last: string | undefined): Observable<MessageEvent> {
    return of({ data: `from ${last}` });
  }

  @Get("imperative")
  imperative(@Res() res: BunResponse): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(": open\n\n");
    let n = 0;
    const t = setInterval(() => {
      res.write(`data: i${++n}\n\n`);
      if (n === 3) {
        clearInterval(t);
        void res.end();
      }
    }, 200);
  }
}

@Module({ controllers: [C] })
class M {}

async function app(): Promise<{ app: INestApplication; url: string }> {
  const a = await NestFactory.create(M, new BunHttpAdapter(), { logger: false });
  await a.listen(0, "127.0.0.1");
  return { app: a, url: await a.getUrl() };
}

const { app: served, url } = await app();
async function get(path: string, init?: RequestInit, timeoutMs = 2000): Promise<string> {
  t0 = performance.now();
  try {
    const res = await fetch(url + path, init);
    const h = ms(t0);
    const out = await readEvents(res.body, t0, { timeoutMs });
    return `status=${res.status} type=${res.headers.get("content-type")} headers@${h}ms ${show(out)}`;
  } catch (error) {
    return `fetch failed @${ms(t0)}ms: ${(error as Error).message.slice(0, 50)}`;
  }
}

log("N1 served @Sse, 3 events 200ms apart", await get("/ticks"));
{
  t0 = performance.now();
  const res = await fetch(`${url}/ticks`);
  log("N1 … headers", JSON.stringify(Object.fromEntries(res.headers)));
  await res.body?.cancel();
}
log("N2 multiline data, id, retry, empty and 0 data", await get("/multiline"));
log("N3 observable errors before first event", await get("/err-before"));
log("N4 observable errors after one event", await get("/err-after"));
log("N5 controller throws synchronously", await get("/throws"));
log("N6 Last-Event-ID via @Headers()", await get("/resume", { headers: { "last-event-id": "41" } }));
log("N7 @Res() imperative stream", await get("/imperative"));

// N8 client disconnect
{
  teardown.length = 0;
  const ac = new AbortController();
  t0 = performance.now();
  const res = await fetch(`${url}/endless`, { signal: ac.signal });
  const out = await readEvents(res.body, t0, { max: 2 });
  ac.abort();
  await Bun.sleep(300);
  log("N8 client aborts after 2 events", `${show(out)} server: ${teardown.join(",") || "still subscribed"}`);
}

// N9 app.close() with a stream open
{
  teardown.length = 0;
  t0 = performance.now();
  const res = await fetch(`${url}/endless`);
  const reading = readEvents(res.body, t0, { timeoutMs: 3000 });
  await Bun.sleep(250);
  const at = ms(t0);
  const c0 = performance.now();
  await served.close();
  const took = ms(c0);
  const out = await reading;
  await Bun.sleep(200);
  log("N9 app.close() with a stream open", `${show(out)} close()@${at}ms took ${took}ms; server: ${teardown.join(",") || "still subscribed"}`);
}

// N10 socket-free: app.init() and the adapter's fetch()
{
  const adapter = new BunHttpAdapter();
  const a = await NestFactory.create(M, adapter, { logger: false });
  await a.init();
  t0 = performance.now();
  const res = await adapter.fetch("/ticks");
  const h = ms(t0);
  log("N10 adapter.fetch() (no socket), @Sse ticks", `status=${res.status} headers@${h}ms ${show(await readEvents(res.body, t0))}`);
  t0 = performance.now();
  const res2 = await adapter.fetch("/imperative");
  const h2 = ms(t0);
  log("N10 adapter.fetch() (no socket), @Res() stream", `status=${res2.status} headers@${h2}ms ${show(await readEvents(res2.body, t0))}`);
  await a.close();
}
process.exit(0);
