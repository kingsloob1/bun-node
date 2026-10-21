/**
 * Response contracts for HTTP (plan `docs/plans/bun-validate/` §4.4, V3a and
 * V3b): what `validate(schemas, { responses })` declares per status, how it
 * is compiled once, and the gate `BunResponse` consults at its single commit
 * point (its private `response` setter, which every producer passes
 * through) for the status, the headers, the `Set-Cookie`s, the media type
 * and the body, and then, for a streamed body declared with `chunks()` or
 * `sse()`, at each chunk (plan §4.4.2's chunk gate).
 *
 * Every body kind is checked: `json()`, `send()` of an object, a string,
 * bytes, a `Blob` (read with `arrayBuffer()`), a native `Response` (read
 * through `clone()`) and `sendFile()`'s bytes against a whole-body schema;
 * a piped stream and a `write()`/`end()` stream chunk by chunk under
 * `chunks()`/`sse()`. A stream against a whole-body schema is never
 * buffered: it is skipped, with one warning per route (plan Q-H4).
 * `opaque()` declares a media type whose content is never read.
 *
 * Only `ResponseValidationError` and the declaration types are exported from
 * the package (plan §9's approved names), with the body helpers of
 * `lib/responseBodies.ts`.
 */
import type {
  BunResponse,
  BunResponseChunk,
  ResponseCommit,
  ResponseGate,
  ResponseStreamCheck,
} from "./BunResponse";
import type { MediaKey, MediaMatcher } from "./contract/media";
import type {
  MaybePromise,
  Policy,
  Schema,
  StandardOutcome,
  ValidationIssue,
} from "./contract/model";
import type { IssueFormat } from "./contract/issues";
import type { Logger } from "./logging";
import type { SseEvents, StreamChunks } from "./responseBodies";
import type { StandardSchemaV1 } from "./types/standardSchema";
import { ContractError } from "./contract/guard";
import { runSchema } from "./contract/issues";
import { bareMediaType, compileMediaMap } from "./contract/media";
import { isDocumented, kindOf, opaqueMediaType } from "./contract/schemas";
import { isSchema } from "./contract/transport";
import { LineFramer, opaque, SseFramer } from "./responseBodies";

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/**
 * Runtime response checks: `"off"` checks nothing (and installs nothing),
 * `"warn"` sends the response and logs each mismatch once, `"error"`
 * refuses a mismatching response before anything is sent.
 */
export type ResponseValidationMode = Policy;

/** One status's contract in full. Every part is optional; an omitted part is not checked. */
export interface ResponseSpecObject {
  /**
   * The response headers, as an object keyed by **lower-case** name, each
   * value a string (repeated values comma-joined), `Content-Type` included
   * even when Bun sets it implicitly. `Set-Cookie` is not here: it is
   * {@link cookies}.
   */
  readonly headers?: StandardSchemaV1;
  /**
   * The `Set-Cookie`s, as an object keyed by cookie name, each a
   * {@link SetCookieView} (`{ value, httpOnly, secure, partitioned, sameSite?,
   * path?, domain?, maxAge?, expires?, priority? }`). A name set twice is its
   * last line.
   */
  readonly cookies?: StandardSchemaV1;
  /**
   * The body, by media type (`"application/json"`, `"text/*"`, `"*\/*"`):
   * matched case-insensitively with parameters stripped on both sides, the
   * most specific key winning (exact, then `type/*`, then `*\/*`); a media
   * type no key matches is a mismatch. Each value is a whole-body schema,
   * `chunks(S)` (a stream checked per chunk), `sse({...})` (server-sent
   * events checked per event), `opaque()` (declared, never read), or `null`
   * (this media type with an empty body). `content: null`: the status has
   * no body. Omitted: the body is not checked. `opaque(mediaType)` is refused
   * here (a type error, and a `TypeError` at declaration): the key already
   * names the media type.
   */
  readonly content?: Readonly<Record<string, ContentValue>> | null;
}

/**
 * A `content` map's value: a schema or a body helper, but not an
 * `opaque(mediaType)` (whose media type would be a second one), or `null`.
 */
type ContentValue =
  | (StandardSchemaV1 & {
      /** Only `opaque(mediaType)` sets it; a `content` map's value never does. */
      readonly mediaType?: undefined;
    })
  | null;

/**
 * One status's contract: a schema (shorthand for `{ content: {
 * "application/json": schema } }`), `opaque(mediaType)` (shorthand for `{
 * content: { [mediaType]: opaque() } }`), `null` (no body), or the full
 * {@link ResponseSpecObject}.
 */
export type ResponseSpec = StandardSchemaV1 | null | ResponseSpecObject;

/** The declared responses, by status code (100–599). A status not listed is a mismatch. */
export type ResponseSchemas = Readonly<Record<number, ResponseSpec>>;

/**
 * One `Set-Cookie` line as a `cookies` schema sees it: the value as written
 * (URL-decoded, a `j:` or `s:` prefix kept) and its attributes, named after
 * `res.cookie()`'s options. The flags are always present; the others only
 * when the line carries them.
 */
export interface SetCookieView {
  /** The cookie's value as written: URL-decoded, `j:`/`s:` prefixes kept. */
  value: string;
  /** Whether the line has `HttpOnly`. */
  httpOnly: boolean;
  /** Whether the line has `Secure`. */
  secure: boolean;
  /** Whether the line has `Partitioned`. */
  partitioned: boolean;
  /** `SameSite`, canonically capitalised (`"Strict"`, `"Lax"`, `"None"`); absent when the line has none. */
  sameSite?: string;
  /** `Path`, as written. */
  path?: string;
  /** `Domain`, as written. */
  domain?: string;
  /**
   * `Max-Age` in **seconds**, as the header carries it (`res.cookie()`'s
   * `maxAge` option is milliseconds; it writes `floor(ms / 1000)`).
   */
  maxAge?: number;
  /** `Expires`, parsed into a `Date`. */
  expires?: Date;
  /** `Priority`, canonically capitalised (`"Low"`, `"Medium"`, `"High"`). */
  priority?: string;
}

