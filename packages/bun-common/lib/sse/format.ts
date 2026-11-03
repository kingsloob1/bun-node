/**
 * The `text/event-stream` wire format, written (bun-native-routes plan
 * §16.5): the HTML standard's "Server-sent events" event stream format.
 *
 * - One `data:` line per line of the payload, split on CRLF, CR or LF (all
 *   three end a line for a parser). A string is sent as it is; anything else
 *   is `JSON.stringify`ed first, unless the caller encodes it (a typed
 *   writer's `data: "json"` contract stringifies strings too). `""` and `0`
 *   are sent (`data:` / `data: 0`), unlike NestJS's encoder.
 * - An event with an `event:` and no data still gets one empty `data:`
 *   line: the standard drops a block whose data buffer is empty, so without
 *   it `EventSource` (and any parser that follows the standard) would never
 *   see the event. bun-common's response check and bun-client read that
 *   empty data as "no data" for an event declared `null`.
 * - Each block ends in a blank line; only LF is written.
 * - `event` and `id` must not hold CR or LF, and `id` no NUL (a parser
 *   ignores such an id): they throw a `TypeError` rather than being
 *   rewritten, because a silent rewrite breaks resumption.
 * - `retry` is a non-negative integer of milliseconds.
 * - A comment is `: text`, one per line; an empty one is `:` (the
 *   heartbeat).
 * - The byte order mark is never written.
 *
 * Browser-safe: it imports nothing.
 */

/**
 * One block of an event stream: an event, a comment, or an `id:`/`retry:`
 * on its own. Every field is optional; a block with only `comment` is a
 * comment, and one with only `id` or `retry` sets them without being an
 * event.
 */
export interface SseMessage {
  /**
   * The event's data. A string is sent as it is; anything else is
   * `JSON.stringify`ed. Each line becomes one `data:` line. `undefined`:
   * no data (an event with an `event:` still gets one empty `data:` line).
   */
  readonly data?: unknown;
  /** The `event:` name; a client calls an event without one `message`. No CR or LF. */
  readonly event?: string;
  /**
   * The `id:`, which the client sends back as `Last-Event-ID` when it
   * reconnects. A number is written in decimal (it must be finite). No CR,
   * LF or NUL. `""` resets the client's last event ID.
   */
  readonly id?: string | number;
  /** The `retry:` reconnection delay, in ms: a non-negative integer. */
  readonly retry?: number;
  /** A comment (`: text`), one line per line of it; clients ignore it. `""` is the bare `:`. */
  readonly comment?: string;
}

/** Any line end a parser honours. */
const LINE_END = /\r\n|\r|\n/;

/** A line end, which `event` and `id` must not hold. */
const BAD_FIELD = /[\r\n]/;

/**
 * `text` as `prefix` lines: `prefix: line` per line, bare `prefix` for an
 * empty one.
 */
function lines(prefix: string, text: string): string {
  let out = "";
  for (const line of text.split(LINE_END)) {
    out += line.length === 0 ? `${prefix}\n` : `${prefix} ${line}\n`;
  }
  return out;
}

/**
 * The text of one block, ending in its blank line, with `data` as given.
 * Shared by {@link formatSseEvent} and the typed writer, which encodes its
 * data by its contract first.
 *
 * @param message The block.
 * @param data    Its data as text; `undefined` for none.
 * @internal
 */
export function formatSseBlock(
  message: SseMessage,
  data: string | undefined,
): string {
  let out = "";
  const { comment, event, id, retry } = message;
  if (comment !== undefined) {
    out += lines(":", String(comment));
  }
  if (event !== undefined) {
    if (typeof event !== "string" || BAD_FIELD.test(event)) {
      throw new TypeError(
        "formatSseEvent(): event must be a string without CR or LF",
      );
    }
    out += `event: ${event}\n`;
  }
  if (id !== undefined) {
    if (typeof id === "number" && !Number.isFinite(id)) {
      throw new TypeError("formatSseEvent(): a numeric id must be finite");
    }
    const text = String(id);
    if (BAD_FIELD.test(text) || text.includes("\0")) {
      throw new TypeError(
        "formatSseEvent(): id must not contain CR, LF or NUL",
      );
    }
    out += text.length === 0 ? "id:\n" : `id: ${text}\n`;
  }
  if (retry !== undefined) {
    if (!Number.isSafeInteger(retry) || retry < 0) {
      throw new TypeError(
        "formatSseEvent(): retry must be a non-negative integer of milliseconds",
      );
    }
    out += `retry: ${retry}\n`;
  }
  if (data !== undefined) {
    out += lines("data:", data);
  } else if (event !== undefined) {
    // A named event with no data: one empty data line, so a standard parser
    // dispatches it.
    out += "data:\n";
  }
  return `${out}\n`;
}

/**
 * The data of an untyped message as text: a string as it is, anything else
 * `JSON.stringify`ed; `undefined` for none (and for a value JSON cannot
 * represent, such as a function).
 *
 * @param data The message's data.
 * @internal
 */
export function sseDataText(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  if (typeof data === "string") return data;
  // `undefined` for a value JSON cannot represent, whatever the lib's type says.
  const text: string | undefined = JSON.stringify(data);
  return text;
}

/**
 * The text of one block of an event stream, ending in its blank line (see
 * the module's rules). Throws a `TypeError` for an `event` or `id` holding a
 * line end (or an `id` a NUL), a `retry` that is not a non-negative
 * integer, and whatever `JSON.stringify` throws for its data (a `BigInt`, a
 * cycle).
 *
 * ```ts
 * formatSseEvent({ event: "tick", id: 7, data: { n: 1 } });
 * // "event: tick\nid: 7\ndata: {\"n\":1}\n\n"
 * ```
 *
 * @param message The block.
 */
export function formatSseEvent(message: SseMessage): string {
  return formatSseBlock(message, sseDataText(message.data));
}

/** One encoder for every block. */
const encoder = new TextEncoder();

/**
 * {@link formatSseEvent}, encoded as UTF-8 once: for sending one event to
 * many streams, where each writer's `send(bytes)` then queues the same bytes.
 *
 * @param message The block.
 */
export function encodeSseEvent(message: SseMessage): Uint8Array {
  return encoder.encode(formatSseEvent(message));
}
