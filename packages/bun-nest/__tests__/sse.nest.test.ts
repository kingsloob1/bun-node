import type { BunResponse } from "@kingsleyweb/bun-common";
/**
 * NestJS's `@Sse()` on `BunHttpAdapter`, over a served request.
 *
 * Nest's `RouterResponseController.sse` builds an `SseStream` (a Node
 * `Transform`) that calls `req.socket.setKeepAlive/setNoDelay/setTimeout`,
 * pipes into the response (`writeHead`, `flushHeaders`, `write`, `end`) and
 * waits on `req.socket.once("close")` to unsubscribe when the client leaves.
 * These tests read the stream a real client sees, served and through the
 * socket-free `adapter.fetch()`.
 *
 * No assertion rests on a short window: "promptly" is a deadline of seconds
 * (the bug it guards was a hang until the idle timeout), and the idle-timeout
 * case carries a control proving the timeout is live.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { INestApplication, MessageEvent } from "@nestjs/common";
import { Controller, Get, Module, Res, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { interval, map, Observable, take, throwError } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/** Set once the endless stream's subscription is torn down. */
let endlessUnsubscribed: (() => void) | undefined;

@Controller("events")
class EventsController {
  @Sse("ticks")
  ticks(): Observable<MessageEvent> {
    return interval(5).pipe(
      take(3),
      map((n) => ({ data: { tick: n }, type: "tick" })),
    );
  }

  @Sse("endless")
  endless(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let n = 0;
      const timer = setInterval(() => subscriber.next({ data: `n${n++}` }), 5);
      return () => {
        clearInterval(timer);
        endlessUnsubscribed?.();
      };
    });
  }
}

/** The failure and silence cases. */
@Controller("edges")
class EdgesController {
  @Sse("err-before")
  errBefore(): Observable<MessageEvent> {
    return throwError(() => new Error("before the first event"));
  }

  @Sse("throws")
  throws(): Observable<MessageEvent> {
    throw new Error("thrown by the handler");
  }

  /** One event, then silence: Nest's `SseStream` calls `socket.setTimeout(0)`. */
  @Sse("quiet")
  quiet(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ data: "first" });
    });
  }

  /** The control: a quiet stream nothing exempted from the idle timeout. */
  @Get("quiet-control")
  quietControl(@Res() res: BunResponse): void {
    res.setHeader("Content-Type", "text/event-stream");
    res.send(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        },
      }),
    );
  }
}

@Module({ controllers: [EventsController, EdgesController] })
class AppModule {}

/** Applications to close after each test. */
const apps: INestApplication[] = [];

afterEach(async () => {
  while (apps.length) {
    await apps.pop()?.close();
  }
});

/** A Nest application on `BunHttpAdapter`, listening on an OS-assigned port. */
async function startApp(
  /** `Bun.serve` options for the adapter (`idleTimeout`, …). */
  server?: { idleTimeout?: number },
): Promise<string> {
  const app = await NestFactory.create(
    AppModule,
    new BunHttpAdapter(0, server ? { server } : undefined),
    { logger: false },
  );
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

/** How a test reaches the app: over a socket, or through `adapter.fetch()`. */
type Mode = "served" | "adapter.fetch()";

/** Starts the app and returns a `GET` for `mode`. */
async function client(
  mode: Mode,
): Promise<(path: string) => Promise<Response>> {
  if (mode === "served") {
    const url = await startApp();
    return async (path) => fetch(`${url}${path}`);
  }
  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  apps.push(app);
  await app.init();
  return async (path) => adapter.fetch(path);
}

/** Resolves `pending`, or `undefined` once `deadlineMs` passes first. */
async function within<T>(
  pending: Promise<T>,
  deadlineMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, deadlineMs, undefined);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads from `reader` until `count` SSE events (blank-line terminated) have arrived. */
async function readEvents(
  /** A response body's reader; only `read()` is used. */
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  count: number,
): Promise<string[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const events: string[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary).replace(/^\n+/, "");
      buffer = buffer.slice(boundary + 2);
      if (block.length > 0) {
        events.push(block);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

describe("@Sse() on BunHttpAdapter", () => {
  it("streams every event with Nest's SSE headers, then ends", async () => {
    const url = await startApp();
    const res = await fetch(`${url}/events/ticks`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    const reader = res.body!.getReader();
    const events = await readEvents(reader, 3);
    expect(events).toEqual([
      'event: tick\nid: 1\ndata: {"tick":0}',
      'event: tick\nid: 2\ndata: {"tick":1}',
      'event: tick\nid: 3\ndata: {"tick":2}',
    ]);

    // The observable completed, so Nest ends the response.
    const rest = await reader.read();
    expect(rest.done).toBe(true);
  });

  it("unsubscribes when the client disconnects (req.socket 'close')", async () => {
    const url = await startApp();
    const unsubscribed = Promise.withResolvers<void>();
    endlessUnsubscribed = unsubscribed.resolve;

    const controller = new AbortController();
    const res = await fetch(`${url}/events/endless`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const events = await readEvents(reader, 2);
    expect(events).toEqual(["id: 1\ndata: n0", "id: 2\ndata: n1"]);

    controller.abort();
    await reader.cancel().catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      unsubscribed.promise.then(() => "unsubscribed"),
      new Promise<string>((resolve) => {
        timer = setTimeout(resolve, 2000, "still subscribed");
      }),
    ]);
    clearTimeout(timer);
    endlessUnsubscribed = undefined;
    expect(outcome).toBe("unsubscribed");
  });
});

describe("@Sse() failures and silence on BunHttpAdapter", () => {
  for (const mode of ["served", "adapter.fetch()"] as const) {
    it(`${mode}: an observable that errors before its first event is a 500, not a hang`, async () => {
      const get = await client(mode);
      const res = await within(get("/edges/err-before"), 5000);

      expect(res?.status).toBe(500);
      expect(res?.headers.get("content-type")).toContain("application/json");
      expect(await res?.json()).toMatchObject({ statusCode: 500 });
    });

    it(`${mode}: a handler that throws is a 500, not a hang`, async () => {
      const get = await client(mode);
      const res = await within(get("/edges/throws"), 5000);

      expect(res?.status).toBe(500);
      expect(await res?.json()).toMatchObject({ statusCode: 500 });
    });
  }

  // Bun cuts an idle connection at a 4 s granularity, so `idleTimeout: 1`
  // cuts at ~4 s. The control proves the timeout is live on this server, so
  // the `@Sse()` stream outliving it is the exemption `SseStream` asks for
  // with `req.socket.setTimeout(0)`.
  it("served: a quiet @Sse() stream outlives idleTimeout; the control is cut", async () => {
    const url = await startApp({ idleTimeout: 1 });
    const WATCH_MS = 9000;

    const watch = async (path: string): Promise<string> => {
      const res = await fetch(`${url}${path}`);
      const reader = res.body!.getReader();
      const first = await readEvents(reader, 1);
      if (first.length !== 1) {
        return "no first event";
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        reader.read().then(
          (read) => (read.done ? "cut (done)" : "more data"),
          () => "cut (error)",
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(resolve, WATCH_MS, "open");
        }),
      ]);
      clearTimeout(timer);
      await reader.cancel().catch(() => undefined);
      return outcome;
    };

    const [sse, control] = await Promise.all([
      watch("/edges/quiet"),
      watch("/edges/quiet-control"),
    ]);
    expect(control).toMatch(/^cut/);
    expect(sse).toBe("open");
  }, 20_000);
});