/** The parts of a response an issue can be about: the status (the key field), then each part. */
type ResponsePart = "status" | "headers" | "cookies" | "body";

/**
 * A response broke its contract under `responseValidation: "error"`. It
 * reaches the app's error handlers through `next(err)` (with none, the
 * adapter answers 500, and `router.fetch()` rejects with it). Like every
 * issue of the contract core, its issues and message never carry what the
 * response held: a vendor message quoting it is replaced.
 */
export class ResponseValidationError extends ContractError {
  /** Every mismatch found, each naming its part (`target`) and the status (`key`). */
  declare readonly issues: readonly ValidationIssue<ResponsePart>[];
  /** The status the refused response was going to have. */
  readonly responseStatus: number;
  /** The status to answer with: always `500`, the server's fault. */
  readonly status = 500;

  /**
   * @param issues         The mismatches found.
   * @param responseStatus The refused response's status.
   */
  constructor(
    issues: readonly ValidationIssue<ResponsePart>[],
    responseStatus: number,
  ) {
    super(issues, {
      transport: "http",
      side: "outbound",
      key: String(responseStatus),
      policy: "error",
    });
    this.name = "ResponseValidationError";
    this.message = `Response validation failed (status ${responseStatus}) — ${issues
      .map((i) => `${i.target}${i.path ? `.${i.path}` : ""}: ${i.message}`)
      .join("; ")}`;
    this.responseStatus = responseStatus;
  }
}

// ---------------------------------------------------------------------------
// Compiling a declaration
// ---------------------------------------------------------------------------

/**
 * One status as the HTTP transport's outbound side declares it: the parts
 * `headers`, `cookies` and `body` (a media map, or `null`). A part absent is
 * not declared.
 */
export interface OutboundParts {
  /** The headers schema. */
  headers?: Schema;
  /** The `Set-Cookie` view schema. */
  cookies?: Schema;
  /** The body by media type (a media type mapped to `null` carries no body), or `null` for none. */
  body?: Readonly<Record<string, Schema | null>> | null;
}

/** A declared response table in contract form: status (as a string) to its parts. */
export type OutboundDef = Readonly<Record<string, OutboundParts>>;

/** The statuses a response can have. */
const MIN_STATUS = 100;
/** The statuses a response can have. */
const MAX_STATUS = 599;

/** Whether `value` is a plain object (a literal, or one with a null prototype). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** The keys a {@link ResponseSpecObject} takes. */
const SPEC_KEYS = new Set(["headers", "cookies", "content"]);

/**
 * Checks a `responses` (or `commonResponses`) declaration and turns it into
 * the HTTP transport's outbound form. Throws a `TypeError` naming the
 * mistake: a key that is not a status, a spec that is none of the three
 * forms, an unknown spec key, a part that is not a Standard Schema, a media
 * key that is not a media type, or two media keys that tie.
 *
 * @param responses The declaration, as given.
 * @param where     Names it in errors (`validate().responses`).
 */
export function toOutboundDef(responses: unknown, where: string): OutboundDef {
  if (!isPlainObject(responses)) {
    throw new TypeError(`${where}: expected an object keyed by status code`);
  }
  const out: Record<string, OutboundParts> = {};
  for (const [key, spec] of Object.entries(responses)) {
    const status = Number(key);
    if (!/^\d{3}$/.test(key) || status < MIN_STATUS || status > MAX_STATUS) {
      throw new TypeError(
        `${where}: ${JSON.stringify(key)} is not a status code (100–599)`,
      );
    }
    const at = `${where}[${key}]`;
    if (spec === null) {
      out[key] = { body: null };
      continue;
    }
    const shorthand = opaqueMediaType(spec);
    if (shorthand !== undefined) {
      // `opaque("image/png")`: exactly `{ content: { "image/png": opaque() } }`.
      out[key] = { body: { [shorthand]: opaque() } };
      continue;
    }
    if (isSchema(spec)) {
      out[key] = { body: { "application/json": spec as Schema } };
      continue;
    }
    if (!isPlainObject(spec)) {
      throw new TypeError(
        `${at}: expected a Standard Schema, null, or { headers, cookies, content }`,
      );
    }
    const parts: OutboundParts = {};
    for (const [name, value] of Object.entries(spec)) {
      if (!SPEC_KEYS.has(name)) {
        throw new TypeError(
          `${at}: "${name}" is not a response part (headers, cookies, content)`,
        );
      }
      if (value === undefined) continue;
      if (name === "content") {
        if (value === null) {
          parts.body = null;
          continue;
        }
        if (!isPlainObject(value)) {
          throw new TypeError(
            `${at}.content: expected an object keyed by media type, or null`,
          );
        }
        for (const [media, schema] of Object.entries(value)) {
          if (schema !== null && !isSchema(schema)) {
            throw new TypeError(
              `${at}.content[${JSON.stringify(media)}]: expected a Standard Schema, chunks(), sse(), opaque() or null`,
            );
          }
          const own = opaqueMediaType(schema);
          if (own !== undefined) {
            throw new TypeError(
              `${at}.content[${JSON.stringify(media)}]: opaque(${JSON.stringify(own)}) names a second media type; inside a content map write opaque(), or declare the status as ${key}: opaque(${JSON.stringify(own)})`,
            );
          }
        }
        compileMediaMap(value, `${at}.content`);
        parts.body = value as Record<string, Schema | null>;
        continue;
      }
      if (!isSchema(value)) {
        throw new TypeError(`${at}.${name}: expected a Standard Schema`);
      }
      parts[name as "headers" | "cookies"] = value as Schema;
    }
    out[key] = parts;
  }
  return out;
}

