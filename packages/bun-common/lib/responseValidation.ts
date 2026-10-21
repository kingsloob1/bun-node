/**
 * Response contracts for HTTP (plan `docs/plans/bun-validate/` §4.4, V3a):
 * what `validate(schemas, { responses })` declares per status, how it is
 * compiled once, and the gate `BunResponse` consults at its single commit
 * point (its private `response` setter, which every producer passes
 * through) for the status, the headers, the `Set-Cookie`s, the media type and
 * a buffered body.
 *
 * V3a checks buffered bodies: `json()`, `send()` of an object, a string,
 * bytes, a `Blob` (read with `arrayBuffer()`) or a native `Response` (read
 * through `clone()`). A stream, `sendFile()`'s bytes and `write()`/`end()`
 * streams are V3b's (the status, headers, cookies and media type of a piped
 * stream and of `sendFile()` are checked here; their bytes are not).
 *
 * Only `ResponseValidationError` is exported from the package (plan §9's
 * approved names); the rest is reachable through `validate()`'s and the
 * router's option types.
 */
import type { BunResponse, ResponseCommit, ResponseGate } from "./BunResponse";
import type { MediaKey, MediaMatcher } from "./contract/media";
import type {
  MaybePromise,
  Policy,
  Schema,
  StandardOutcome,
  ValidationIssue,
} from "./contract/model";
import type { Logger } from "./logging";
import type { StandardSchemaV1 } from "./types/standardSchema";
import { ContractError } from "./contract/guard";
import { runSchema } from "./contract/issues";
import { bareMediaType, compileMediaMap } from "./contract/media";
import { isDocumented } from "./contract/schemas";
import { isSchema } from "./contract/transport";

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
   * type no key matches is a mismatch. `null`: the status has no body.
   * Omitted: the body is not checked.
   */
  readonly content?: Readonly<Record<string, StandardSchemaV1>> | null;
}

/**
 * One status's contract: a schema (shorthand for `{ content: {
 * "application/json": schema } }`), `null` (no body), or the full
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
  /** The body by media type, or `null` for none. */
  body?: Readonly<Record<string, Schema>> | null;
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
          if (!isSchema(schema)) {
            throw new TypeError(
              `${at}.content[${JSON.stringify(media)}]: expected a Standard Schema`,
            );
          }
        }
        compileMediaMap(value, `${at}.content`);
        parts.body = value as Record<string, Schema>;
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
  readonly body: MediaMatcher<Schema> | null | undefined;
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
): ValidationIssue<ResponsePart> {
  const out: ValidationIssue<ResponsePart> = {
    target,
    message,
    path: "",
    key: String(status),
  };
  if (mediaType !== undefined) out.mediaType = mediaType;
  return out;
}

/** Runs one schema through the core's runner (its issues scrubbed of the value). */
function run(
  schema: Schema,
  value: unknown,
  target: ResponsePart,
  status: number,
  mediaType?: string,
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
    undefined,
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
): Found {
  return value.ok
    ? run(schema, value.value, "body", status, key.declared)
    : [issue("body", status, "The body is not valid JSON", key.declared)];
}

