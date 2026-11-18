/**
 * Fixtures for the events screens' tests (the events list, its drawer, its
 * live chip, the automatic bans): events in the API's real shape, a paged
 * `GET /analytics/events`, and a live stream that opens a fresh SSE
 * response per `/live` call (the stream reconnects when a screen asks for
 * the `events` topic).
 */
import type { EventDto } from "../../../app/security/screens/events/eventFilters";
import type { MockCall, MockHandler } from "./mockApi";

/** A user's key and an API key's key, as the API reports them (32 hex). */
export const USER_KEY = "0123456789abcdef0123456789abcdef";
export const API_KEY_KEY = "fedcba9876543210fedcba9876543210";

/** An event, whole (as `events:read` sees it). */
export function eventFixture(overrides: Partial<EventDto> = {}): EventDto {
  return {
    id: "ev1",
    at: Date.UTC(2026, 10, 17, 10, 0, 0),
    service: "checkout",
    action: "block",
    rule: "login-ladder",
    route: "POST /login",
    subjects: { ip: "203.0.113.7", user: USER_KEY },
    country: "NG",
    asn: 64500,
    status: 403,
    latencyMs: 2,
    dryRun: false,
    ...overrides,
  };
}

/** A page of events. */
export interface EventPage {
  /** The rows. */
  readonly items: readonly EventDto[];
  /** The next page's cursor. */
  readonly next?: string;
}

/**
 * `GET /analytics/events` over pages keyed by the cursor asked for
 * (`"first"` for none); `pick` may choose another table per call (by its
 * filters). Every call is recorded in `api.calls`.
 */
export function pagedEvents(pages: Record<string, EventPage>): MockHandler {
  return (call: MockCall) => {
    const page = pages[call.query.get("cursor") ?? "first"];
    return page === undefined
      ? {
          status: 400,
          body: {
            type: "urn:bun-security:problem:invalid_request",
            title: "invalid_request",
            status: 400,
            code: "invalid_request",
          },
        }
      : { body: page };
  };
}

/** The `GET /analytics/events` calls in `calls`. */
export function eventReads(calls: readonly MockCall[]): MockCall[] {
  return calls.filter((call) => call.path === "/analytics/events");
}

/**
 * The topics a `/live` call asked for, in either of bun-client's array
 * forms (`topics=a&topics=b`, or `topics[0]=a`).
 */
export function topicsOf(call: MockCall): string[] {
  return [...call.query.entries()]
    .filter(([key]) => key === "topics" || /^topics\[\d+\]$/.test(key))
    .map(([, value]) => value);
}

/** A live stream: a fresh SSE response per `/live` call; `send` writes to every open one. */
export function liveStreams() {
  const encoder = new TextEncoder();
  const open: {
    topics: string[];
    controller: ReadableStreamDefaultController<Uint8Array>;
  }[] = [];
  let seq = 0;
  const route: MockHandler = (call) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    open.push({ topics: topicsOf(call), controller });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  /** Writes `event` with `data` to every stream still open. */
  const send = (event: string, data: unknown) => {
    seq += 1;
    const frame = encoder.encode(
      `id: e1:${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
    for (const stream of open) {
      try {
        stream.controller.enqueue(frame);
      } catch {
        // The client closed it (it reconnected with other topics).
      }
    }
  };
  /** A live `event` message carrying `event`, as the hub sends it. */
  const sendEvent = (event: EventDto, topic = "events:global") =>
    send("event", { topic, epoch: "e1", seq: seq + 1, event });
  /** Whether a stream asking for `topic` has been opened. */
  const opened = (topic: string) =>
    open.some((stream) => stream.topics.includes(topic));
  /** Ends every stream. */
  const end = () => {
    for (const stream of open) {
      try {
        stream.controller.close();
      } catch {
        // Already closed.
      }
    }
  };
  return { route, send, sendEvent, opened, end };
}