/**
 * Merges response tables outermost first (an adapter's `commonResponses`,
 * then a router's, then a validator's `responses`): per status and part, the
 * innermost declaration wins, as `mergeContracts` merges an outbound side
 * (plan Q-C11). So a route's `404` body replaces the router's, while the
 * router's `404` headers still apply if the route declares none.
 *
 * @param layers The tables, outermost first.
 */
export function mergeOutboundDefs(layers: readonly OutboundDef[]): OutboundDef {
  if (layers.length === 1) return layers[0];
  const out: Record<string, OutboundParts> = {};
  for (const layer of layers) {
    for (const [status, parts] of Object.entries(layer)) {
      out[status] = { ...out[status], ...parts };
    }
  }
  return out;
}

/** One status, compiled for the gate. */
interface CompiledStatus {
  /** The headers schema; `undefined` when not declared or only documented. */
  readonly headers: Schema | undefined;
  /** The cookies schema; `undefined` when not declared or only documented. */
  readonly cookies: Schema | undefined;
  /** The body: `undefined` unchecked, `null` none allowed, else by media type. */
  readonly body: MediaMatcher<Schema | null> | null | undefined;
  /** Whether a media type maps to `null`, so an empty body with no `Content-Type` is allowed. */
  readonly emptyAllowed: boolean;
}

/** A response table compiled once, for the gate. */
interface CompiledTable {
  /** Status to its compiled parts. */
  readonly statuses: ReadonlyMap<number, CompiledStatus>;
  /** The declared statuses, for an undeclared-status message. */
  readonly declared: string;
}

/** A part's schema, unless it only documents. */
const checking = (schema: Schema | undefined): Schema | undefined =>
  schema === undefined || isDocumented(schema) ? undefined : schema;

/** Compiles a table (already checked by {@link toOutboundDef}). */
function compileTable(def: OutboundDef): CompiledTable {
  const statuses = new Map<number, CompiledStatus>();
  for (const [status, parts] of Object.entries(def)) {
    statuses.set(Number(status), {
      headers: checking(parts.headers),
      cookies: checking(parts.cookies),
      body:
        parts.body === undefined || parts.body === null
          ? parts.body
          : compileMediaMap(parts.body, `responses[${status}].content`),
      emptyAllowed:
        parts.body !== undefined &&
        parts.body !== null &&
        Object.values(parts.body).includes(null),
    });
  }
  const keys = [...statuses.keys()].sort((a, b) => a - b).map(String);
  const shown = keys.slice(0, 10).join(", ");
  return {
    statuses,
    declared: keys.length > 10 ? `${shown}, …` : shown,
  };
}

// ---------------------------------------------------------------------------
// What a schema sees
// ---------------------------------------------------------------------------

/** The headers a `headers` schema sees: lower-case names, `set-cookie` left to `cookies`. */
function headersView(
  response: Response,
  contentType: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") out[key] = value;
  });
  if (contentType !== undefined && out["content-type"] === undefined) {
    out["content-type"] = contentType;
  }
  return out;
}

/** `SameSite` values, canonically capitalised. */
const SAME_SITE: Readonly<Record<string, string>> = {
  strict: "Strict",
  lax: "Lax",
  none: "None",
};
/** `Priority` values, canonically capitalised. */
const PRIORITY: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * The `Set-Cookie`s a `cookies` schema sees, by name (a later line for a
 * name replaces an earlier one). Exported for the tests.
 *
 * @param lines The `Set-Cookie` lines, as `Headers.getSetCookie()` gives them.
 */
export function setCookieView(
  lines: readonly string[],
): Record<string, SetCookieView> {
  const out: Record<string, SetCookieView> = {};
  for (const line of lines) {
    const [pair = "", ...attributes] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (value.includes("%")) {
      try {
        value = decodeURIComponent(value);
      } catch {
        // Kept as written, as the request side's parser keeps it.
      }
    }
    const view: SetCookieView = {
      value,
      httpOnly: false,
      secure: false,
      partitioned: false,
    };
    for (const attribute of attributes) {
      const at = attribute.indexOf("=");
      const key = (at === -1 ? attribute : attribute.slice(0, at))
        .trim()
        .toLowerCase();
      const given = at === -1 ? "" : attribute.slice(at + 1).trim();
      switch (key) {
        case "httponly":
          view.httpOnly = true;
          break;
        case "secure":
          view.secure = true;
          break;
        case "partitioned":
          view.partitioned = true;
          break;
        case "samesite":
          view.sameSite = SAME_SITE[given.toLowerCase()] ?? given;
          break;
        case "priority":
          view.priority = PRIORITY[given.toLowerCase()] ?? given;
          break;
        case "path":
          view.path = given;
          break;
        case "domain":
          view.domain = given;
          break;
        case "max-age":
          view.maxAge = Number(given);
          break;
        case "expires":
          view.expires = new Date(given);
          break;
        default:
          break;
      }
    }
    out[name] = view;
  }
  return out;
}

/** Decodes bytes as UTF-8 text. */
const decoder = new TextDecoder();

/** Whether a bare media type is JSON's (`application/json`, `*+json`). */
function isJsonMedia(bare: string): boolean {
  return bare === "application/json" || bare.endsWith("+json");
}

/** A body value, or the fact that it does not parse as the JSON its media type says. */
type BodyValue = { ok: true; value: unknown } | { ok: false };

