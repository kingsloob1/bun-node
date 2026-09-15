/**
 * NestJS's `@Sse()` on `BunHttpAdapter`, over a served request.
 *
 * Nest's `RouterResponseController.sse` builds an `SseStream` (a Node
 * `Transform`) that calls `req.socket.setKeepAlive/setNoDelay/setTimeout`,
 * pipes into the response (`writeHead`, `flushHeaders`, `write`, `end`) and
 * waits on `req.socket.once("close")` to unsubscribe when the client leaves.
 * These tests read the stream a real client sees.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { INestApplication, MessageEvent } from "@nestjs/common";
import { Controller, Module, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { interval, map, Observable, take } from "rxjs";
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

@Module({ controllers: [EventsController] })
class AppModule {}

/** Applications to close after each test. */
const apps: INestApplication[] = [];

afterEach(async () => {
  while (apps.length) {
    await apps.pop()?.close();
  }
});

/** A Nest application on `BunHttpAdapter`, listening on an OS-assigned port. */
async function startApp(): Promise<string> {
  const app = await NestFactory.create(AppModule, new BunHttpAdapter(), {
    logger: false,
  });
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
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
