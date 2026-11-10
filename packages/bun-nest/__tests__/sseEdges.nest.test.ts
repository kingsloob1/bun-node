import type { BunRequest, BunResponse, SseItem } from "@kingsleyweb/bun-common";
/**
 * The edges of server-sent events on `BunHttpAdapter` that the README's
 * "Server-sent events" section states (bun-native-routes plan §16.4, §16.11
 * PR-sse3), each read the way a client sees it, with bun-common's standard
 * parser (`readSse`):
 *
 * - Nest's own encoder, by release: `data: ""` is dropped before 11.1.29
 *   (`message.data ? …`) and sent from 11.1.29 and 11.2.0
 *   (`!isNil(message.data)`); a number is stringified from 12.2.0 and breaks
 *   the stream before it.
 * - `app.close()` with an `@Sse()` stream open cuts it after the adapter's
 *   `closeDrainTimeout`, and Nest unsubscribes.
 * - A client that stops reading an `@Sse()` stream: dropped past `@Sse()`'s
 *   `maxPendingDataLength` where Nest has it (11.2.8 and 12.2.0 on), buffered
 *   without bound before (the README's caveat). Both are told apart by
 *   reading Nest's source, not its version number.
 * - `@Res() res.sse()`, the imperative alternative: bun-common's writer
 *   (headers, the opening comment, `lastEventId`, `onClose` when the client
 *   leaves, `send()` resolving `false` after), served and through
 *   `adapter.fetch()`.
 *
 * The rest of `@Sse()` (streaming, a disconnect unsubscribing, a 500 for an
 * error before the first event, the idle-timeout exemption) is
 * `sse.nest.test.ts`; `@SseSignal()` is `sseSignal.nest.test.ts`.
 *
 * Deadlines are seconds per step: only a hang reaches one. `reflect-metadata`
 * is imported last per the import-sort rule. No top-level `await`: it
 * perturbs decorator metadata in other gateway test files.
 */
import type {
  INestApplication,
  MessageEvent,
  RequestMethod,
} from "@nestjs/common";
import { readSse } from "@kingsleyweb/bun-common/sse";
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
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Observable, of } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

const require = createRequire(import.meta.url);

/** The installed `@nestjs/core`'s version, as `[major, minor]`. */
const NEST = (
  require("@nestjs/core/package.json") as { version: string }
).version
  .split(".")
  .slice(0, 2)
  .map(Number) as [number, number];

/** The source of one of `@nestjs/core`'s router modules, to probe for a behaviour. */
function nestSource(module: string): string {
  return readFileSync(
    require.resolve(`@nestjs/core/router/${module}.js`),
    "utf8",
  );
}

/**
 * Whether Nest's encoder sends a falsy `data` (11.1.29, 11.2.0 and later:
 * `!isNil(message.data)`, where earlier ones test `message.data ?`).
 */
const sendsFalsyData = !/message\.data \?/.test(nestSource("sse-stream"));

/**
 * Whether Nest stringifies a non-string, non-object `data` (a number) before
 * encoding it (12.2.0 and later: `isNil(event.data) || isString(event.data)`
 * in the router), where earlier releases hand it to an encoder that throws.
 */
const stringifiesNumbers = /isString\)?\(event\.data\)/.test(
  nestSource("router-response-controller"),
);

/**
 * Whether this Nest drops an `@Sse()` client that stops reading
 * (`maxPendingDataLength`, 11.2.8 and 12.2.0 on): read from the router's
 * source, so a backport is seen too.
 */
/**
 * Whether Nest hides an unknown error's message after the first event
 * (`Internal server error`; 11.2.8 and 12.2.0 on), where earlier releases
 * send `err.message`.
 */
const hidesErrorMessages = nestSource("router-response-controller").includes(
  "UNKNOWN_EXCEPTION_MESSAGE",
);

const dropsSlowReaders = nestSource("router-response-controller").includes(
  "maxPendingDataLength",
);

/**
 * `@Sse()`'s options where Nest has `maxPendingDataLength`; older ones ignore it.
 * `method` is there so the type shares a property with an older Nest's
 * `{ method?: RequestMethod }` options, which TypeScript otherwise refuses as a
 * weak type with nothing in common (TS2559, measured on 11.2.7).
 */
interface SseOptionsWithLimit {
  /** Characters of event data that may wait for a client that is not reading. */
  maxPendingDataLength?: number;
  /** The route's method, as every Nest's `@Sse()` options allow; unset here. */
  method?: RequestMethod;
}