/** What a whole-body schema sees for a text body sent as `bare`: parsed when JSON. */
function textValue(bare: string, text: string): BodyValue {
  if (!isJsonMedia(bare)) return { ok: true, value: text };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** What a whole-body schema sees for bytes sent as `bare`: parsed for JSON, decoded for `text/*`, else a `Uint8Array`. */
function bytesValue(bare: string, bytes: Uint8Array): BodyValue {
  if (isJsonMedia(bare) || bare.startsWith("text/")) {
    return textValue(bare, decoder.decode(bytes));
  }
  return { ok: true, value: bytes };
}

/** A view of any binary body as bytes (only its window). */
function toBytes(body: ArrayBufferView | ArrayBufferLike): Uint8Array {
  return ArrayBuffer.isView(body)
    ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    : new Uint8Array(body);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** The issues of a check, or a promise of them. */
type Found = MaybePromise<ValidationIssue<ResponsePart>[]>;

/** Flattens a mix of issue lists and promises of them, staying sync when it can. */
function gather(parts: readonly Found[]): Found {
  if (parts.length === 1) return parts[0];
  let pending = false;
  for (const part of parts) pending ||= part instanceof Promise;
  if (!pending) return (parts as ValidationIssue<ResponsePart>[][]).flat();
  return Promise.all(parts.map(async (part) => Promise.resolve(part))).then(
    (lists) => lists.flat(),
  );
}

/** A framework-made issue (no schema, no received value). */
function issue(
  target: ResponsePart,
  status: number,
  message: string,
  mediaType?: string,
  path = "",
): ValidationIssue<ResponsePart> {
  const out: ValidationIssue<ResponsePart> = {
    target,
    message,
    path,
    key: String(status),
  };
  if (mediaType !== undefined) out.mediaType = mediaType;
  return out;
}

/**
 * Runs one schema through the core's runner (its issues scrubbed of the
 * value, and worded per `format`: the validator's `messages` and
 * `redactPaths`).
 */
function run(
  schema: Schema,
  value: unknown,
  target: ResponsePart,
  status: number,
  mediaType: string | undefined,
  format: IssueFormat | undefined,
): Found {
  const issuesOf = (
    outcome: StandardOutcome<unknown, ResponsePart>,
  ): ValidationIssue<ResponsePart>[] => (outcome.ok ? [] : outcome.issues);
  const outcome = runSchema<unknown, ResponsePart>(
    schema,
    value,
    target,
    status,
    mediaType,
    format,
  );
  return outcome instanceof Promise
    ? outcome.then(issuesOf)
    : issuesOf(outcome);
}

/** Runs a whole-body schema on a parsed body value. */
function runBody(
  schema: Schema,
  value: BodyValue,
  status: number,
  key: MediaKey,
  format: IssueFormat | undefined,
): Found {
  return value.ok
    ? run(schema, value.value, "body", status, key.declared, format)
    : [issue("body", status, "The body is not valid JSON", key.declared)];
}

/** Prefixes each issue's path with `prefix` (an SSE event's `<name>.data`). */
function prefixed(found: Found, prefix: string): Found {
  const map = (
    issues: ValidationIssue<ResponsePart>[],
  ): ValidationIssue<ResponsePart>[] =>
    issues.map((i) => ({
      ...i,
      path: i.path === "" ? prefix : `${prefix}.${i.path}`,
    }));
  return found instanceof Promise ? found.then(map) : map(found);
}

/** Whether a bare media type is textual for a `"raw"` chunk: `text/*` or JSON's. */
function isTextMedia(bare: string): boolean {
  return bare.startsWith("text/") || isJsonMedia(bare);
}

/** Encodes text as UTF-8. */
const encoder = new TextEncoder();

/**
 * Where a stream's mismatches go: whether one cuts the stream off (`"error"`,
 * not an error handler's response), and the log line's fields.
 */
interface StreamReporter {
  /** `true` under `"error"` (outside an error handler): a mismatch cuts the stream off. */
  readonly refuse: boolean;
  /** The logger. */
  readonly logger: () => Logger;
  /** The log line's location fields (method, route pattern). */
  readonly where: Readonly<Record<string, unknown>>;
}

/**
 * One streamed body's checks (`chunks()`, `sse()`): created per response by
 * the gate when the body's media type maps to one, and fed each chunk in the
 * order it is sent. It frames the bytes (lines, events) across chunk
 * boundaries, so its calls must follow the stream's order; only the schemas'
 * verdicts may be asynchronous.
 */
class StreamChecker implements ResponseStreamCheck {
  /** The declaration. */
  readonly #decl: StreamChunks | SseEvents;
  /** The response's status. */
  readonly #status: number;
  /** The declared media key the body fell under. */
  readonly #key: MediaKey;
  /** For `"raw"` chunks: whether the schema sees text (else bytes). */
  readonly #text: boolean;
  /** Where mismatches go. */
  readonly #reporter: StreamReporter;
  /** How the schemas' issues are worded (`messages`, `redactPaths`); `undefined` for the default. */
  readonly #format: IssueFormat | undefined;
  /** Decodes byte chunks across boundaries (multi-byte characters split between chunks). */
  #decoder: TextDecoder | undefined;
  /** The SSE framer, for `sse()`. */
  #events: SseFramer | undefined;
  /** The line framer, for `chunks(S, { framing: "ndjson" })`. */
  #lines: LineFramer | undefined;
  /** Set once a mismatch of this stream was reported: `"warn"` reports one per stream. */
  #reported = false;

  /**
   * @param decl     The `chunks()` or `sse()` declaration.
   * @param status   The response's status.
   * @param key      The declared media key the body fell under.
   * @param bare     The bare media type sent.
   * @param reporter Where mismatches go.
   * @param format   How the schemas' issues are worded.
   */
  constructor(
    decl: StreamChunks | SseEvents,
    status: number,
    key: MediaKey,
    bare: string,
    reporter: StreamReporter,
    format: IssueFormat | undefined,
  ) {
    this.#decl = decl;
    this.#status = status;
    this.#key = key;
    this.#text = isTextMedia(bare);
    this.#reporter = reporter;
    this.#format = format;
  }

  /** Marks the stream's mismatch as reported (the commit reported its first chunk's). */
  markReported(): void {
    this.#reported = true;
  }

  /**
   * The issues of the next chunk, framing it (with what came before) into
   * the values the schemas check. Exported for the gate's first chunk and
   * for buffered bodies.
   *
   * @param chunk The chunk, as written or as the piped stream yields it.
   */
  issues(chunk: BunResponseChunk): Found {
    const decl = this.#decl;
    if (decl.kind === "chunks" && decl.framing === "raw") {
      if (typeof chunk === "string") {
        if (chunk.length === 0) return [];
        return this.#run(this.#text ? chunk : encoder.encode(chunk));
      }
      const bytes = toBytes(chunk);
      if (bytes.byteLength === 0) return [];
      return this.#run(
        this.#text
          ? (this.#decoder ??= new TextDecoder()).decode(bytes, {
              stream: true,
            })
          : bytes,
      );
    }
    return this.#framed(
      typeof chunk === "string"
        ? chunk
        : (this.#decoder ??= new TextDecoder()).decode(toBytes(chunk), {
            stream: true,
          }),
    );
  }

  /** The issues of what is left when the stream ends: an NDJSON line without its `\n`. */
  endIssues(): Found {
    const decl = this.#decl;
    if (decl.kind !== "chunks" || decl.framing !== "ndjson") return [];
    const tail = this.#decoder?.decode() ?? "";
    const parts: Found[] = tail.length === 0 ? [] : [this.#framed(tail)];
    const last = (this.#lines ??= new LineFramer()).end();
    if (last !== undefined) parts.push(this.#line(last));
    return parts.length === 0 ? [] : gather(parts);
  }

  /**
   * Checks the next chunk: `undefined` to send it, a
   * {@link ResponseValidationError} to cut the stream off (logged at
   * `error`), or a promise of either. Under `"warn"` it never refuses, and
   * the stream's first mismatch is logged.
   *
   * @param chunk The chunk.
   */
  chunk(
    chunk: BunResponseChunk,
  ): MaybePromise<ResponseValidationError | undefined> {
    return this.#verdict(this.issues(chunk));
  }

  /** Checks what is left at the stream's end, as {@link chunk} does. */
  end(): MaybePromise<ResponseValidationError | undefined> {
    return this.#verdict(this.endIssues());
  }

  /** Runs the chunk schema on one value. */
  #run(value: unknown): Found {
    return run(
      (this.#decl as StreamChunks).chunk,
      value,
      "body",
      this.#status,
      this.#key.declared,
      this.#format,
    );
  }

  /** Frames text into NDJSON lines or SSE events, and checks each. */
  #framed(text: string): Found {
    const decl = this.#decl;
    const parts: Found[] = [];
    if (decl.kind === "sse") {
      for (const event of (this.#events ??= new SseFramer()).push(text)) {
        parts.push(this.#event(decl, event.name, event.data));
      }
    } else {
      for (const line of (this.#lines ??= new LineFramer()).push(text)) {
        parts.push(this.#line(line));
      }
    }
    return parts.length === 0 ? [] : gather(parts);
  }

  /** Checks one NDJSON line (blank lines are skipped). */
  #line(line: string): Found {
    if (line.trim().length === 0) return [];
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return [
        issue(
          "body",
          this.#status,
          "A line is not valid JSON",
          this.#key.declared,
        ),
      ];
    }
    return this.#run(value);
  }

  /** Checks one SSE event against the schema its name selects. */
  #event(decl: SseEvents, name: string, data: string | undefined): Found {
    const status = this.#status;
    const media = this.#key.declared;
    if (!Object.hasOwn(decl.events, name)) {
      const names = Object.keys(decl.events);
      const shown = names.slice(0, 10).join(", ");
      return [
        issue(
          "body",
          status,
          `This event is not declared (${names.length > 10 ? `${shown}, …` : shown})`,
          media,
        ),
      ];
    }
    const schema = decl.events[name];
    const path = `${name}.data`;
    if (schema === null) {
      return data === undefined || data === ""
        ? []
        : [
            issue(
              "body",
              status,
              "No data is declared for this event",
              media,
              path,
            ),
          ];
    }
    let value: unknown = data;
    if (decl.data === "json" && data !== undefined) {
      try {
        value = JSON.parse(data) as unknown;
      } catch {
        return [
          issue(
            "body",
            status,
            "The event's data is not valid JSON",
            media,
            path,
          ),
        ];
      }
    }
    return prefixed(
      run(schema, value, "body", status, media, this.#format),
      path,
    );
  }

  /** Turns a chunk's issues into a verdict, reporting them. */
  #verdict(found: Found): MaybePromise<ResponseValidationError | undefined> {
    if (!(found instanceof Promise)) return this.#decide(found);
    if (!this.#reporter.refuse) {
      // "warn" never holds a chunk back: reported when the check settles.
      void found.then(
        (issues) => this.#decide(issues),
        (error: unknown) => this.#failed(error),
      );
      return undefined;
    }
    return found.then(
      (issues) => this.#decide(issues),
      (error: unknown) => {
        this.#failed(error);
        return new ResponseValidationError(
          [
            issue(
              "body",
              this.#status,
              "The response could not be checked",
              this.#key.declared,
            ),
          ],
          this.#status,
        );
      },
    );
  }

  /** The verdict for a chunk's settled issues. */
  #decide(
    issues: ValidationIssue<ResponsePart>[],
  ): ResponseValidationError | undefined {
    if (issues.length === 0) return undefined;
    const reporter = this.#reporter;
    const fields = { ...reporter.where, status: this.#status, issues };
    if (reporter.refuse) {
      reporter
        .logger()
        .error(
          "streamed response does not match its contract; the stream was cut off",
          fields,
        );
      return new ResponseValidationError(issues, this.#status);
    }
    if (!this.#reported) {
      this.#reported = true;
      reporter
        .logger()
        .warn(
          "streamed response does not match its contract (reported once per stream)",
          fields,
        );
    }
    return undefined;
  }

  /** Logs a chunk check that threw (a schema's own failure). */
  #failed(error: unknown): void {
    const reporter = this.#reporter;
    reporter.logger().error("response contract check failed", {
      ...reporter.where,
      status: this.#status,
      error,
    });
  }
}

/** What a commit's checks found besides issues: the stream check the response needs, if any. */
interface CommitOut {
  /** The per-chunk check of a `chunks()`/`sse()` stream. */
  stream?: StreamChecker;
}

/** Whether a commit opens or pipes a stream (rather than a buffered body). */
const isStream = (kind: ResponseCommit["kind"]): boolean =>
  kind === "stream" || kind === "open";

/**
 * The gate one validator installs on each response it lets through (one per
 * validator and router binding, not per request): checks the response at
 * its commit point against the compiled table, under one mode, and hands a
 * streamed body's per-chunk check back to the response.
 */
export class ResponseContractGate implements ResponseGate {
  /** The compiled table. */
  readonly #table: CompiledTable;
  /** The table in contract form, for merging with an inner validator's. */
  readonly #def: OutboundDef;
  /** `"warn"` logs and sends; `"error"` refuses. */
  readonly #mode: "warn" | "error";
  /** The logger, resolved when first needed (the router's, once bound). */
  readonly #logger: () => Logger;
  /** How the schemas' issues are worded (the validator's `messages`, `redactPaths`); `undefined` for the default. */
  readonly #format: IssueFormat | undefined;
  /** Set once the gate said it does not buffer a stream (one warning per gate, i.e. per route). */
  #warnedUnread = false;
  /** Gates combined with an inner validator's, cached by that gate. */
  #within: WeakMap<ResponseContractGate, ResponseContractGate> | undefined;

  /**
   * @param def    The response table, checked by {@link toOutboundDef} (and merged).
   * @param mode   `"warn"` or `"error"`; `"off"` installs no gate.
   * @param logger Resolves the logger mismatches are written to.
   * @param format The validator's `messages` and `redactPaths`, applied to
   *   every schema's issues; `undefined` (the default) for the core's scrub.
   */
  constructor(
    def: OutboundDef,
    mode: "warn" | "error",
    logger: () => Logger,
    format?: IssueFormat,
  ) {
    this.#def = def;
    this.#table = compileTable(def);
    this.#mode = mode;
    this.#logger = logger;
    this.#format = format;
  }

  /**
   * The gate for a response two validators let through (a mount's, then a
   * route's): their tables merged with the inner one winning per status and
   * part, under the inner one's mode. Their issue wording is the stricter
   * of the two (`messages: "generic"` or `redactPaths` set on either holds),
   * so a route's validator never undoes its mount's. Cached, so a pair
   * compiles once.
   *
   * @param inner The inner validator's gate.
   */
  within(inner: ResponseGate): ResponseGate {
    if (!(inner instanceof ResponseContractGate)) return inner;
    const cache = (this.#within ??= new WeakMap());
    let combined = cache.get(inner);
    if (combined === undefined) {
      combined = new ResponseContractGate(
        mergeOutboundDefs([this.#def, inner.#def]),
        inner.#mode,
        inner.#logger,
        strictest(this.#format, inner.#format),
      );
      cache.set(inner, combined);
    }
    return combined;
  }

  /**
   * Checks a committed response. Answers `undefined` to send it, a
   * {@link ResponseValidationError} to refuse it, the per-chunk check of a
   * `chunks()`/`sse()` stream to send it and check each chunk, or a promise
   * of one of these (a Promise-answering vendor, a body that must be read)
   * to hold it; only `"error"` refuses or holds, and never for an error
   * handler's response (`commit.reportOnly`), which is only reported.
   *
   * @param res      The response.
   * @param response The native `Response` about to be handed on (for a
   *   `write()` stream's opening, one with its status and headers only).
   * @param commit   What produced it.
   */
  commit(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
  ): MaybePromise<ResponseValidationError | ResponseStreamCheck | undefined> {
    const status = response.status;
    const out: CommitOut = {};
    const found = this.#check(res, response, commit, status, out);
    const reportOnly = this.#mode === "warn" || commit.reportOnly;
    if (!(found instanceof Promise)) {
      if (found.length === 0) return out.stream;
      if (reportOnly) {
        this.#report(res, status, found, commit.reportOnly);
        out.stream?.markReported();
        return out.stream;
      }
      return new ResponseValidationError(found, status);
    }
    if (reportOnly) {
      // Sent at once; reported when the check settles.
      void found.then(
        (issues) => {
          if (issues.length > 0) {
            this.#report(res, status, issues, commit.reportOnly);
            out.stream?.markReported();
          }
        },
        (error: unknown) => this.#failed(res, status, error),
      );
      return out.stream;
    }
    return found.then(
      (issues) =>
        issues.length === 0
          ? out.stream
          : new ResponseValidationError(issues, status),
      (error: unknown) => {
        this.#failed(res, status, error);
        return new ResponseValidationError(
          [issue("body", status, "The response could not be checked")],
          status,
        );
      },
    );
  }

  /**
   * Logs a refusal nothing could take: the request's pipeline had already
   * moved on (a not-found answer made after it ended), so the response is
   * answered `500` without the error handlers.
   *
   * @param res   The response.
   * @param error The refusal.
   */
  undelivered(res: BunResponse, error: Error): void {
    this.#logger().error(
      "response refused by its contract after the pipeline ended; answered 500",
      {
        ...this.#where(res),
        ...(error instanceof ResponseValidationError
          ? { status: error.responseStatus, issues: error.issues }
          : { error }),
      },
    );
  }

  /** Where a log line is about: the method and the route's pattern (never the received path). */
  #where(res: BunResponse): Record<string, unknown> {
    const req = res.req;
    const route = (req.route as { path?: unknown } | undefined)?.path;
    return {
      transport: "http",
      side: "outbound",
      method: req.method,
      ...(typeof route === "string" ? { route } : {}),
    };
  }

  /** Logs a mismatch that is only reported. */
  #report(
    res: BunResponse,
    status: number,
    issues: readonly ValidationIssue<ResponsePart>[],
    errorHandler: boolean,
  ): void {
    this.#logger().warn(
      errorHandler
        ? "error handler's response does not match its contract (reported, not replaced)"
        : "response does not match its contract",
      { ...this.#where(res), status, issues },
    );
  }

  /** Logs a check that threw (a schema's own failure, a body read failing). */
  #failed(res: BunResponse, status: number, error: unknown): void {
    this.#logger().error("response contract check failed", {
      ...this.#where(res),
      status,
      error,
    });
  }

  /** Says once per gate (per route) that a stream is not buffered to check it against a whole-body schema (Q-H4). */
  #unread(res: BunResponse, status: number): void {
    if (this.#warnedUnread) return;
    this.#warnedUnread = true;
    this.#logger().warn(
      "a streamed body is not checked against a whole-body schema (streams are never buffered; declare chunks() or sse()); its status, headers, cookies and media type are",
      { ...this.#where(res), status },
    );
  }

  /** Every part's issues for one response. */
  #check(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    out: CommitOut,
  ): Found {
    const spec = this.#table.statuses.get(status);
    if (spec === undefined) {
      // A 304 the freshness check made for a conditional request (Q-H1).
      if (status === 304 && isConditional(res)) return [];
      return [
        issue(
          "status",
          status,
          `This status is not declared (${this.#table.declared})`,
        ),
      ];
    }
    const parts: Found[] = [];
    if (spec.headers !== undefined) {
      parts.push(
        run(
          spec.headers,
          headersView(response, commit.contentType),
          "headers",
          status,
          undefined,
          this.#format,
        ),
      );
    }
    if (spec.cookies !== undefined) {
      parts.push(
        run(
          spec.cookies,
          setCookieView(response.headers.getSetCookie()),
          "cookies",
          status,
          undefined,
          this.#format,
        ),
      );
    }
    const kind = commit.kind;
    // A redirect's or a status's generated body, and the body-less statuses,
    // are exempt: only their status and headers are the handler's.
    if (
      spec.body !== undefined &&
      kind !== "redirect" &&
      kind !== "status" &&
      status !== 204 &&
      status !== 205 &&
      status !== 304
    ) {
      parts.push(this.#checkBody(res, response, commit, status, spec, out));
    }
    return parts.length === 0 ? [] : gather(parts);
  }

  /** The body's issues, by kind. */
  #checkBody(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    spec: CompiledStatus,
    out: CommitOut,
  ): Found {
    const body = spec.body!;
    const kind = commit.kind;
    if (body === null) {
      if (kind === "empty") return [];
      if (kind === "native") {
        return response
          .clone()
          .arrayBuffer()
          .then((bytes) =>
            bytes.byteLength === 0
              ? []
              : [issue("body", status, "No body is declared for this status")],
          );
      }
      return [issue("body", status, "No body is declared for this status")];
    }
    const contentType = commit.contentType;
    const found =
      contentType === undefined ? undefined : body.match(contentType);
    if (found === undefined) {
      if (contentType !== undefined) {
        return [
          issue(
            "body",
            status,
            `This media type is not declared (${body.declared.join(", ")})`,
          ),
        ];
      }
      // No Content-Type: an empty body is allowed where a media type maps
      // to `null`.
      if (kind === "empty" && spec.emptyAllowed) return [];
      return [
        issue(
          "body",
          status,
          isStream(kind)
            ? `The stream has no Content-Type (declared: ${body.declared.join(", ")})`
            : `This status declares a body (${body.declared.join(", ")}), and none was sent`,
        ),
      ];
    }
    const [key, entry] = found;
    if (entry === null) {
      return emptyBodyIssues(response, commit, status, key);
    }
    if (isDocumented(entry)) return [];
    const bodyKind = kindOf(entry);
    if (bodyKind === "opaque") return [];
    const bare = bareMediaType(contentType!);
    if (bodyKind === "chunks" || bodyKind === "sse") {
      return this.#streamBody(
        res,
        response,
        commit,
        status,
        key,
        bare,
        entry as unknown as StreamChunks | SseEvents,
        out,
      );
    }
    switch (kind) {
      case "empty":
        return [
          issue(
            "body",
            status,
            `This status declares a body (${body.declared.join(", ")}), and none was sent`,
          ),
        ];
      case "json":
        return run(
          entry,
          commit.body,
          "body",
          status,
          key.declared,
          this.#format,
        );
      case "text":
        return runBody(
          entry,
          textValue(bare, String(commit.body)),
          status,
          key,
          this.#format,
        );
      case "bytes":
        return runBody(
          entry,
          bytesValue(bare, toBytes(commit.body as ArrayBufferView)),
          status,
          key,
          this.#format,
        );
      case "blob":
      case "file":
      case "native":
        // Read without consuming what is sent: a Blob (a file's too) reads
        // again; a Response is cloned (Q-H5).
        return readBytes(response, commit).then((bytes) =>
          runBody(entry, bytesValue(bare, bytes), status, key, this.#format),
        );
      default:
        // A stream: never buffered (Q-H4).
        this.#unread(res, status);
        return [];
    }
  }

  /**
   * A body under `chunks()`/`sse()`: a stream gets its per-chunk check (a
   * `write()` stream's first chunk checked now, with the commit), and so
   * does a `Blob`, a file or a passed-through `Response`, whose body is
   * piped through it rather than read whole; a body held in memory (text,
   * bytes, a `json()` value) is checked as a stream of one chunk.
   */
  #streamBody(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    key: MediaKey,
    bare: string,
    decl: StreamChunks | SseEvents,
    out: CommitOut,
  ): Found {
    const checker = new StreamChecker(
      decl,
      status,
      key,
      bare,
      {
        refuse: this.#mode === "error" && !commit.reportOnly,
        logger: this.#logger,
        where: this.#where(res),
      },
      this.#format,
    );
    const kind = commit.kind;
    const whole = (chunk: BunResponseChunk): Found =>
      gather([checker.issues(chunk), checker.endIssues()]);
    switch (kind) {
      case "stream":
      case "blob":
      case "file":
      case "native":
        // Piped through the check as it streams, never read whole.
        out.stream = checker;
        return [];
      case "open":
        out.stream = checker;
        return commit.body === undefined
          ? []
          : checker.issues(commit.body as BunResponseChunk);
      case "empty":
        return [];
      case "json":
        return whole(JSON.stringify(commit.body) ?? "");
      case "text":
        return whole(String(commit.body));
      case "bytes":
        return whole(toBytes(commit.body as ArrayBufferView));
      default:
        return [];
    }
  }
}

