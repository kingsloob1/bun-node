/**
 * Body helpers for a response's `content` map (plan
 * `docs/plans/bun-validate/` §4.4.1, §4.4.3, V3b): a body checked chunk by
 * chunk (`chunks()`), server-sent events checked event by event (`sse()`),
 * and a body whose media type is declared but whose content is never read
 * (`opaque()`); and a status's **variants** (`variants()`, §4.4.6, V3c),
 * several whole responses for one status.
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
import type { BunRequest } from "./BunRequest";
import type { AnyContract, Schema } from "./contract/model";
import type { ResponseSpecObject, SetCookieView } from "./responseValidation";
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
// Response variants (plan §4.4.6, V3c)
// ---------------------------------------------------------------------------

/**
 * The request view a `when` takes under `commonResponses` (a router has no
 * validator, so nothing is typed): every part optional and `unknown`. Inside
 * `validate()` a `when` takes the validator's parsed parts instead.
 */
export type UntypedValid = Partial<
  Record<
    "headers" | "cookies" | "signedCookies" | "params" | "query" | "body",
    unknown
  >
>;

/**
 * What a discriminant value maps a variant to: an exact value (a string),
 * `true` (present, any value) or `null` (absent). Tried in that order.
 */
export type DiscriminantValue = string | true | null;

/**
 * A response header or `Set-Cookie` whose value selects the variant (the
 * `by` option of {@link variants}): exactly one of `header` and `cookie`.
 * `values` maps each variant to the value that selects it; a variant it
 * leaves out is selected by its own name.
 *
 * @typeParam N The variant names.
 */
export type Discriminant<N extends string = string> =
  | {
      /** The response header whose value selects the variant (matched in any letter case). */
      readonly header: string;
      /** Variant name to the value that selects it ({@link DiscriminantValue}); default: the name itself. */
      readonly values?: { readonly [K in N]?: DiscriminantValue };
    }
  | {
      /** The `Set-Cookie` name whose value selects the variant. */
      readonly cookie: string;
      /** Variant name to the value that selects it ({@link DiscriminantValue}); default: the name itself. */
      readonly values?: { readonly [K in N]?: DiscriminantValue };
    };

/** The response a `refine` sees: every part as the gate saw it. */
export interface RefineResponse {
  /** The status. */
  readonly status: number;
  /** The headers, by lower-case name (`set-cookie` is {@link cookies}), `Content-Type` included. */
  readonly headers: Readonly<Record<string, string>>;
  /** The `Set-Cookie`s, by name. */
  readonly cookies: Readonly<Record<string, SetCookieView>>;
  /** The bare media type sent; `undefined` with no `Content-Type`. */
  readonly mediaType: string | undefined;
  /** The body as the schema saw it (parsed JSON, text or bytes); `undefined` for a stream or no body. */
  readonly body: unknown;
  /** The variant the parts matched; `undefined` on a status with no variants. */
  readonly variant: string | undefined;
}

/**
 * One issue a `refine` reports. Its message is scrubbed as a schema's is,
 * against **every** part (a `refine` sees all of them): one that quotes a
 * received value is replaced by `Invalid value`.
 */
export interface RefineIssue {
  /** The part the issue is about. */
  readonly part: "status" | "headers" | "cookies" | "body";
  /** Dotted path within the part; absent (or `""`) for the part itself. */
  readonly path?: string;
  /** What is wrong. Never quote a value: it is withheld when found. */
  readonly message: string;
}

/**
 * A whole-response check, run synchronously once every part of the response
 * (of a variant, or of a plain status) passes; `undefined` or `[]` passes.
 * One that throws is a failed check (`The response could not be checked`).
 *
 * @param response Every part of the response, as the gate saw it.
 * @param req      The request.
 */
export type Refine = (
  response: RefineResponse,
  req: BunRequest,
) => readonly RefineIssue[] | undefined;

/**
 * One variant of a status: a whole response spec (V3a's `headers`,
 * `cookies`, `content`), plus when it applies and a whole-response check.
 *
 * @typeParam V The request view `when` takes: the validator's parsed parts
 *   inside `validate()`, {@link UntypedValid} under `commonResponses`.
 */
export interface VariantSpec<V = UntypedValid> extends ResponseSpecObject {
  /**
   * Makes the variant acceptable only for the requests it holds for, run at
   * the commit with `req.valid` (only the parts a validator parsed; a part
   * none parsed is `undefined`) and the request. A boolean is decided in
   * place, with no Promise made; a Promise of one is awaited, holding the
   * commit. A non-boolean, a throw or a rejection is a failed check (a `500`
   * under `"error"`, the error logged, never in an issue). Absent: the
   * variant applies to every request (a default, which no status needs).
   */
  readonly when?: (valid: V, req: BunRequest) => boolean | Promise<boolean>;
  /** What documents say about when this variant is sent (a `when` cannot be described). */
  readonly description?: string;
}

