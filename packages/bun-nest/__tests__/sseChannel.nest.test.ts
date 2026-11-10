import type { SseItem } from "@kingsleyweb/bun-common/sse";
/**
 * `channelObservable()` (bun-native-routes plan §16.14.4, PR-sse3's delta):
 * a bun-common broadcast channel behind NestJS's `@Sse()`, on bun-nest's
 * `BunHttpAdapter` (served and through `adapter.fetch()`) and on
 * `@nestjs/platform-express` (served), with `@SseSignal()` where Nest has it
 * (11.2.0 and later). Plus `@Res()` with `channel.subscribe(req, res)`, the
 * byte path that keeps the channel's one encode per event.
 *
 * Each case runs on every client and must give the same events; the
 * controls show each check can fail: an observable over `listen()` without
 * a teardown leaves the subscriber registered, and `heartbeatMs: 0` sends no
 * heartbeat.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { INestApplication, MessageEvent } from "@nestjs/common";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { createSseChannel, readSse } from "@kingsleyweb/bun-common/sse";
import * as common from "@nestjs/common";
import {
  Controller,
  Get,
  Headers,
  Module,
  Req,
  Res,
  Sse,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Observable } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { channelObservable } from "../lib/sseChannel";
import "reflect-metadata";

/** `@SseSignal()`'s shape, read off the namespace so Nest 11.1.x still type-checks. */
type SseSignalFactory = () => ParameterDecorator;

/** Nest's `@SseSignal()`, or `undefined` on a Nest without it. */
const NestSseSignal = (common as unknown as Record<string, unknown>)
  .SseSignal as SseSignalFactory | undefined;

/** Whether this Nest has `@SseSignal()` (and comment events): 11.2.0 and later. */
const hasSseSignal = typeof NestSseSignal === "function";

/** The decorator the controller uses: a no-op where Nest has none. */
const SseSignal: SseSignalFactory = NestSseSignal ?? (() => () => undefined);

/** The channel every route serves; recreated per test. */
let prices = createSseChannel({ heartbeatMs: 0 });

/** What the routes report, per test. */
const seen = {
  /** Set when `@SseSignal()`'s signal aborts. */
  aborted: undefined as Promise<void> | undefined,
};

@Controller("prices")
class PricesController {
  @Sse("live")
  live(
    @Headers("last-event-id") lastEventId?: string,
    @SseSignal() signal?: AbortSignal,
  ): Observable<MessageEvent> {
    if (signal !== undefined) {
      seen.aborted = new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    return channelObservable(prices, { lastEventId, signal, heartbeatMs: 0 });
  }

  @Sse("topic")
  topic(): Observable<MessageEvent> {
    return channelObservable(prices, { topics: ["vip"], heartbeatMs: 0 });
  }

  @Sse("beat")
  beat(): Observable<MessageEvent> {
    return channelObservable(prices, { heartbeatMs: 20 });
  }

  /** The control: `listen()` with no teardown, so Nest's unsubscribe cannot reach the channel. */
  @Sse("leaky")
  leaky(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      prices.listen((message) =>
        subscriber.next({ data: String(message.data) }),
      );
    });
  }

  /** The byte path: bun-common's writer through `@Res()`. */
  @Get("bytes")
  bytes(@Req() req: BunRequest, @Res() res: BunResponse): void {
    prices.subscribe(req, res);
  }
}

@Module({ controllers: [PricesController] })
class AppModule {}

/** A step's deadline: only a hang reaches it. */
const STEP_MS = 5000;