/**
 * The stricter of two validators' issue wordings, for a gate combining
 * them: each option set on either holds. `undefined` when neither sets one.
 */
function strictest(
  outer: IssueFormat | undefined,
  inner: IssueFormat | undefined,
): IssueFormat | undefined {
  if (outer === undefined) return inner;
  if (inner === undefined) return outer;
  const generic = outer.messages === "generic" || inner.messages === "generic";
  const redact = outer.redactPaths === true || inner.redactPaths === true;
  return {
    ...(generic ? { messages: "generic" as const } : {}),
    ...(redact ? { redactPaths: true } : {}),
  };
}

/** A Blob's, a file's or a passed-through `Response`'s bytes, read without consuming what is sent. */
async function readBytes(
  response: Response,
  commit: ResponseCommit,
): Promise<Uint8Array> {
  const source =
    commit.kind === "native" ? response.clone() : (commit.body as Blob);
  return new Uint8Array(await source.arrayBuffer());
}

/** The issues of a body sent as a media type mapped to `null`: it must be empty. */
function emptyBodyIssues(
  response: Response,
  commit: ResponseCommit,
  status: number,
  key: MediaKey,
): Found {
  const none: ValidationIssue<ResponsePart>[] = [];
  const some = [
    issue(
      "body",
      status,
      "No body is declared for this media type",
      key.declared,
    ),
  ];
  const body = commit.body;
  switch (commit.kind) {
    case "empty":
      return none;
    case "text":
      return String(body) === "" ? none : some;
    case "bytes":
      return toBytes(body as ArrayBufferView).byteLength === 0 ? none : some;
    case "blob":
    case "file":
      return (body as Blob).size === 0 ? none : some;
    case "native":
      return readBytes(response, commit).then((bytes) =>
        bytes.byteLength === 0 ? none : some,
      );
    default:
      return some;
  }
}