/** The limit the slow-reader route sets, in characters of event data. */
const SLOW_LIMIT = 256 * 1024;

/** One event's data on the slow-reader route: 8 Ki characters. */
const SLOW_CHUNK = "x".repeat(8 * 1024);

/** What the routes report to the test that is driving them. */
const probe = {
  /** Called when the endless or slow stream's subscription is torn down. */
  unsubscribed: undefined as (() => void) | undefined,
  /** Characters of data the slow stream has emitted. */
  emitted: 0,
  /** Called with the writer's state once `@Res() res.sse()` sees its client leave. */
  imperativeClosed: undefined as
    ((state: { sentAfter: boolean; closed: boolean }) => void) | undefined,
};

/** 8 Ki characters of data a millisecond, counted in {@link probe}. */
function slowEvents(): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    const timer = setInterval(() => {
      probe.emitted += SLOW_CHUNK.length;
      subscriber.next({ data: SLOW_CHUNK });
    }, 1);
    return () => {
      clearInterval(timer);
      probe.unsubscribed?.();
    };
  });
}

@Controller("edges")
class EdgesController {
  /** `""`, which Nest's encoder dropped before 11.1.29, then a marker. */
  @Sse("falsy")
  falsy(): Observable<MessageEvent> {
    return of({ data: "" }, { data: "end" });
  }

  /** Numbers, `0` among them, then a marker. */
  @Sse("numbers")
  numbers(): Observable<MessageEvent> {
    // `MessageEvent.data` is typed `string | object`, but nothing stops an
    // app sending a count: Nest stringifies one from 12.2.0, and before that
    // its encoder throws on it (`value.split is not a function`).
    const seven = { data: 7 } as unknown as MessageEvent;
    const zero = { data: 0 } as unknown as MessageEvent;
    return of(seven, zero, { data: "end" });
  }

  /** One event, then an error whose message is not for the client. */
  @Sse("err-after")
  errAfter(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ data: "first" });
      subscriber.error(new Error("internal detail"));
    });
  }

  /** Never completes; reports its teardown. */
  @Sse("endless")
  endless(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let n = 0;
      const timer = setInterval(() => subscriber.next({ data: `n${n++}` }), 5);
      return () => {
        clearInterval(timer);
        probe.unsubscribed?.();
      };
    });
  }

  /** 8 Ki characters a millisecond, for a client that never reads. */
  // Needed on Nest without the option (before 11.2.8 and 12.2.0), whose
  // `SseOptions` would refuse the excess property; redundant on the lock's.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  @Sse("slow", { maxPendingDataLength: SLOW_LIMIT } as SseOptionsWithLimit)
  slow(): Observable<MessageEvent> {
    return slowEvents();
  }

  /** The same with Nest's limit lifted (`0`): the control. */
  // Needed on Nest without the option (before 11.2.8 and 12.2.0), whose
  // `SseOptions` would refuse the excess property; redundant on the lock's.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  @Sse("slow-unlimited", { maxPendingDataLength: 0 } as SseOptionsWithLimit)
  slowUnlimited(): Observable<MessageEvent> {
    return slowEvents();
  }

  /** bun-common's writer through `@Res()`: the imperative alternative. */
  @Get("imperative")
  imperative(
    @Req() req: BunRequest,
    @Res() res: BunResponse,
    @Headers("last-event-id") lastEventId?: string,
  ): void {
    const stream = res.sse({ heartbeatMs: 0 });
    let n = 0;
    const timer = setInterval(() => {
      void stream.send({
        event: "tick",
        id: `${lastEventId ?? "fresh"}.${++n}`,
        data: { n, header: stream.lastEventId ?? null, url: req.url },
      });
    }, 5);
    stream.onClose(() => {
      clearInterval(timer);
      void stream.send({ data: "after" }).then((sentAfter) => {
        probe.imperativeClosed?.({ sentAfter, closed: stream.closed });
      });
    });
  }
}

@Module({ controllers: [EdgesController] })
class AppModule {}

/** A step's deadline: each takes milliseconds, so only a hang reaches it. */
const STEP_MS = 10_000;

/** Applications to close after each test. */
const apps: INestApplication[] = [];

afterEach(async () => {
  probe.unsubscribed = undefined;
  probe.imperativeClosed = undefined;
  probe.emitted = 0;
  while (apps.length) {
    await apps.pop()?.close();
  }
}, 2 * STEP_MS);

/** Resolves `pending`, or rejects naming `name` once {@link STEP_MS} passes first. */
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

/** How a test reaches the app. */
type Mode = "served" | "adapter.fetch()";

