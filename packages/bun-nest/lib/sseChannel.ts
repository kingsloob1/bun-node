/**
 * `channelObservable()`: a bun-common broadcast channel (`createSseChannel()`)
 * as the `Observable<MessageEvent>` NestJS's `@Sse()` returns
 * (bun-native-routes plan §16.14.4, PR-sse3's delta). rxjs is Nest's
 * dependency, so this lives in bun-nest, not bun-common.
 *
 * ```ts
 * @Sse("prices")
 * prices(@Headers("last-event-id") lastEventId?: string, @SseSignal() signal?: AbortSignal) {
 *   return channelObservable(prices, { lastEventId, signal });
 * }
 * ```
 *
 * The subscriber gets the channel's initial state (or its replay after
 * `lastEventId`), then the live events; it leaves the channel when Nest
 * unsubscribes (the client left, `app.close()`), when `signal` aborts
 * (`@SseSignal()`, Nest 11.2.0 and later), and when the channel closes (the
 * observable completes, which ends Nest's stream).
 *
 * Nest formats each event per subscriber, so the channel's one encode per
 * event is lost on this path; a heavy broadcaster subscribes `@Res() res`
 * with `channel.subscribe(req, res)` instead, which keeps it.
 */
import type {
  SseChannel,
  SseEvents,
  SseMessage,
  SseSubscribeOptions,
} from "@kingsleyweb/bun-common";
import type { MessageEvent } from "@nestjs/common";
import * as common from "@nestjs/common";
import { Observable } from "rxjs";

/** The options of {@link channelObservable}: a subscriber's, plus its lifetime and heartbeat. */
export interface ChannelObservableOptions extends SseSubscribeOptions {
  /**
   * Leaves the channel and completes when it aborts: `@SseSignal()`'s
   * signal (Nest 11.2.0 and later), which aborts as the client leaves, even
   * during async setup. Default: none (Nest's own unsubscribe still ends
   * the subscription).
   */
  readonly signal?: AbortSignal;
  /**
   * The ms between heartbeat comments (`{ comment: "" }`, written as `: `)
   * on this subscriber's stream, for proxies; `0` turns them off. The
   * channel's own heartbeat reaches only writer subscribers. Sent only on a
   * Nest whose `@Sse()` writes a comment event (detected by `@SseSignal()`,
   * 11.2.0 and later; earlier releases would write it as an id-only block
   * that moves the client's `Last-Event-ID`), so on 11.1.x the adapter's
   * idle-timeout exemption is what keeps a quiet stream open. Default
   * `15_000`.
   */
  readonly heartbeatMs?: number;
}

/** Whether this Nest writes `{ comment }` events: `@SseSignal()` arrived with them (11.2.0). */
function nestWritesComments(): boolean {
  return (
    typeof (common as unknown as Record<string, unknown>).SseSignal ===
    "function"
  );
}

/**
 * A channel event as Nest's `MessageEvent`: `event` as `type`, the `id` as a
 * string, and the data as text the way bun-common writes it (a string as it
 * is, anything else `JSON.stringify`ed, so every Nest release writes it the
 * same; under a contract whose `data` is `"json"`, strings stringified too;
 * no data is `""`). A comment-only block is a comment event where Nest
 * writes those, and `undefined` (not sent) where it does not.
 *
 * @param message  The channel's event.
 * @param comments Whether this Nest writes `{ comment }` events.
 * @param json     Whether every value is `JSON.stringify`ed, strings included.
 */
function toMessageEvent(
  message: SseMessage,
  comments: boolean,
  json: boolean,
): MessageEvent | undefined {
  const { comment, data, event, id, retry } = message;
  if (data === undefined && event === undefined && comment !== undefined) {
    // Nest 11.1's `MessageEvent` has no `comment` (a comment-only event
    // needs the cast there), so the cast stays though 12's needs none.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    return comments ? ({ comment } as unknown as MessageEvent) : undefined;
  }
  const text: string | undefined =
    data === undefined
      ? undefined
      : typeof data === "string" && !json
        ? data
        : JSON.stringify(data);
  return {
    data: text ?? "",
    ...(event === undefined ? {} : { type: event }),
    ...(id === undefined ? {} : { id: String(id) }),
    ...(retry === undefined ? {} : { retry }),
  };
}

/**
 * A channel as an `@Sse()` observable: the subscriber's initial state (or
 * the replay after `lastEventId`), then live events, until the client
 * leaves, `signal` aborts or the channel closes. See the module's
 * documentation.
 *
 * @param channel The channel (`createSseChannel()` from bun-common); with a
 *   contract, its events reach Nest encoded as the contract's `data` format
 *   says, as they reach a byte subscriber.
 * @param options The subscriber's topics, `Last-Event-ID`, `signal` and heartbeat.
 * @typeParam C The channel's contract, or `undefined`.
 */
export function channelObservable<C extends SseEvents | undefined>(
  channel: SseChannel<C>,
  options: ChannelObservableOptions = {},
): Observable<MessageEvent> {
  const { signal, heartbeatMs = 15_000, topics, lastEventId } = options;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
    throw new TypeError(
      "channelObservable(): heartbeatMs must be a non-negative number",
    );
  }
  return new Observable<MessageEvent>((subscriber) => {
    if (signal?.aborted === true) {
      subscriber.complete();
      return undefined;
    }
    const comments = nestWritesComments();
    const json = channel.contract?.data === "json";
    const subscription = channel.listen(
      (message) => {
        const nest = toMessageEvent(message, comments, json);
        if (nest !== undefined) subscriber.next(nest);
      },
      {
        ...(topics === undefined ? {} : { topics }),
        ...(lastEventId === undefined || lastEventId === ""
          ? {}
          : { lastEventId }),
        onEnd: () => subscriber.complete(),
      },
    );
    let timer: ReturnType<typeof setInterval> | undefined;
    if (heartbeatMs > 0 && comments) {
      timer = setInterval(() => {
        // As in `toMessageEvent()`: Nest 11.1's type lacks `comment`.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        subscriber.next({ comment: "" } as unknown as MessageEvent);
      }, heartbeatMs);
      (timer as { unref?: () => void }).unref?.();
    }
    const onAbort = (): void => {
      subscription.unsubscribe();
      subscriber.complete();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    return () => {
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      subscription.unsubscribe();
    };
  });
}
