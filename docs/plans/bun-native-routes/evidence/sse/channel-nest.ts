/**
 * The channel paired with NestJS's `@Sse()`: an Observable view of a channel
 * (`channelObservable`, which would live in bun-nest: rxjs is Nest's), on
 * bun-nest's BunHttpAdapter and on ExpressAdapter. `@SseSignal()` is used
 * where the installed Nest has it (11.2.7 and 12.1.3 do; 11.1.27 does not).
 *
 * Run from a directory holding a copy of this file, channel-prototype.ts,
 * prototype-sse.ts and lib.ts, a `node_modules` symlink to the Nest version's
 * install, and a tsconfig.json with `experimentalDecorators` and
 * `emitDecoratorMetadata` (Bun reads them from the cwd): channel-README.md.
 *
 *   bun channel-nest.ts
 */
import "reflect-metadata";
import type { MessageEvent } from "@nestjs/common";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { SseChannel, SseSubscribeOptions } from "./channel-prototype";
import type { SseMessage } from "./prototype-sse";
import { Writable } from "node:stream";
import * as common from "@nestjs/common";
import { Controller, Get, Headers, Module, Req, Res, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { concatMap, map, Observable } from "rxjs";
import { createSseChannel } from "./channel-prototype";
import { log, readEvents, show } from "./lib";

const NEST = (await import("@nestjs/core/package.json")).version as string;
const SseSignalExport = (common as unknown as Record<string, unknown>).SseSignal as (() => ParameterDecorator) | undefined;
const SseSignalOrNone: () => ParameterDecorator = SseSignalExport ?? (() => () => {});
/** The negative control: `CHANNEL_NEST_CONTROL=leak` drops both unsubscribe paths, so C2 must report `size 1`. */
const LEAK = process.env.CHANNEL_NEST_CONTROL === "leak";

/** A channel message as Nest's `MessageEvent` (`event` is Nest's `type`). */
export function toMessageEvent(m: SseMessage): MessageEvent {
  return { data: (m.data ?? "") as MessageEvent["data"], type: m.event, id: m.id === undefined ? undefined : String(m.id), retry: m.retry };
}

/**
 * An `Observable` of a channel's events for `@Sse()`: initial state or
 * replay first, then live events. Nest unsubscribes it when the client goes;
 * `signal` (`@SseSignal()`) is a second path, and `channel.close()` completes it.
 */
export function channelObservable(
  channel: SseChannel,
  opts: SseSubscribeOptions & { signal?: AbortSignal; onSubscribe?: () => void; onTeardown?: (why: string) => void } = {},
): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    if (opts.signal?.aborted) return subscriber.complete();
    const sub = channel.listen((m) => subscriber.next(toMessageEvent(m)), { ...opts, onEnd: () => subscriber.complete() });
    let why = "unsubscribed by Nest";
    const onAbort = (): void => {
      why = "SseSignal abort";
      if (!LEAK) sub.unsubscribe();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    opts.onSubscribe?.();
    return () => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (!LEAK) sub.unsubscribe();
      opts.onTeardown?.(why);
    };
  });
}

const channel = createSseChannel({ heartbeatMs: 0, replay: 10, idPrefix: "e", initial: [{ event: "init", data: "snapshot" }] });
let subscribed = Promise.withResolvers<void>();
let torn = Promise.withResolvers<string>();
const seen = { aborts: 0, socket: "" };

@Controller()
class C {
  @Sse("events")
  events(@Headers("last-event-id") last: string | undefined, @Req() req: { socket?: NodeJS.EventEmitter & { destroyed?: boolean } }, @SseSignalOrNone() signal?: AbortSignal): Observable<MessageEvent> {
    const s = req.socket;
    const before = `once:${typeof s?.once} destroyed-before:${s?.destroyed}`;
    s?.once("close", () => (seen.socket = `${before} close-fired destroyed-at-close:${s.destroyed}`));
    signal?.addEventListener("abort", () => seen.aborts++);
    return channelObservable(channel, { lastEventId: last, signal, onSubscribe: () => subscribed.resolve(), onTeardown: (w) => torn.resolve(w) });
  }

  /** bun-nest only: `@Res()` is a BunResponse, so the channel's own byte path (encode once) applies. */
  @Get("bytes")
  bytes(@Req() req: BunRequest, @Res() res: BunResponse): void {
    const sub = channel.subscribe(req, res);
    subscribed.resolve();
    sub?.writer?.onClose(() => queueMicrotask(() => torn.resolve("writer closed")));
  }

  @Get("size")
  size(): { size: number } {
    return { size: channel.size };
  }
}
@Module({ controllers: [C] })
class M {}

const read = async (res: Response, max: number) => show(await readEvents(res.body, performance.now(), { max, timeoutMs: 1500 })).replace(/\d+ms:/g, "");
const fresh = () => {
  subscribed = Promise.withResolvers<void>();
  torn = Promise.withResolvers<string>();
};