/** An app in `mode`, and a `fetch` for it. */
async function start(
  mode: Mode,
  adapterOptions?: { closeDrainTimeout?: number },
): Promise<{
  app: INestApplication;
  get: (path: string, init?: RequestInit) => Promise<Response>;
}> {
  const adapter = new BunHttpAdapter(0, adapterOptions);
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  apps.push(app);
  if (mode === "served") {
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    return { app, get: async (path, init) => fetch(`${url}${path}`, init) };
  }
  await app.init();
  return {
    app,
    get: async (path, init) =>
      adapter.fetch(new Request(`http://localhost${path}`, init)),
  };
}

/** The first `count` items of an event stream, comments included. */
async function take(
  iterator: AsyncIterator<SseItem>,
  count: number,
): Promise<SseItem[]> {
  const items: SseItem[] = [];
  while (items.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    items.push(next.value);
  }
  return items;
}

/** The events of a whole stream, without its comments. */
async function events(res: Response): Promise<SseItem[]> {
  const items: SseItem[] = [];
  for await (const item of readSse(res.body!)) {
    if (item.kind === "event") items.push(item);
  }
  return items;
}

const MODES = ["served", "adapter.fetch()"] as const;

describe(`Nest's encoder and a falsy data (Nest ${NEST.join(".")})`, () => {
  for (const mode of MODES) {
    it(`${mode}: ${sendsFalsyData ? 'sends data: "" (11.1.29, 11.2.0 and later)' : 'drops data: "" (before 11.1.29)'}`, async () => {
      const { get } = await start(mode);
      const res = await step("the response", get("/edges/falsy"));
      expect(res.status).toBe(200);
      const got = (await step("the stream", events(res))).map((item) =>
        item.kind === "event" ? [item.id, item.data] : [],
      );
      // Nest numbers every event; a dropped data leaves an `id:` alone, which
      // a standard parser does not dispatch.
      expect(got).toEqual(
        sendsFalsyData
          ? [
              ["1", ""],
              ["2", "end"],
            ]
          : [["2", "end"]],
      );
    });

    it(`${mode}: ${stringifiesNumbers ? "a number is sent as text, 0 included (12.2.0 and later)" : "a number breaks the stream: nothing after it arrives (before 12.2.0)"}`, async () => {
      const { get } = await start(mode);
      if (stringifiesNumbers) {
        const res = await step("the response", get("/edges/numbers"));
        expect(res.status).toBe(200);
        const got = (await step("the stream", events(res))).map((item) =>
          item.kind === "event" ? item.data : "",
        );
        expect(got).toEqual(["7", "0", "end"]);
        return;
      }
      // Nest's encoder throws on the first number: the response may not
      // even arrive. Whatever does within a second, "end" is not in it.
      const client = new AbortController();
      const seen: string[] = [];
      const reading = (async () => {
        const res = await get("/edges/numbers", { signal: client.signal });
        for await (const item of readSse(res.body!)) {
          if (item.kind === "event") seen.push(item.data);
        }
      })().catch(() => undefined);
      await Promise.race([reading, Bun.sleep(1000)]);
      client.abort();
      expect(seen).not.toContain("end");
    });
  }
});

describe(`an error after the first event (Nest ${NEST.join(".")})`, () => {
  for (const mode of MODES) {
    it(`${mode}: an event: error, ${hidesErrorMessages ? "with Nest's generic message (11.2.8, 12.2.0 on)" : "with the error's own message (before 11.2.8 and 12.2.0)"}, then the end`, async () => {
      const { get } = await start(mode);
      const res = await step("the response", get("/edges/err-after"));
      expect(res.status).toBe(200);
      const got = (await step("the stream", events(res))).map((item) =>
        item.kind === "event" ? [item.event, item.data] : [],
      );
      expect(got).toEqual([
        ["message", "first"],
        [
          "error",
          hidesErrorMessages ? "Internal server error" : "internal detail",
        ],
      ]);
    });
  }
});

describe("app.close() with an @Sse() stream open", () => {
  it("served: cuts the stream after closeDrainTimeout, and Nest unsubscribes", async () => {
    const unsubscribed = Promise.withResolvers<void>();
    probe.unsubscribed = unsubscribed.resolve;
    const { app, get } = await start("served", { closeDrainTimeout: 200 });
    const res = await step("the response", get("/edges/endless"));
    const iterator = readSse(res.body!)[Symbol.asyncIterator]();
    expect(
      (await step("two events", take(iterator, 2))).map((item) =>
        item.kind === "event" ? item.data : item.text,
      ),
    ).toEqual(["n0", "n1"]);

    apps.splice(apps.indexOf(app), 1);
    const closing = app.close();
    // The client reads on until the stream is cut: done, or a socket error.
    const ending = (async (): Promise<string> => {
      try {
        while (!(await iterator.next()).done) {
          // events that were in flight
        }
        return "ended";
      } catch {
        return "cut";
      }
    })();
    await step("app.close()", closing);
    expect(await step("the client's stream ending", ending)).toMatch(
      /^(ended|cut)$/,
    );
    await step("the unsubscription", unsubscribed.promise);
  });
});

