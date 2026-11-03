/**
 * `sseResponse()`: an event stream as a standalone `Response`
 * (bun-native-routes plan §16.3), for `res.send()`, a native route,
 * `Bun.serve`'s `fetch` or a test; and the headers it and `res.sse()` set.
 *
 * Browser-safe: it imports no Bun or Node API (the server it exempts is
 * typed structurally).
 */
import type { SseEvents } from "./declaration";
import type { SseSendOf, SseWriterOptions } from "./writer";
import { failSseWriter, isAsyncIterable, SseWriter } from "./writer";

/**
 * The response headers of an event stream (§16.5): the type, no caching
 * (and no transforming, unless `compress`), and nginx's buffering off.
 * Never `Connection`, which HTTP/2 forbids.
 *
 * @param compress Whether `compression()` and proxies may transform it.
 * @internal
 */
export function sseHeaders(
  compress: boolean,
): Readonly<Record<string, string>> {
  return {
    "content-type": "text/event-stream",
    "cache-control": compress ? "no-cache" : "no-cache, no-transform",
    "x-accel-buffering": "no",
  };
}

/** The part of a Bun server `sseResponse()` uses: its per-request idle timeout. */
export interface SseIdleTimeoutServer {
  /**
   * Sets `request`'s idle timeout, in seconds; `0` turns it off (Bun's
   * `server.timeout(request, seconds)`).
   */
  timeout: (request: Request, seconds: number) => void;
}

/**
 * The source of {@link sseResponse}: events to send in order (an iterable
 * or async iterable, its end closing the stream), or a function given the
 * writer, which sends what it likes and closes it when done (the stream
 * stays open after it returns).
 *
 * @typeParam C The contract, or `undefined`.
 */
export type SseSource<C extends SseEvents | undefined = undefined> =
  | readonly SseSendOf<C>[]
  | Iterable<SseSendOf<C>>
  | AsyncIterable<SseSendOf<C>>
  | ((writer: SseWriter<C>) => unknown);

/**
 * The options of {@link sseResponse}: a writer's, plus the request and
 * server it answers and the response's own status and headers.
 *
 * @typeParam C The contract, or `undefined`.
 */
export interface SseResponseInit<
  C extends SseEvents | undefined = undefined,
> extends SseWriterOptions<C> {
  /**
   * The request it answers: its signal closes the stream when the client
   * leaves, and its `Last-Event-ID` is the writer's (and `resume`'s).
   * Default: none.
   */
  readonly request?: Request;
  /**
   * The server serving `request`, to exempt it from Bun's `idleTimeout`
   * (`server.timeout(request, 0)`); a native route's handler gets it as
   * its second argument. Needs `request`. Default: none (a quiet stream is
   * then cut at Bun's idle timeout unless the heartbeat is shorter).
   */
  readonly server?: SseIdleTimeoutServer;
  /** The status. Default `200`. */
  readonly status?: number;
  /** Headers of the response; the event stream's own are added where these lack them. Default: none. */
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * An event stream as a `Response`, for a native route (`Bun.serve({ routes:
 * { "/ticks": (req, server) => sseResponse(ticks(), { request: req, server })
 * } })`), `Bun.serve`'s `fetch`, `res.send()` or a test. The source's
 * events are sent through an {@link SseWriter}, so its backpressure,
 * opening comment, heartbeat, bound and the typed client's additions
 * (`contract`, `ids`, `resume`, `retry`) all apply.
 *
 * An error of the source (a throw, a rejection, an event its contract
 * refuses) closes the stream and is logged; with `onError` the app decides
 * instead (S5). Nothing is sent about it by default.
 *
 * @param source The events, or a function given the writer.
 * @param init   The writer's options, the request and server, the status
 *   and headers.
 */
export function sseResponse<C extends SseEvents | undefined = undefined>(
  source: SseSource<NoInfer<C>>,
  init: SseResponseInit<C> = {},
): Response {
  const request = init.request;
  const writer = new SseWriter<C>({
    ...init,
    lastEventId: request?.headers.get("last-event-id"),
    signal: request?.signal,
  });
  if (init.server !== undefined && request !== undefined) {
    init.server.timeout(request, 0);
  }
  void run(writer, source);
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(
    sseHeaders(init.compress === true),
  )) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(writer.readable, {
    status: init.status ?? 200,
    headers,
  });
}

/** Sends `source` through `writer`, closing it at the end; an error goes to the writer's `onError`. */
async function run<C extends SseEvents | undefined>(
  writer: SseWriter<C>,
  source: SseSource<C>,
): Promise<void> {
  try {
    if (typeof source === "function") {
      await source(writer);
      return;
    }
    if (isAsyncIterable(source)) {
      for await (const event of source as AsyncIterable<SseSendOf<C>>) {
        if (!(await writer.send(event))) return;
      }
    } else {
      for (const event of source as Iterable<SseSendOf<C>>) {
        if (!(await writer.send(event))) return;
      }
    }
    writer.close();
  } catch (error) {
    failSseWriter(writer as unknown as SseWriter<SseEvents | undefined>, error);
  }
}
