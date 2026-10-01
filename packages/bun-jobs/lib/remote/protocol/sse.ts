/**
 * A Server-Sent Events parser (`remote-transports.md` §7.3–§7.4), written to
 * the WHATWG HTML standard's "event stream interpretation".
 *
 * Bun has no working `EventSource`: the global is declared by `bun-types`
 * and absent at runtime, so code using it typechecks and then throws. The
 * gateway therefore reads an `http-stream` response itself, over `fetch`, and
 * parses it here. Nothing under `lib/` may name `EventSource`;
 * `__tests__/remote/remote-eventsource-ban.test.ts` holds it to that.
 *
 * What the standard says, and this does:
 *
 * - One leading U+FEFF (a byte order mark) is dropped, once, at the start of
 *   the stream.
 * - A line ends at CRLF, LF or CR, including a CR at the end of one chunk
 *   whose LF starts the next.
 * - A line starting with `:` is a comment. An empty line dispatches the
 *   event. `field: value` drops one space after the colon; a line with no
 *   colon is a field with an empty value.
 * - `data` lines are joined with LF; `event` sets the type (`message` when
 *   absent); `id` sets the last event id unless it contains NUL; `retry` is
 *   honoured only when it is all ASCII digits. Other fields are ignored.
 * - An event with no data is not dispatched, but its `id` still counts.
 * - An event still open when the stream ends is discarded.
 *
 * One thing the standard leaves to the implementation: a bound.
 * {@link SseParserOptions.maxEventLength} caps the line and data buffered for
 * one event, so a peer that never sends a line end cannot grow memory
 * without limit.
 *
 * Internal; browser-safe: it imports nothing.
 */

/** One dispatched event. */
export interface SseEvent {
  /** The event type: the `event` field, or `message`. */
  event: string;
  /** The `data` lines, joined with LF. */
  data: string;
  /** The last event id when it was dispatched: what `Last-Event-ID` resends. */
  id: string;
}

/** What {@link SseParser.push} produces, in stream order. */
export type SseItem =
  | ({
      /** A dispatched event. */
      kind: "event";
    } & SseEvent)
  | {
      /** A comment line: what an executor sends first (`: open`) and as a keepalive. */
      kind: "comment";
      /** The text after the colon, unaltered. */
      text: string;
    };

/** Options for {@link SseParser}. */
export interface SseParserOptions {
  /**
   * The most characters one event may buffer, its unfinished line included.
   * Default `8_388_608` (8 Mi). Past it {@link SseParser.push} throws a
   * `RangeError`; the caller closes the stream (`FRAME_TOO_LARGE`).
   */
  maxEventLength?: number;
}

/** {@link SseParserOptions.maxEventLength}'s default. */
const DEFAULT_MAX_EVENT_LENGTH = 8 * 1024 * 1024;

/** An incremental SSE parser: feed it decoded text in any chunks. */
export class SseParser {
  /** The last event id: the `Last-Event-ID` to reconnect with. */
  lastEventId = "";
  /** The reconnection time the stream asked for, in ms, if it has. */
  retry: number | undefined;

  /** The cap on one event's buffered characters. */
  readonly #max: number;
  /** The unfinished line carried over from the last chunk. */
  #line = "";
  /** The data buffer: each `data` value with a trailing LF. */
  #data = "";
  /** The event type buffer. */
  #event = "";
  /** The last event id buffer. */
  #idBuffer = "";
  /** Whether any text has arrived yet: the BOM is only looked for first. */
  #started = false;
  /** The last chunk ended in CR: an LF opening the next one belongs to it. */
  #skipLf = false;

  constructor(options?: SseParserOptions) {
    const max = options?.maxEventLength ?? DEFAULT_MAX_EVENT_LENGTH;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError("maxEventLength must be a positive integer");
    }
    this.#max = max;
  }

  /** Parses the next chunk of text and returns what it completed, in order. */
  push(chunk: string): SseItem[] {
    let text = chunk;
    if (!this.#started) {
      if (text.length === 0) {
        return [];
      }
      this.#started = true;
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
    }
    const out: SseItem[] = [];
    let start = 0;
    if (this.#skipLf && text.length > 0) {
      this.#skipLf = false;
      if (text.charCodeAt(0) === 10) {
        start = 1;
      }
    }
    for (let index = start; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code !== 10 && code !== 13) {
        continue;
      }
      const line = this.#line + text.slice(start, index);
      this.#line = "";
      this.#check(line.length);
      this.#interpret(line, out);
      if (code === 13) {
        if (index + 1 === text.length) {
          this.#skipLf = true;
        } else if (text.charCodeAt(index + 1) === 10) {
          index++;
        }
      }
      start = index + 1;
    }
    if (start < text.length) {
      this.#line += text.slice(start);
      this.#check(this.#line.length);
    }
    return out;
  }

  /** Ends the stream: an unfinished event is discarded, as the standard says. */
  end(): void {
    this.#line = "";
    this.#data = "";
    this.#event = "";
    this.#skipLf = false;
  }

  /** Throws when one event would buffer more than the cap. */
  #check(lineLength: number): void {
    if (lineLength + this.#data.length > this.#max) {
      this.end();
      throw new RangeError(`An SSE event is over ${this.#max} characters`);
    }
  }

  /** Interprets one complete line. */
  #interpret(line: string, out: SseItem[]): void {
    if (line.length === 0) {
      this.#dispatch(out);
      return;
    }
    const colon = line.indexOf(":");
    if (colon === 0) {
      out.push({ kind: "comment", text: line.slice(1) });
      return;
    }
    let field = line;
    let value = "";
    if (colon > 0) {
      field = line.slice(0, colon);
      value = line.slice(
        line.charCodeAt(colon + 1) === 32 ? colon + 2 : colon + 1,
      );
    }
    switch (field) {
      case "event":
        this.#event = value;
        break;
      case "data":
        this.#data += `${value}\n`;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.#idBuffer = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          this.retry = Number(value);
        }
        break;
      default:
        break;
    }
  }

  /** Dispatches the buffered event, if it has data. */
  #dispatch(out: SseItem[]): void {
    this.lastEventId = this.#idBuffer;
    if (this.#data.length === 0) {
      this.#event = "";
      return;
    }
    out.push({
      kind: "event",
      event: this.#event === "" ? "message" : this.#event,
      data: this.#data.slice(0, -1),
      id: this.lastEventId,
    });
    this.#data = "";
    this.#event = "";
  }
}

/**
 * Reads an event stream (a `fetch` response's body) as SSE items. Bytes are
 * decoded as UTF-8 across chunk boundaries, with the BOM left for the parser
 * to drop, as the standard has it. Ending the iteration early cancels the
 * stream.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  options?: SseParserOptions,
): AsyncGenerator<SseItem, void, undefined> {
  const parser = new SseParser(options);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const reader = body.getReader();
  let done = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      yield* parser.push(decoder.decode(next.value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    parser.end();
  } finally {
    if (!done) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