describe(`a client that stops reading an @Sse() stream (Nest ${NEST.join(".")}, ${dropsSlowReaders ? "maxPendingDataLength" : "no limit"})`, () => {
  // Through `adapter.fetch()`, whose body is a pull stream nobody reads:
  // `res.write()` answers `false` once 64 KiB wait, Nest's pipe pauses, and
  // its events queue in `concatMap`.
  if (dropsSlowReaders) {
    it("adapter.fetch(): dropped past maxPendingDataLength, as a disconnect", async () => {
      const unsubscribed = Promise.withResolvers<void>();
      probe.unsubscribed = unsubscribed.resolve;
      const { get } = await start("adapter.fetch()");
      const res = await step("the response", get("/edges/slow"));
      expect(res.status).toBe(200);
      await step("the drop", unsubscribed.promise);
      // Dropped soon after the limit, not after everything was buffered: the
      // bound is the limit plus what the stream and its pipe hold.
      expect(probe.emitted).toBeLessThan(SLOW_LIMIT + 2 * 1024 * 1024);
      await res.body?.cancel().catch(() => undefined);
    });
  }
  // Without a limit (Nest before 11.2.8 and 12.2.0, or `maxPendingDataLength:
  // 0`), the
  // events wait for the client however many there are: the README's caveat,
  // and the drop test's control.
  for (const route of dropsSlowReaders
    ? ["/edges/slow-unlimited"]
    : ["/edges/slow", "/edges/slow-unlimited"]) {
    it(`adapter.fetch() ${route}: still subscribed well past the limit (no bound)`, async () => {
      let unsubscribedEarly = false;
      probe.unsubscribed = () => {
        unsubscribedEarly = true;
      };
      const { get } = await start("adapter.fetch()");
      const res = await step("the response", get(route));
      expect(res.status).toBe(200);
      const past = 4 * SLOW_LIMIT;
      await step(
        `${past} characters emitted`,
        (async () => {
          while (probe.emitted < past) await Bun.sleep(5);
        })(),
      );
      expect(unsubscribedEarly).toBe(false);
      await res.body?.cancel().catch(() => undefined);
    });
  }
});

describe("@Res() res.sse(): bun-common's writer in a Nest handler", () => {
  for (const mode of MODES) {
    it(`${mode}: headers, the opening comment, Last-Event-ID, and onClose when the client leaves`, async () => {
      const closed = Promise.withResolvers<{
        sentAfter: boolean;
        closed: boolean;
      }>();
      probe.imperativeClosed = closed.resolve;
      const { get } = await start(mode);
      const res = await step(
        "the response",
        get("/edges/imperative", { headers: { "last-event-id": "41" } }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      expect(res.headers.get("connection")).not.toBe("keep-alive");

      const iterator = readSse(res.body!)[Symbol.asyncIterator]();
      const [open, first, second] = await step(
        "the opening and two events",
        take(iterator, 3),
      );
      expect(open).toEqual({ kind: "comment", text: " ok" });
      expect(first).toMatchObject({
        kind: "event",
        event: "tick",
        id: "41.1",
      });
      expect(
        JSON.parse((first as { data: string }).data) as unknown,
      ).toMatchObject({ n: 1, header: "41" });
      expect(second).toMatchObject({ kind: "event", id: "41.2" });

      await iterator.return?.();
      expect(
        await step("onClose after the client left", closed.promise),
      ).toEqual({ sentAfter: false, closed: true });
    });
  }

  it("adapter.fetch(): a client that never leaves never reaches onClose (the control)", async () => {
    let reached = false;
    probe.imperativeClosed = () => {
      reached = true;
    };
    const { get } = await start("adapter.fetch()");
    const res = await step("the response", get("/edges/imperative"));
    const iterator = readSse(res.body!)[Symbol.asyncIterator]();
    await step("the opening and an event", take(iterator, 2));
    await Bun.sleep(50);
    expect(reached).toBe(false);
    await iterator.return?.();
  });
});
