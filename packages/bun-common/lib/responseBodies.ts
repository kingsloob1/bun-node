/**
 * Body helpers for a response's `content` map (plan
 * `docs/plans/bun-validate/` §4.4.1, §4.4.3, V3b): a body checked chunk by
 * chunk (`chunks()`), server-sent events checked event by event (`sse()`),
 * and a body whose media type is declared but whose content is never read
 * (`opaque()`).
 *
 * ```ts
 * validate({}, {
 *   responses: {
 *     200: { content: {
 *       "application/x-ndjson": chunks(Row, { framing: "ndjson" }),
 *       "text/event-stream": sse({ tick: Tick, done: null }),
 *       "image/png": opaque(),
 *     } },
 *     201: opaque("image/png"), // = { content: { "image/png": opaque() } }
 *   },
 * });
 * ```
 *
 * Each helper returns a Standard Schema, so it sits in a media map like any
 * other schema; the response gate (`lib/responseValidation.ts`) reads its
 * kind and checks the body accordingly. Its own `validate` is not how it is
 * checked: run directly, a `chunks()` or `sse()` value refuses every value
 * (it describes a stream, not one value), and `opaque()` accepts any.
 *
 * Nothing here imports a Bun or Node API.
 */
import type { AnyContract, Schema } from "./contract/model";
import type { StandardSchemaV1 } from "./types/standardSchema";
import { parseMediaKey } from "./contract/media";
import { markKind, markNested } from "./contract/schemas";
import { sseTransport } from "./contract/sse";
import { isSchema } from "./contract/transport";

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/**
 * How a `chunks()` body is cut into the values its schema checks:
 *
 * - `"raw"`: each chunk as it is written (`res.write(chunk)`) or as the
 *   piped stream yields it. The schema sees a `string` when the response's
 *   media type is textual (`text/*`, `application/json`, `*+json`), decoded
 *   as UTF-8 across chunk boundaries, and a `Uint8Array` otherwise.
 * - `"ndjson"`: newline-delimited JSON. The bytes are split into lines across
 *   chunk boundaries (a trailing `\r` dropped, blank lines skipped), and each
 *   line is parsed as JSON; the schema sees the parsed value. A line that is
 *   not JSON is a mismatch, and a last line without its `\n` is checked when
 *   the stream ends.
 */
export type ChunkFraming = "raw" | "ndjson";

/** Options of {@link chunks}. */
export interface ChunksOptions<F extends ChunkFraming = ChunkFraming> {
  /** How the body is cut into checked values ({@link ChunkFraming}). Default `"raw"`. */
  readonly framing?: F;
}

/**
 * How an `sse()` event's `data` reaches its schema: `"json"` parses the
 * event's data (its `data:` lines joined with `\n`) as JSON, and a data that
 * does not parse is a mismatch; `"text"` hands the schema the string as it is.
 */
export type SseDataFormat = "json" | "text";

/** Options of {@link sse}. */
export interface SseOptions<D extends SseDataFormat = SseDataFormat> {
  /** How each event's `data` is decoded for its schema ({@link SseDataFormat}). Default `"json"`. */
  readonly data?: D;
}

/** An `sse()` declaration's events: name to the schema of its `data`, or `null` for an event that carries none. */
export type SseEventMap = Readonly<Record<string, StandardSchemaV1 | null>>;

/** A streamed body checked chunk by chunk: what {@link chunks} returns. */
export interface StreamChunks<
  S extends StandardSchemaV1 = StandardSchemaV1,
  F extends ChunkFraming = ChunkFraming,
> extends StandardSchemaV1<unknown, unknown> {
  /** Always `"chunks"`. */
  readonly kind: "chunks";
  /** The schema each chunk (or each NDJSON line) must pass. */
  readonly chunk: S;
  /** How the body is cut into checked values. */
  readonly framing: F;
}

/** A `text/event-stream` body checked event by event: what {@link sse} returns. */
export interface SseEvents<
  E extends SseEventMap = SseEventMap,
  D extends SseDataFormat = SseDataFormat,
> extends StandardSchemaV1<unknown, unknown> {
  /** Always `"sse"`. */
  readonly kind: "sse";
  /** The declared events (`message` is the name of an event with no `event:` line). */
  readonly events: E;
  /** How each event's `data` is decoded. */
  readonly data: D;
}

/**
 * A body declared by its media type alone and never read: what {@link opaque}
 * returns. `M` is the media type `opaque(mediaType)` was given, or
 * `undefined` for `opaque()`.
 */
export interface OpaqueBody<
  M extends string | undefined = string | undefined,