/** Resolves `pending`, or rejects naming `name` once {@link STEP_MS} passes. */
async function step<T>(name: string, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name}: still pending after ${STEP_MS} ms`)),
          STEP_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits until `condition()` holds, checking every few ms, up to {@link STEP_MS}. */
async function until(name: string, condition: () => boolean): Promise<void> {
  await step(
    name,
    (async () => {
      while (!condition()) await Bun.sleep(2);
    })(),
  );
}

/** A reader of an event stream's items. */
function reader(body: ReadableStream<Uint8Array>) {
  const iterator = readSse(body)[Symbol.asyncIterator]();
  return {
    /** The next `count` events, skipping comments. */
    async events(count: number): Promise<SseItem[]> {
      const out: SseItem[] = [];
      while (out.length < count) {
        const next = await step(`event ${out.length + 1}`, iterator.next());
        if (next.done) break;
        if (next.value.kind === "event") out.push(next.value);
      }
      return out;
    },
    /** The next `count` items, comments included. */
    async items(count: number): Promise<SseItem[]> {
      const out: SseItem[] = [];
      while (out.length < count) {
        const next = await step(`item ${out.length + 1}`, iterator.next());
        if (next.done) break;
        out.push(next.value);
      }
      return out;
    },
    /** Whether the stream ends next (rather than yielding an event). */
    async ends(): Promise<boolean> {
      for (;;) {
        const next = await step("the end", iterator.next());
        if (next.done) return true;
        if (next.value.kind === "event") return false;
      }
    },
    /** Stops reading: the client leaves. */
    async leave(): Promise<void> {
      await iterator.return?.();
    },
  };
}

/** An event's `[event, data]`. */
function pair(item: SseItem): [string, string] | string {
  return item.kind === "event" ? [item.event, item.data] : `:${item.text}`;
}

type Client = "bun-nest served" | "bun-nest adapter.fetch()" | "express served";
const CLIENTS: Client[] = [
  "bun-nest served",
  "bun-nest adapter.fetch()",
  "express served",
];

/** One app per client, for the whole file. */
const gets = new Map<
  Client,
  (path: string, init?: RequestInit) => Promise<Response>
>();
const apps: INestApplication[] = [];

beforeAll(async () => {
  const served = await NestFactory.create(AppModule, new BunHttpAdapter(0), {
    logger: false,
  });
  await served.listen(0, "127.0.0.1");
  apps.push(served);
  const servedUrl = await served.getUrl();
  gets.set("bun-nest served", async (path, init) =>
    fetch(`${servedUrl}${path}`, init),
  );

  const adapter = new BunHttpAdapter();
  const fetched = await NestFactory.create(AppModule, adapter, {
    logger: false,
  });
  await fetched.init();
  apps.push(fetched);
  gets.set("bun-nest adapter.fetch()", async (path, init) =>
    adapter.fetch(new Request(`http://localhost${path}`, init)),
  );

  const express = await NestFactory.create(AppModule, new ExpressAdapter(), {
    logger: false,
  });
  await express.listen(0, "127.0.0.1");
  apps.push(express);
  const expressUrl = (await express.getUrl()).replace("[::1]", "127.0.0.1");
  gets.set("express served", async (path, init) =>
    fetch(`${expressUrl}${path}`, init),
  );
});

afterEach(() => {
  prices.close();
  seen.aborted = undefined;
});

afterAll(async () => {
  while (apps.length) await apps.pop()?.close();
});

/** A fresh channel for one test. */
function fresh(options: Parameters<typeof createSseChannel>[0]): void {
  prices = createSseChannel({ heartbeatMs: 0, ...options });
}