/** Marks what {@link variants} returns. */
const VARIANTS_DECL: unique symbol = Symbol.for(
  "bun-validate.responseVariants",
);

/**
 * A status's variants, as {@link variants} returns them.
 *
 * @typeParam T The variant table.
 * @typeParam B The discriminant, or `undefined`.
 * @typeParam V The request view `when` takes.
 */
export interface ResponseVariants<
  T = Readonly<Record<string, VariantSpec<never>>>,
  B = Discriminant | undefined,
  V = UntypedValid,
> {
  /** Always `"variants"`. */
  readonly kind: "variants";
  /** Variant name to its spec. */
  readonly table: T;
  /** The discriminant; `undefined` when none was given. */
  readonly by: B;
  /** A whole-response check for every variant of the status; `undefined` when none was given. */
  readonly refine: Refine | undefined;
  /** Phantom: the request view `when` takes; never present at runtime. */
  readonly __request?: (valid: V) => void;
}

/**
 * The options of {@link variants}.
 *
 * @typeParam B The discriminant, or `undefined`.
 */
export interface VariantsOptions<B = Discriminant | undefined> {
  /** A response header or cookie whose value selects the variant ({@link Discriminant}). */
  readonly by?: B;
  /** A whole-response check for every variant, after the variant's own ({@link Refine}). */
  readonly refine?: Refine;
}

/** Refuses an unknown key in a variant (a `const` generic skips excess-property checks). */
type StrictTable<T> = {
  readonly [N in keyof T]: {
    readonly [K in keyof T[N]]: K extends keyof VariantSpec<unknown>
      ? T[N][K]
      : never;
  };
};

/** Refuses a `values` key that names no variant. */
type StrictBy<B, N extends string> = B extends { values: infer M }
  ? {
      readonly by?: {
        readonly values?: {
          readonly [K in keyof M]: K extends N ? M[K] : never;
        };
      };
    }
  : unknown;

/**
 * Declares a status's **variants**: several whole responses, of which a
 * response must match exactly one, never a part from one and a part from
 * another. A variant is acceptable for a response when it is **selected**
 * (the one `res.variant()` named, else the one the discriminant `by`
 * selects, else every variant), **applies** (its `when` holds for the
 * request) and **matches whole** (its headers, cookies, media type and body,
 * then its `refine` and the status's). No acceptable variant is a mismatch:
 * there is no fallback, and a variant with no `when` (a default) is only
 * declared when wanted.
 *
 * ```ts
 * validate({ headers: z.object({ "x-admin": z.literal("1").optional() }) }, {
 *   responses: {
 *     200: variants({
 *       admin: {
 *         when: (valid) => valid.headers["x-admin"] === "1",
 *         content: { "application/json": AdminView },
 *       },
 *       user: { content: { "application/json": UserView } },
 *     }, { by: { header: "x-view" } }),
 *   },
 * });
 * ```
 *
 * `V`, the request view each `when` takes, is inferred from where the call
 * sits: `validate()`'s schemas, with nothing restated; outside a validator
 * (`commonResponses`) it is {@link UntypedValid}. Declaration mistakes (an
 * empty table, two variants on one discriminant value, a `values` key naming
 * no variant, an unknown key) throw a `TypeError` when the responses are
 * declared.
 *
 * @param table   Variant name to its {@link VariantSpec}.
 * @param options `by` (a {@link Discriminant}) and `refine`.
 */
export function variants<
  const T extends Readonly<Record<string, VariantSpec<V>>>,
  const B extends Discriminant<keyof T & string> | undefined = undefined,
  V = UntypedValid,
>(
  table: T & StrictTable<T>,
  options?: VariantsOptions<B> & StrictBy<B, keyof T & string>,
): ResponseVariants<T, NoInfer<B>, V> {
  if (!isPlainObject(table)) {
    throw new TypeError("variants(): expected an object of variant names");
  }
  if (options !== undefined && !isPlainObject(options)) {
    throw new TypeError("variants(): options must be an object");
  }
  const out: ResponseVariants<T, B, V> = {
    kind: "variants",
    table,
    by: options?.by as B,
    refine: options?.refine,
  };
  Object.defineProperty(out, VARIANTS_DECL, { value: true, enumerable: false });
  return out;
}

/**
 * Whether `value` came from {@link variants}. Internal.
 *
 * @internal
 */
export function isResponseVariants(value: unknown): value is ResponseVariants {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [VARIANTS_DECL]?: unknown })[VARIANTS_DECL] === true
  );
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