/**
 * The gate one validator installs on each response it lets through (one per
 * validator and router binding, not per request): checks the response at
 * its commit point against the compiled table, under one mode.
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
  /** Set once the gate said it does not read a body kind (one warning per gate). */
  #warnedUnread = false;
  /** Gates combined with an inner validator's, cached by that gate. */
  #within: WeakMap<ResponseContractGate, ResponseContractGate> | undefined;

  /**
   * @param def    The response table, checked by {@link toOutboundDef} (and merged).
   * @param mode   `"warn"` or `"error"`; `"off"` installs no gate.
   * @param logger Resolves the logger mismatches are written to.
   */
  constructor(def: OutboundDef, mode: "warn" | "error", logger: () => Logger) {
    this.#def = def;
    this.#table = compileTable(def);
    this.#mode = mode;
    this.#logger = logger;
  }

  /**
   * The gate for a response two validators let through (a mount's, then a
   * route's): their tables merged with the inner one winning per status and
   * part, under the inner one's mode. Cached, so a pair compiles once.
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
      );
      cache.set(inner, combined);
    }
    return combined;
  }

  /**
   * Checks a committed response. Answers `undefined` to send it, a
   * {@link ResponseValidationError} to refuse it, or a promise of either
   * (a Promise-answering vendor, a body that must be read) to hold it; only
   * `"error"` refuses or holds, and never for an error handler's response
   * (`commit.reportOnly`), which is only reported.
   *
   * @param res      The response.
   * @param response The native `Response` about to be handed on.
   * @param commit   What produced it.
   */
  commit(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
  ): MaybePromise<ResponseValidationError | undefined> {
    const status = response.status;
    const found = this.#check(res, response, commit, status);
    const reportOnly = this.#mode === "warn" || commit.reportOnly;
    if (!(found instanceof Promise)) {
      if (found.length === 0) return undefined;
      if (reportOnly) {
        this.#report(res, status, found, commit.reportOnly);
        return undefined;
      }
      return new ResponseValidationError(found, status);
    }
    if (reportOnly) {
      // Sent at once; reported when the check settles.
      void found.then(
        (issues) => {
          if (issues.length > 0) {
            this.#report(res, status, issues, commit.reportOnly);
          }
        },
        (error: unknown) => this.#failed(res, status, error),
      );
      return undefined;
    }
    return found.then(
      (issues) =>
        issues.length === 0
          ? undefined
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

  /** Says once per gate that a body kind is not read against a whole-body schema in V3a. */
  #unread(res: BunResponse, status: number, kind: string): void {
    if (this.#warnedUnread) return;
    this.#warnedUnread = true;
    this.#logger().warn(
      `a ${kind} body is not checked against a whole-body schema (its status, headers, cookies and media type are)`,
      { ...this.#where(res), status },
    );
  }

  /** Every part's issues for one response. */
  #check(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
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
        ),
      );
    }
    const body = spec.body;
    const kind = commit.kind;
    // A redirect's or a status's generated body, and the body-less statuses,
    // are exempt: only their status and headers are the handler's.
    if (
      body !== undefined &&
      kind !== "redirect" &&
      kind !== "status" &&
      status !== 204 &&
      status !== 205 &&
      status !== 304
    ) {
      parts.push(this.#checkBody(res, response, commit, status, body));
    }
    return parts.length === 1 ? parts[0] : gather(parts);
  }

  /** The body's issues, by kind. */
  #checkBody(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    body: MediaMatcher<Schema> | null,
  ): Found {
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
    if (kind === "empty" || contentType === undefined) {
      return [
        issue(
          "body",
          status,
          `This status declares a body (${body.declared.join(", ")}), and none was sent`,
        ),
      ];
    }
    const found = body.match(contentType);
    if (found === undefined) {
      return [
        issue(
          "body",
          status,
          `This media type is not declared (${body.declared.join(", ")})`,
        ),
      ];
    }
    const [key, schema] = found;
    if (isDocumented(schema)) return [];
    const bare = bareMediaType(contentType);
    switch (kind) {
      case "json":
        return run(schema, commit.body, "body", status, key.declared);
      case "text":
        return runBody(
          schema,
          textValue(bare, String(commit.body)),
          status,
          key,
        );
      case "bytes":
        return runBody(
          schema,
          bytesValue(bare, toBytes(commit.body as ArrayBufferView)),
          status,
          key,
        );
      case "blob":
      case "native": {
        // Read without consuming what is sent: a Blob reads again; a
        // Response is cloned (Q-H5).
        const source =
          kind === "native" ? response.clone() : (commit.body as Blob);
        return source
          .arrayBuffer()
          .then((buffer) =>
            runBody(
              schema,
              bytesValue(bare, new Uint8Array(buffer)),
              status,
              key,
            ),
          );
      }
      default:
        // A stream or a file: V3b reads those.
        this.#unread(res, status, kind === "file" ? "sendFile()" : "streamed");
        return [];
    }
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