console.log(`Nest ${NEST}; @SseSignal ${SseSignalExport ? "exported" : "NOT exported"}; bun ${Bun.revision}${LEAK ? "; CONTROL: both unsubscribe paths removed" : ""}`);
for (const kind of ["bun", "express"] as const) {
  const app = await NestFactory.create(M, (kind === "express" ? new ExpressAdapter() : new BunHttpAdapter()) as never, { logger: false });
  await app.listen(0, "127.0.0.1");
  const url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  const tag = `${NEST} ${kind.padEnd(7)}`;
  seen.aborts = 0;

  fresh();
  const ac = new AbortController();
  const r1 = await fetch(`${url}/events`, { signal: ac.signal });
  await subscribed.promise;
  channel.send({ data: "live-1" });
  const c1 = await read(r1, 2);
  const liveId = /id: (e\d+)\\ndata: live-1/.exec(c1)![1]; // this pass's id for live-1
  log(`${tag} C1 new client: initial, then live`, c1);
  log(`${tag} C1 subscribers while open`, String(channel.size));
  const t0 = performance.now();
  ac.abort();
  const why = await Promise.race([torn.promise, Bun.sleep(2000).then(() => "NOT torn down in 2 s")]);
  await Bun.sleep(0);
  log(`${tag} C2 client disconnect`, `${why} @${(performance.now() - t0).toFixed(0)}ms; size ${channel.size}; SseSignal aborts ${seen.aborts}; socket ${seen.socket || "close never fired"}`);

  channel.send({ data: "live-2" });
  channel.send({ data: "live-3" });
  fresh();
  const r2 = await fetch(`${url}/events`, { headers: { "last-event-id": liveId } });
  await subscribed.promise;
  fresh();
  const r3 = await fetch(`${url}/events`, { headers: { "last-event-id": "1" } });
  await subscribed.promise;
  log(`${tag} C5 two open: channel.size, GET /size`, `${channel.size} ${await (await fetch(`${url}/size`)).text()}`);
  // Reading `max` events cancels each body, i.e. disconnects.
  log(`${tag} C3 Last-Event-ID ${liveId} (live-1, in buffer): replay`, await read(r2, 2));
  log(`${tag} C4 Last-Event-ID "1" (Nest's own auto id): miss`, await read(r3, 1));
  await app.close();
  await Bun.sleep(50);
  log(`${tag} C6 after both cancelled and app.close()`, `size ${channel.size}`);
}

// C9 (bun-nest) @Res() + channel.subscribe(): encode once, served and through adapter.fetch().
{
  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(M, adapter, { logger: false });
  await app.listen(0, "127.0.0.1");
  for (const via of ["served", "adapter.fetch()"] as const) {
    fresh();
    const res = via === "served" ? await fetch(`${await app.getUrl()}/bytes`) : await adapter.fetch("/bytes");
    await subscribed.promise;
    const open = channel.size;
    channel.send({ data: "bytes-1" });
    const got = await read(res, 3);
    const why = await Promise.race([torn.promise, Bun.sleep(2000).then(() => "NOT closed in 2 s")]);
    log(`${NEST} bun     C9 @Res() channel.subscribe, ${via}`, `${got} size open ${open}, after cancel ${channel.size} (${why})`);
  }
  await app.close();
}

// C7 close(): the channel ends a Nest subscriber's stream.
{
  const app = await NestFactory.create(M, new BunHttpAdapter(), { logger: false });
  await app.listen(0, "127.0.0.1");
  fresh();
  const r = await fetch(`${await app.getUrl()}/events`);
  await subscribed.promise;
  const reading = readEvents(r.body, performance.now(), { timeoutMs: 1500 });
  channel.close();
  const out = await reading;
  log(`${NEST} bun     C7 channel.close() with a Nest subscriber`, `end=${out.end} size ${channel.size}`);
  await app.close();
}

// C8 the encode-once loss, in process: K subscribers through Nest's own pipeline
// (Nest's SseStream, the map + concatMap of router-response-controller) against
// K byte writers on the channel's path. Same channel, same events.
{
  const mod = (await import("@nestjs/core/router/sse-stream.js").catch(() => null)) as { SseStream: new () => Writable & { writeMessage: (m: unknown, cb: (e?: Error) => void) => void } } | null;
  for (const K of [100, 1000]) {
    const N = 2000;
    const ch = createSseChannel({ heartbeatMs: 0 });
    const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
    let pending = 0;
    if (mod) {
      for (let i = 0; i < K; i++) {
        const stream = new mod.SseStream();
        stream.pipe(sink());
        channelObservable(ch).pipe(map((e) => (typeof e.data === "string" ? e : { ...e, data: JSON.stringify(e.data) })), concatMap((e) => new Promise<void>((resolve) => {
          pending++;
          stream.writeMessage(e, () => (pending--, resolve()));
        }))).subscribe();
      }
    }
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) ch.send({ data: { i, p: "x".repeat(40) } });
    while (pending > 0) await new Promise((r) => setImmediate(r));
    const nest = (Bun.nanoseconds() - t0) / N / K;
    ch.close();
    const bytes = createSseChannel({ heartbeatMs: 0 });
    for (let i = 0; i < K; i++) bytes.attach({ send() {}, closed: false, onClose() {}, close() {} });
    const t1 = Bun.nanoseconds();
    for (let i = 0; i < N; i++) bytes.send({ data: { i, p: "x".repeat(40) } });
    const raw = (Bun.nanoseconds() - t1) / N / K;
    bytes.close();
    log(`${NEST} C8 per event per subscriber, K=${K}`, mod ? `Nest pipeline ${nest.toFixed(0)} ns, channel bytes ${raw.toFixed(0)} ns (${(nest / raw).toFixed(0)}x)` : "Nest's SseStream not importable");
  }
}
process.exit(0);