> extends StandardSchemaV1<unknown, unknown> {
  /** Always `"opaque"`. */
  readonly kind: "opaque";
  /**
   * The media type `opaque(mediaType)` was given, as written; `undefined`
   * for `opaque()`. With one, the value is a whole status's spec (`200:
   * opaque("image/png")`), not a `content` map's value.
   */
  readonly mediaType: M;
}

/** Any of the three body helpers' declarations. */
export type BodyDeclaration = StreamChunks | SseEvents | OpaqueBody;

/** Whether `value` is a plain object (a literal, or one with a null prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The `~standard` of a helper that describes a stream: run directly, it refuses every value. */
function streamProps(vendor: string): StandardSchemaV1.Props<unknown, unknown> {
  return {
    version: 1,
    vendor,
    validate: () => ({
      issues: [
        {
          message:
            "A streamed body is checked chunk by chunk by the response gate, not as one value",
        },
      ],
    }),
  };
}

/**
 * Declares a body checked **chunk by chunk** as it streams: each `write()`
 * of a stream opened with `write()`/`flushHeaders()`, each chunk of a piped
 * `ReadableStream`, Node `Readable` or async iterable, or, with `framing:
 * "ndjson"`, each line. A buffered body (`send(text)`, `json()`, bytes, a
 * `Blob`) sent under it is checked as a stream of one chunk.
 *
 * Under `responseValidation: "error"`, a chunk that fails before anything
 * was sent (the first `write()`, or a buffered body) refuses the response
 * with a clean `500`; after the stream has started it is cut off
 * (`res.destroy()`, or the piped stream errored) and logged at `error`.
 * `"warn"` logs the first mismatch of each stream and sends everything.
 *
 * @param chunk   The schema each chunk (or line) must pass.
 * @param options `framing` ({@link ChunkFraming}); default `"raw"`.
 */
export function chunks<
  S extends StandardSchemaV1,
  const F extends ChunkFraming = "raw",
>(chunk: S, options?: ChunksOptions<F>): StreamChunks<S, F> {
  if (!isSchema(chunk)) {
    throw new TypeError("chunks(): expected a Standard Schema");
  }
  const framing = (options?.framing ?? "raw") as F;
  if (framing !== "raw" && framing !== "ndjson") {
    throw new TypeError('chunks(): framing must be "raw" or "ndjson"');
  }
  const out: StreamChunks<S, F> = {
    kind: "chunks",
    chunk,
    framing,
    "~standard": streamProps("bun-common/chunks"),
  };
  return markKind(out, "chunks");
}

/**
 * Declares a `text/event-stream` body checked **event by event**: the bytes
 * are framed into events across chunk boundaries (lines ending in CRLF, LF
 * or CR; a blank line ends an event; comments, and blocks with only `id:` or
 * `retry:`, are not events), the schema is chosen by the event's name
 * (`message` when it has no `event:` line), and its `data` is decoded as
 * `options.data` says. An undeclared name is a mismatch; a `null` event must
 * carry no data. An event the stream ends in the middle of is not checked
 * (a client never dispatches it).
 *
 * Under `"error"` the stream stops at the bad event: the write (or piped
 * chunk) completing it is not sent, and the stream is cut off and logged at
 * `error`. Its events are listed by `describeContract` as the row's `nested`
 * rows, keyed by `event` with the parts `data` and `id`.
 *
 * @param events  Event name to the schema of its `data`, or `null`.
 * @param options `data` ({@link SseDataFormat}); default `"json"`.
 */
export function sse<
  const E extends SseEventMap,
  const D extends SseDataFormat = "json",
>(events: E, options?: SseOptions<D>): SseEvents<E, D> {
  if (!isPlainObject(events)) {
    throw new TypeError("sse(): expected an object of event names");
  }
  const outbound: Record<string, { data: Schema | null }> = {};
  for (const [name, schema] of Object.entries(events)) {
    if (/[\r\n]/.test(name)) {
      throw new TypeError(
        `sse(): ${JSON.stringify(name)} is not an event name (it holds a line break)`,
      );
    }
    if (schema !== null && !isSchema(schema)) {
      throw new TypeError(
        `sse(): event ${JSON.stringify(name)} must be a Standard Schema or null`,
      );
    }
    outbound[name] = { data: schema };
  }
  const data = (options?.data ?? "json") as D;
  if (data !== "json" && data !== "text") {
    throw new TypeError('sse(): data must be "json" or "text"');
  }
  const out: SseEvents<E, D> = {
    kind: "sse",
    events,
    data,
    "~standard": streamProps("bun-common/sse"),
  };
  const contract: AnyContract = sseTransport.contract({ outbound } as never);
  return markNested(markKind(out, "sse"), contract);
}