/** Whether the request is conditional (`If-None-Match` or `If-Modified-Since`). */
function isConditional(res: BunResponse): boolean {
  const req = res.req;
  return (
    !!req.getHeader("if-none-match") || !!req.getHeader("if-modified-since")
  );
}

// ---------------------------------------------------------------------------
// Binding a validator to its router's settings
// ---------------------------------------------------------------------------

/**
 * Where a validator declaring `responses` carries its binding, read by
 * `BunRouter` when it registers a route: the router's `responseValidation`
 * and `commonResponses` are known only then.
 */
export const RESPONSE_BINDING: unique symbol = Symbol.for(
  "bun-validate.responseBinding",
);

/** What a router passes a validator's binding when it registers the route. */
export interface RouterResponseSettings {
  /** The innermost router's `responseValidation` that set one; `undefined` when none did. */
  readonly mode: ResponseValidationMode | undefined;
  /** The routers' `commonResponses`, outermost first (an adapter's, then a router's). */
  readonly common: readonly OutboundDef[];
  /** The router's logger, resolved when first needed. */
  readonly logger: () => Logger;
}

/** A validator's binding: builds its handler for one route's router settings. */
export interface ResponseBinding {
  /**
   * The validator's handler for a route registered with `settings`: the
   * validator's own `responseValidation` wins over the router's, and its
   * `responses` over the routers' `commonResponses` (per status and part).
   * Returns the validator's own handler when nothing differs.
   *
   * @param settings The router's settings for the route.
   */
  bind: (settings: RouterResponseSettings) => unknown;
}

/** The binding a callback carries, if it is a validator declaring `responses`. */
export function responseBindingOf(
  callback: unknown,
): ResponseBinding | undefined {
  return typeof callback === "function"
    ? (callback as { [RESPONSE_BINDING]?: ResponseBinding })[RESPONSE_BINDING]
    : undefined;
}
