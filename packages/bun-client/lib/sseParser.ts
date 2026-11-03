/**
 * The event-stream parser `sse()` reads with (typed-client plan, `sse.md`
 * §3.1): the HTML standard's "interpreting an event stream" rules, written
 * for the browser (no `EventSource`: it sends no custom headers, and Bun has
 * none, S-D2).
 *
 * - Lines end in CRLF, LF or CR, also across chunk boundaries (a CR ending
 *   one chunk and an LF opening the next are one line end).
 * - One leading U+FEFF (a byte order mark) is dropped.
 * - A line starting with `:` is a comment.
 * - `event:` names the event (`message` when none); `data:` lines are
 *   joined with `\n`; `id:` sets the last event ID unless its value holds a
 *   NUL; `retry:` sets the reconnection time when its value is ASCII digits
 *   only; any other field is ignored. One space after the colon is dropped.
 * - A blank line ends the block: the last event ID it set is committed
 *   ({@link SseParser.lastEventId}), and an event is dispatched. Text after
 *   the last blank line, when the stream ends, is discarded.
 *
 * **One departure, on purpose**: a block with an `event:` line and no
 * `data:` line is dispatched, its data `undefined`, where `EventSource` drops
 * it. That is how bun-common reads an event declared to carry no data
 * (`sse({ done: null })`, its `SseFramer`), and the client reads what the
 * server checks. `__tests__/sseParser.test.ts` runs this parser and
 * bun-common's `SseFramer` over one corpus, so the two cannot drift.
 *
 * @internal Not an approved name: `sse()` is the way in.
 */

/** One dispatched event, as the stream framed it. */
export interface SseMessage {
  /** The event's name: its `event:` value, or `message`. */
  readonly name: string;
  /** Its `data:` lines joined with `\n`; `undefined` with no `data:` line. */
  readonly data: string | undefined;
  /** The last event ID as of this event (`""`: none), as `MessageEvent.lastEventId` is. */
  readonly id: string;
}

/** Character code of LF. */
const LF = 10;
/** Character code of CR. */
const CR = 13;

/**
 * Parses `text/event-stream` text, chunk by chunk, into events.
 *
 * @internal
 */
export class SseParser {
  /**
   * The last event ID committed by a blank line: what a reconnection sends
   * as `Last-Event-ID` (`""`: none). Starts as the constructor's.
   */
  lastEventId: string;
  /** The last valid `retry:` value, in ms; `undefined` until one arrives. */
  retry: number | undefined;
  /** The `id:` value of the block being read (the standard's "last event ID buffer"). */
  #id: string;
  /** The line not yet ended. */
  #line = "";
  /** The previous text ended in CR, so an LF opening the next is part of that line end. */
  #afterCr = false;
  /** No text has been read yet, so a byte order mark may open it. */
  #start = true;
  /** The block's `event:` value. */
  #name = "";
  /** The block's `data:` lines. */
  #data: string[] = [];
  /** The block has an `event:` or `data:` line. */
  #isEvent = false;

  /**
   * @param lastEventId The last event ID to start from (a reconnection
   *   carries the previous stream's). Default `""`.
   */
  constructor(lastEventId = "") {
    this.lastEventId = lastEventId;
    this.#id = lastEventId;
  }

  /**
   * Feeds the next text of the stream, decoded; returns the events it
   * completed, in order.
   *
   * @param text The text (a `TextDecoder` with `ignoreBOM: true`, so this
   *   parser drops the one mark the standard allows).
   */
  push(text: string): SseMessage[] {
    const out: SseMessage[] = [];
    if (text.length === 0) return out;
    let start = 0;
    if (this.#start) {
      this.#start = false;
      if (text.charCodeAt(0) === 0xfeff) start = 1;
    }
    if (this.#afterCr) {
      this.#afterCr = false;
      if (text.charCodeAt(start) === LF) start++;
    }
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== LF && c !== CR) continue;
      this.#field(this.#line + text.slice(start, i), out);
      this.#line = "";
      if (c === CR) {
        if (i + 1 === text.length) this.#afterCr = true;
        else if (text.charCodeAt(i + 1) === LF) i++;
      }
      start = i + 1;
    }
    this.#line += text.slice(start);
    return out;
  }

  /** Handles one complete line. */
  #field(line: string, out: SseMessage[]): void {
    if (line.length === 0) {
      this.lastEventId = this.#id;
      if (this.#isEvent)
        out.push({
          name: this.#name === "" ? "message" : this.#name,
          data: this.#data.length === 0 ? undefined : this.#data.join("\n"),
          id: this.lastEventId,
        });
      this.#name = "";
      this.#data = [];
      this.#isEvent = false;
      return;
    }
    if (line.charCodeAt(0) === 58 /* ":" */) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32 /* " " */) value = value.slice(1);
    if (field === "event") {
      this.#name = value;
      this.#isEvent = true;
    } else if (field === "data") {
      this.#data.push(value);
      this.#isEvent = true;
    } else if (field === "id") {
      if (!value.includes("\0")) this.#id = value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) this.retry = Number(value);
    }
  }
}