describe(`channelObservable() under @Sse() (Nest ${hasSseSignal ? "with" : "without"} @SseSignal())`, () => {
  for (const client of CLIENTS) {
    it(`${client}: the initial state, then live events; leaving unsubscribes${hasSseSignal ? ", after @SseSignal() aborts" : ""}`, async () => {
      fresh({ initial: [{ event: "init", data: { p: 100 } }] });
      const res = await step("the response", gets.get(client)!("/prices/live"));
      expect(res.status).toBe(200);
      const stream = reader(res.body!);
      await until("subscribed", () => prices.size === 1);
      prices.send({ event: "tick", data: { p: 101 } });
      expect((await stream.events(2)).map(pair)).toEqual([
        ["init", '{"p":100}'],
        ["tick", '{"p":101}'],
      ]);
      await stream.leave();
      await until("unsubscribed", () => prices.size === 0);
      if (hasSseSignal) await step("@SseSignal() aborting", seen.aborted!);
    });

    it(`${client}: Last-Event-ID of a channel event replays the later ones and no initial state; Nest's own id is a miss`, async () => {
      fresh({ replay: 10, initial: [{ event: "init", data: "state" }] });
      const ids: string[] = [];
      prices.listen((message) => {
        if (message.event !== "init") ids.push(String(message.id));
      });
      prices.send({ data: "one" });
      prices.send({ data: "two" });
      prices.send({ data: "three" });
      const get = gets.get(client)!;
      const res = await step(
        "the replay",
        get("/prices/live", { headers: { "last-event-id": ids[0] } }),
      );
      const stream = reader(res.body!);
      const replayed = await stream.events(2);
      expect(replayed.map(pair)).toEqual([
        ["message", "two"],
        ["message", "three"],
      ]);
      // The channel's ids reach the client through Nest.
      expect(replayed.map((item) => (item as { id: string }).id)).toEqual([
        ids[1],
        ids[2],
      ]);
      await stream.leave();

      // An initial-state event has no channel id, so Nest numbers it `1`; a
      // reconnect with that id is a miss, and gets the initial state again.
      const missed = reader(
        (
          await step(
            "the miss",
            get("/prices/live", { headers: { "last-event-id": "1" } }),
          )
        ).body!,
      );
      expect((await missed.events(1)).map(pair)).toEqual([["init", "state"]]);
      await missed.leave();
      await until("unsubscribed", () => prices.size === 1);
    });

    it(`${client}: channel.close() ends Nest's stream`, async () => {
      fresh({});
      const stream = reader(
        (await step("the response", gets.get(client)!("/prices/live"))).body!,
      );
      await until("subscribed", () => prices.size === 1);
      prices.send({ data: "last" });
      expect((await stream.events(1)).map(pair)).toEqual([["message", "last"]]);
      prices.close();
      expect(await stream.ends()).toBe(true);
    });

    it(`${client}: topics reach their subscribers only`, async () => {
      fresh({});
      const get = gets.get(client)!;
      const vip = reader((await step("vip", get("/prices/topic"))).body!);
      const all = reader((await step("all", get("/prices/live"))).body!);
      await until("both subscribed", () => prices.size === 2);
      expect(prices.send({ data: "for vip" }, { topic: "vip" })).toBe(1);
      expect(prices.send({ data: "for all" })).toBe(2);
      expect((await vip.events(2)).map(pair)).toEqual([
        ["message", "for vip"],
        ["message", "for all"],
      ]);
      expect((await all.events(1)).map(pair)).toEqual([["message", "for all"]]);
      await vip.leave();
      await all.leave();
      await until("unsubscribed", () => prices.size === 0);
    });

    it(`${client}: ${hasSseSignal ? "a heartbeat comment every heartbeatMs (Nest writes comment events)" : "no heartbeat (Nest 11.1 has no comment event)"}`, async () => {
      fresh({});
      const stream = reader(
        (await step("the response", gets.get(client)!("/prices/beat"))).body!,
      );
      await until("subscribed", () => prices.size === 1);
      if (hasSseSignal) {
        const items = await stream.items(3);
        expect(items.filter((item) => item.kind === "comment").length).toBe(
          items.length,
        );
        // The control: the same wait on a route with `heartbeatMs: 0` sees
        // no comment before the next event.
        const quiet = reader(
          (await step("the quiet one", gets.get(client)!("/prices/live")))
            .body!,
        );
        await until("both subscribed", () => prices.size === 2);
        await Bun.sleep(80);
        prices.send({ data: "only" });
        expect((await quiet.items(1)).map(pair)).toEqual([["message", "only"]]);
        await quiet.leave();
      } else {
        await Bun.sleep(80);
        prices.send({ data: "only" });
        expect((await stream.items(1)).map(pair)).toEqual([
          ["message", "only"],
        ]);
      }
      await stream.leave();
      await until("unsubscribed", () => prices.size === 0);
    });

    it(`${client}: an observable over listen() without a teardown stays registered after the client leaves (the control)`, async () => {
      fresh({});
      const stream = reader(
        (await step("the response", gets.get(client)!("/prices/leaky"))).body!,
      );
      await until("subscribed", () => prices.size === 1);
      prices.send({ data: "x" });
      await stream.events(1);
      await stream.leave();
      await Bun.sleep(50);
      expect(prices.size).toBe(1);
    });
  }

  it("a heartbeatMs that is not a non-negative number throws", () => {
    expect(() => channelObservable(prices, { heartbeatMs: -1 })).toThrow(
      TypeError,
    );
  });
});

describe("@Res() with channel.subscribe(req, res): the byte path, on bun-nest", () => {
  for (const client of [
    "bun-nest served",
    "bun-nest adapter.fetch()",
  ] as const) {
    it(`${client}: the opening, the initial state and live events; leaving unsubscribes`, async () => {
      fresh({ initial: [{ data: "init" }] });
      const stream = reader(
        (await step("the response", gets.get(client)!("/prices/bytes"))).body!,
      );
      expect((await stream.items(2)).map(pair)).toEqual([
        ": ok",
        ["message", "init"],
      ]);
      expect(prices.send({ data: "live" })).toBe(1);
      expect((await stream.events(1)).map(pair)).toEqual([["message", "live"]]);
      await stream.leave();
      await until("unsubscribed", () => prices.size === 0);
    });
  }
});