/**
 * Declares a media type whose body is **never read**: a file, an image, a
 * `Blob`, a proxied `Response`. The status, headers, cookies and media type
 * are checked as for any body; the content is not, so nothing is held to
 * read it.
 *
 * Two spellings, the same contract:
 *
 * - `content: { "image/png": opaque() }`: a `content` map's value, the key
 *   being the media type.
 * - `200: opaque("image/png")`: a whole status's spec, shorthand for
 *   exactly `200: { content: { "image/png": opaque() } }` (the same check,
 *   the same `send()` type, the same `describeContract` rows).
 *
 * `mediaType` is checked as a `content` key is (`type/subtype`, `type/*` or
 * `*\/*`, parameters allowed); anything else throws a `TypeError` here.
 * `opaque(mediaType)` as a `content` map's value throws a `TypeError` when
 * the responses are declared: the key already names the media type, and a
 * second one could only disagree with it. `opaque()` with no media type as a
 * whole status's spec is, like any bare schema there, an `application/json`
 * body (never read).
 *
 * @param mediaType The media type, for the status-level shorthand; omit it
 *                  inside a `content` map.
 */
export function opaque<
  const M extends `${string}/${string}` | undefined = undefined,
>(mediaType?: M): OpaqueBody<M> {
  if (mediaType !== undefined) {
    if (
      typeof mediaType !== "string" ||
      parseMediaKey(mediaType) === undefined
    ) {
      throw new TypeError(
        `opaque(): ${JSON.stringify(mediaType)} is not a media type (type/subtype, type/* or */*)`,
      );
    }
  }
  const out: OpaqueBody<M> = {
    kind: "opaque",
    mediaType: mediaType as M,
    "~standard": {
      version: 1,
      vendor: "bun-common/opaque",
      validate: (value: unknown) => ({ value }),
    },
  };
  return markKind(out, "opaque");
}

// ---------------------------------------------------------------------------
// Framing (internal)
// ---------------------------------------------------------------------------

/** One SSE event as framed: its name (`message` by default) and its data, `undefined` with no `data:` line. */
export interface SseFrame {
  /** The event's name. */
  readonly name: string;
  /** Its `data:` lines joined with `\n`; `undefined` when it has none. */
  readonly data: string | undefined;
}

/** Character codes of the line ends. */
const LF = 10;
/** Character codes of the line ends. */
const CR = 13;

/**
 * Frames `text/event-stream` text into events across chunk boundaries, as
 * the HTML standard's event-stream parser does (lines end in CRLF, LF or CR;
 * a CR at the end of one chunk and an LF at the start of the next are one
 * line end). Internal.
 *
 * @internal
 */
export class SseFramer {
  /** The current line, not yet ended. */
  #line = "";
  /** Set when the last text ended in CR, so an LF opening the next one is part of that line end. */
  #afterCr = false;
  /** The current event's `event:` value. */
  #name = "";
  /** The current event's `data:` lines. */
  #data: string[] = [];
  /** Whether the current block has an `event:` or `data:` field (comments, `id:` and `retry:` alone make no event). */
  #isEvent = false;

  /**
   * Feeds the next text of the stream; returns the events it completed.
   *
   * @param text The text, decoded.
   */
  push(text: string): SseFrame[] {
    const out: SseFrame[] = [];
    if (text.length === 0) return out;
    let start = 0;
    if (this.#afterCr) {
      this.#afterCr = false;
      if (text.charCodeAt(0) === LF) start = 1;
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
  #field(line: string, out: SseFrame[]): void {
    if (line.length === 0) {
      if (this.#isEvent) {
        out.push({
          name: this.#name === "" ? "message" : this.#name,
          data: this.#data.length === 0 ? undefined : this.#data.join("\n"),
        });
      }
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
    }
  }
}

/**
 * Splits text into lines across chunk boundaries, for NDJSON: lines end in
 * LF, a CR before it is dropped. Internal.
 *
 * @internal
 */
export class LineFramer {
  /** The current line, not yet ended. */
  #line = "";

  /**
   * Feeds the next text; returns the lines it completed.
   *
   * @param text The text, decoded.
   */
  push(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (
      let end = text.indexOf("\n");
      end !== -1;
      end = text.indexOf("\n", start)
    ) {
      out.push(trimCr(this.#line + text.slice(start, end)));
      this.#line = "";
      start = end + 1;
    }
    this.#line += text.slice(start);
    return out;
  }

  /** The last line, when the stream ended without its `\n`; `undefined` when there is none. */
  end(): string | undefined {
    const line = trimCr(this.#line);
    this.#line = "";
    return line.length === 0 ? undefined : line;
  }
}

/** A line without its trailing CR. */
function trimCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
