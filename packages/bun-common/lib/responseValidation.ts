/**
 * Response contracts for HTTP (plan `docs/plans/bun-validate/` §4.4, V3a,
 * V3b and V3c): what `validate(schemas, { responses })` declares per status
 * (one spec, or several whole variants with `variants()`), how it
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
import type { BunRequest } from "./BunRequest";
import type {
  BunResponse,
  BunResponseChunk,
  ResponseCommit,
  ResponseGate,
  ResponseReplacement,
  ResponseStreamCheck,
} from "./BunResponse";
import type { MediaKey, MediaMatcher } from "./contract/media";
import type {
  MaybePromise,
  Policy,
  Schema,
  StandardOutcome,
  ValidationIssue,
  VariantDecl,
  VariantsDecl,
} from "./contract/model";
import type { IssueFormat } from "./contract/issues";
import type { Logger } from "./logging";
import type {
  Discriminant,
  Refine,
  RefineIssue,
  RefineResponse,
  ResponseVariants,
  SseEvents,
  StreamChunks,
  UntypedValid,
  VariantSpec,
} from "./responseBodies";
import type { StandardSchemaV1 } from "./types/standardSchema";
import { ContractError } from "./contract/guard";
import { andThen, runSchema, toIssues } from "./contract/issues";
import { bareMediaType, compileMediaMap } from "./contract/media";
import { isPromiseLike, VARIANTS, variantsOf } from "./contract/model";
import {
  isDocumented,
  jsonSchemaOf,
  kindOf,
  opaqueMediaType,
} from "./contract/schemas";
import { isSchema } from "./contract/transport";
import {
  isResponseVariants,
  LineFramer,
  opaque,
  SseFramer,
} from "./responseBodies";
import { serializeCookie } from "./utils/native";

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/**
 * Runtime response checks: `"off"` checks nothing (and installs nothing,
 * unless a status declares `variants()`: then only `res.variant()`'s
 * adjust), `"warn"` sends the response and logs each mismatch once, `"error"`
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
  /**
   * A whole-response check, run synchronously once every declared part
   * passes, with the response as the gate saw it and the request (plan
   * §4.4.6). Its issues' messages are scrubbed against every part. On a
   * variant it runs before the status's own (`variants(…, { refine })`).
   */
  readonly refine?: Refine;
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

/**
 * The declared responses, by status code (100–599). A status not listed is a
 * mismatch. Each is a {@link ResponseSpec}, or several whole variants
 * (`variants()`, plan §4.4.6).
 *
 * @typeParam V The request view a variant's `when` takes: the validator's
 *   parsed parts inside `validate()`, {@link UntypedValid} (the default)
 *   under `commonResponses`.
 */
export type ResponseSchemas<V = UntypedValid> = Readonly<
  Record<
    number,
    | ResponseSpec
    | ResponseVariants<
        Readonly<Record<string, VariantSpec<V>>>,
        Discriminant | undefined,
        V
      >
  >
>;

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

/** The parts an issue can name, for a `refine`'s issue. */
const RESPONSE_PARTS: ReadonlySet<string> = new Set<ResponsePart>([
  "status",
  "headers",
  "cookies",
  "body",
]);

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

/** Where an {@link OutboundParts} keeps its status's `refine` (a function, never described). */
const REFINE: unique symbol = Symbol.for("bun-validate.responseRefine");

/**
 * One status as the HTTP transport's outbound side declares it: the parts
 * `headers`, `cookies` and `body` (a media map, or `null`). A part absent is
 * not declared. A status declared with `variants()` has no part of its own:
 * its variants are under the core's `VARIANTS` symbol ({@link HttpVariantsDecl}).
 */
export interface OutboundParts {
  /** The headers schema. */
  headers?: Schema;
  /** The `Set-Cookie` view schema. */
  cookies?: Schema;
  /** The body by media type (a media type mapped to `null` carries no body), or `null` for none. */
  body?: Readonly<Record<string, Schema | null>> | null;
  /** The status's whole-response check (`refine`), when it declares one. */
  [REFINE]?: Refine;
  /** The status's variants, when it is declared with `variants()`. */
  [VARIANTS]?: HttpVariantsDecl;
}

/** One variant, as the HTTP contract records it: the core's {@link VariantDecl} plus what the gate runs. */
interface HttpVariantDecl extends VariantDecl {
  /** The variant's parts, as a plain status's. */
  readonly parts: OutboundParts;
  /** The variant's `when`; `undefined` for a variant that applies to every request. */
  readonly when: ((valid: never, req: BunRequest) => unknown) | undefined;
  /** The variant's own `refine`. */
  readonly refine: Refine | undefined;
}

/** A status's variants, as the HTTP contract records them under `VARIANTS`. */
interface HttpVariantsDecl extends VariantsDecl {
  /** The variants, in declaration order. */
  readonly variants: readonly HttpVariantDecl[];
  /** The status's `refine` (`variants(…, { refine })`), run after the matched variant's own. */
  readonly refine: Refine | undefined;
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
const SPEC_KEYS = new Set(["headers", "cookies", "content", "refine"]);

/** The keys a variant's spec takes: a spec object's, plus `when` and `description`. */
const VARIANT_KEYS = new Set([...SPEC_KEYS, "when", "description"]);

/**
 * Checks a `responses` (or `commonResponses`) declaration and turns it into
 * the HTTP transport's outbound form. Throws a `TypeError` naming the
 * mistake: a key that is not a status, a spec that is none of the forms, an
 * unknown spec key (`when` outside `variants()` included), a part that is
 * not a Standard Schema, a media key that is not a media type, two media
 * keys that tie, or a `variants()` mistake (none declared, a discriminant
 * naming both or neither of `header` and `cookie`, a `values` key naming no
 * variant, two variants selected by one value).
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
    out[key] = isResponseVariants(spec)
      ? { [VARIANTS]: toVariantsDecl(spec, at, key) }
      : toParts(spec, at, key, SPEC_KEYS);
  }
  return out;
}

/** One status's (or one variant's) spec in contract form; `key` is the status, `keys` the spec keys it may use. */
function toParts(
  spec: unknown,
  at: string,
  key: string,
  keys: ReadonlySet<string>,
): OutboundParts {
  if (spec === null) return { body: null };
  const shorthand = opaqueMediaType(spec);
  if (shorthand !== undefined) {
    // `opaque("image/png")`: exactly `{ content: { "image/png": opaque() } }`.
    return { body: { [shorthand]: opaque() } };
  }
  if (isSchema(spec)) return { body: { "application/json": spec as Schema } };
  if (!isPlainObject(spec)) {
    throw new TypeError(
      `${at}: expected a Standard Schema, null, or { headers, cookies, content }`,
    );
  }
  const parts: OutboundParts = {};
  for (const [name, value] of Object.entries(spec)) {
    if (!keys.has(name)) {
      throw new TypeError(
        name === "when"
          ? `${at}: "when" belongs to a variant; declare the status with variants({ name: { when, … } })`
          : `${at}: "${name}" is not a response part (${[...keys].join(", ")})`,
      );
    }
    if (value === undefined) continue;
    if (name === "when" || name === "description") continue; // a variant's, read by toVariantsDecl
    if (name === "refine") {
      if (typeof value !== "function") {
        throw new TypeError(`${at}.refine: expected a function`);
      }
      parts[REFINE] = value as Refine;
      continue;
    }
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
  return parts;
}

/** A `variants()` declaration in contract form, its mistakes refused. */
function toVariantsDecl(
  spec: ResponseVariants,
  at: string,
  key: string,
): HttpVariantsDecl {
  const table = spec.table as Readonly<Record<string, unknown>>;
  if (!isPlainObject(table)) {
    throw new TypeError(`${at}: variants() expects an object of variant names`);
  }
  const names = Object.keys(table);
  if (names.length === 0) {
    throw new TypeError(`${at}: variants() declares no variant`);
  }
  const list: HttpVariantDecl[] = names.map((name) => {
    const where = `${at}.${name}`;
    const variant = table[name];
    if (!isPlainObject(variant)) {
      throw new TypeError(
        `${where}: expected { headers, cookies, content, when, refine, description }`,
      );
    }
    const { when, description } = variant;
    if (when !== undefined && typeof when !== "function") {
      throw new TypeError(`${where}.when: expected a function`);
    }
    if (description !== undefined && typeof description !== "string") {
      throw new TypeError(`${where}.description: expected a string`);
    }
    const parts = toParts(variant, where, key, VARIANT_KEYS);
    const refine = parts[REFINE];
    delete parts[REFINE];
    return {
      name,
      parts,
      conditional: when !== undefined,
      ...(description === undefined ? {} : { description }),
      when: when as HttpVariantDecl["when"],
      refine,
    };
  });
  if (spec.refine !== undefined && typeof spec.refine !== "function") {
    throw new TypeError(`${at}: variants() refine must be a function`);
  }
  const by = spec.by === undefined ? undefined : toBy(spec.by, names, at);
  return {
    variants: list,
    ...(by === undefined ? {} : { by }),
    refine: spec.refine,
  };
}

/** A discriminant in contract form: the part, the name and each selectable variant's value. */
function toBy(
  by: unknown,
  names: readonly string[],
  at: string,
): NonNullable<VariantsDecl["by"]> {
  if (!isPlainObject(by)) {
    throw new TypeError(`${at}: by must be { header } or { cookie }`);
  }
  const header = by.header;
  const cookie = by.cookie;
  if ((header === undefined) === (cookie === undefined)) {
    throw new TypeError(`${at}.by: name exactly one of header, cookie`);
  }
  const name = header ?? cookie;
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`${at}.by: the name must be a non-empty string`);
  }
  const given = by.values;
  if (given !== undefined && !isPlainObject(given)) {
    throw new TypeError(`${at}.by.values: expected an object of variant names`);
  }
  for (const key of Object.keys(given ?? {})) {
    if (!names.includes(key)) {
      throw new TypeError(
        `${at}.by.values: ${JSON.stringify(key)} is not a variant (${names.join(", ")})`,
      );
    }
  }
  const values: Record<string, string | true | null> = {};
  const owner = new Map<string, string>();
  for (const variant of names) {
    const value =
      given !== undefined && Object.hasOwn(given, variant)
        ? given[variant]
        : variant;
    if (value === undefined) continue; // not selected by the discriminant
    if (value !== null && value !== true && typeof value !== "string") {
      throw new TypeError(
        `${at}.by.values.${variant}: expected a string, true or null`,
      );
    }
    const slot = value === null ? "\0absent" : value === true ? "\0any" : value;
    const other = owner.get(slot);
    if (other !== undefined) {
      throw new TypeError(
        `${at}.by: variants ${other} and ${variant} are selected by the same value`,
      );
    }
    owner.set(slot, variant);
    values[variant] = value;
  }
  return {
    part: header === undefined ? "cookies" : "headers",
    name: header === undefined ? name : name.toLowerCase(),
    values,
  };
}

/**
 * Merges response tables outermost first (an adapter's `commonResponses`,
 * then a router's, then a validator's `responses`): per status and part, the
 * innermost declaration wins, as `mergeContracts` merges an outbound side
 * (plan Q-C11). So a route's `404` body replaces the router's, while the
 * router's `404` headers still apply if the route declares none. A status
 * declared with `variants()` on either side is replaced **whole** by the
 * inner declaration, never merged per part (plan Q-H22).
 *
 * @param layers The tables, outermost first.
 */
export function mergeOutboundDefs(layers: readonly OutboundDef[]): OutboundDef {
  if (layers.length === 1) return layers[0];
  const out: Record<string, OutboundParts> = {};
  for (const layer of layers) {
    for (const [status, parts] of Object.entries(layer)) {
      const before = out[status];
      out[status] =
        before === undefined ||
        variantsOf(parts) !== undefined ||
        variantsOf(before) !== undefined
          ? parts
          : { ...before, ...parts };
    }
  }
  return out;
}

/** Whether a table declares any status with variants (so `"off"` installs the adjust-only step, Q-H29). */
export function declaresVariants(def: OutboundDef): boolean {
  for (const parts of Object.values(def)) {
    if (variantsOf(parts) !== undefined) return true;
  }
  return false;
}

/** One status (or one variant), compiled for the gate. */
interface CompiledSpec {
  /** The headers schema; `undefined` when not declared or only documented. */
  readonly headers: Schema | undefined;
  /** The cookies schema; `undefined` when not declared or only documented. */
  readonly cookies: Schema | undefined;
  /** The body: `undefined` unchecked, `null` none allowed, else by media type. */
  readonly body: MediaMatcher<Schema | null> | null | undefined;
  /** Whether a media type maps to `null`, so an empty body with no `Content-Type` is allowed. */
  readonly emptyAllowed: boolean;
  /** The whole-response check after the parts pass; `undefined` when none is declared. */
  readonly refine: Refine | undefined;
  /** Always `undefined`: a plain status (see {@link CompiledVariants}). */
  readonly variants?: undefined;
}

/** One variant, compiled. */
interface CompiledVariant extends CompiledSpec {
  /** Its name. */
  readonly name: string;
  /** Its `when`; `undefined` when it applies to every request. */
  readonly when: ((valid: never, req: BunRequest) => unknown) | undefined;
  /** What `res.variant()` fills and strips for it. */
  readonly adjust: AdjustPlan;
  /** Its `refine`, then the status's, as they run once its parts pass (empty when neither is declared). */
  readonly refines: readonly Refine[];
}

/** A discriminant, compiled. */
interface CompiledBy {
  /** The part it is in. */
  readonly part: "headers" | "cookies";
  /** The header (lower-case) or cookie name. */
  readonly name: string;
  /** The variant a value (`undefined`: absent) selects: an exact value, then any value, then absence. */
  readonly select: (value: string | undefined) => CompiledVariant | undefined;
  /** The declared values, for an issue (never the received one). */
  readonly allowed: string;
  /** The exact value selecting a variant (what `.variant()` fills); `undefined` for `true`/`null`. */
  readonly exact: ReadonlyMap<string, string>;
}

/** A status declared with `variants()`, compiled. */
interface CompiledVariants {
  /** The variants, in declaration order. */
  readonly variants: readonly CompiledVariant[];
  /** The variants by name. */
  readonly byName: ReadonlyMap<string, CompiledVariant>;
  /** The discriminant, if any. */
  readonly by: CompiledBy | undefined;
  /** The status's `refine`, run after the matched variant's own. */
  readonly refine: Refine | undefined;
}

/** One status of a compiled table. */
type CompiledEntry = CompiledSpec | CompiledVariants;

/** A response table compiled once, for the gate. */
interface CompiledTable {
  /** Status to its compiled parts, or its variants. */
  readonly statuses: ReadonlyMap<number, CompiledEntry>;
  /** The declared statuses, for an undeclared-status message. */
  readonly declared: string;
  /**
   * A variant name to the one status declaring it, for `.variant()`'s
   * status fill; `null` when several statuses declare that name.
   */
  readonly variantStatus: ReadonlyMap<string, number | null>;
}

/** A part's schema, unless it only documents. */
const checking = (schema: Schema | undefined): Schema | undefined =>
  schema === undefined || isDocumented(schema) ? undefined : schema;

/** Compiles one status's (or variant's) parts. */
function compileSpec(
  parts: OutboundParts,
  at: string,
  refine: Refine | undefined,
): CompiledSpec {
  return {
    headers: checking(parts.headers),
    cookies: checking(parts.cookies),
    body:
      parts.body === undefined || parts.body === null
        ? parts.body
        : compileMediaMap(parts.body, `${at}.content`),
    emptyAllowed:
      parts.body !== undefined &&
      parts.body !== null &&
      Object.values(parts.body).includes(null),
    refine,
  };
}

/** Compiles a discriminant. */
function compileBy(
  by: NonNullable<VariantsDecl["by"]>,
  byName: ReadonlyMap<string, CompiledVariant>,
): CompiledBy {
  const exact = new Map<string, string>();
  const selects = new Map<string, CompiledVariant>();
  let present: CompiledVariant | undefined;
  let absent: CompiledVariant | undefined;
  for (const [name, value] of Object.entries(by.values)) {
    const variant = byName.get(name)!;
    if (value === null) absent = variant;
    else if (value === true) present = variant;
    else {
      exact.set(name, value);
      selects.set(value, variant);
    }
  }
  const allowed = [
    ...selects.keys(),
    ...(present === undefined ? [] : ["(any value)"]),
    ...(absent === undefined ? [] : ["(absent)"]),
  ].join(", ");
  return {
    part: by.part as "headers" | "cookies",
    name: by.name,
    select: (value) =>
      value === undefined ? absent : (selects.get(value) ?? present),
    allowed,
    exact,
  };
}

/** Says once per declared variant that `.variant()` cannot adjust it (plan Q-H25). */
const warnedUnadjustable = new WeakSet<object>();

/**
 * Compiles a table (already checked by {@link toOutboundDef}). A variant's
 * adjust plan is built once per declaration; one that cannot be adjusted is
 * said once, at `warn`, to `logger`.
 */
function compileTable(def: OutboundDef, logger: () => Logger): CompiledTable {
  const statuses = new Map<number, CompiledEntry>();
  const variantStatus = new Map<string, number | null>();
  for (const [key, parts] of Object.entries(def)) {
    const status = Number(key);
    const at = `responses[${key}]`;
    const declared = variantsOf(parts) as HttpVariantsDecl | undefined;
    if (declared === undefined) {
      statuses.set(status, compileSpec(parts, at, parts[REFINE]));
      continue;
    }
    const list = declared.variants.map((v): CompiledVariant => {
      const adjust = adjustPlanOf(v);
      if (adjust.unadjustable.length > 0 && !warnedUnadjustable.has(v)) {
        warnedUnadjustable.add(v);
        logger().warn(
          "res.variant() cannot adjust this variant: a schema carries no ~standard.jsonSchema (or its converter failed), so nothing in it is filled or stripped; the check still applies",
          {
            transport: "http",
            side: "outbound",
            status,
            variant: v.name,
            parts: adjust.unadjustable,
          },
        );
      }
      return {
        ...compileSpec(v.parts, `${at}.${v.name}`, v.refine),
        name: v.name,
        when: v.when,
        adjust,
        refines: [v.refine, declared.refine].filter(
          (r): r is Refine => r !== undefined,
        ),
      };
    });
    for (const v of list) {
      variantStatus.set(v.name, variantStatus.has(v.name) ? null : status);
    }
    const byName = new Map(list.map((v) => [v.name, v]));
    statuses.set(status, {
      variants: list,
      byName,
      by:
        declared.by === undefined ? undefined : compileBy(declared.by, byName),
      refine: declared.refine,
    });
  }
  const keys = [...statuses.keys()].sort((a, b) => a - b).map(String);
  const shown = keys.slice(0, 10).join(", ");
  return {
    statuses,
    declared: keys.length > 10 ? `${shown}, …` : shown,
    variantStatus,
  };
}

// ---------------------------------------------------------------------------
// What `.variant()` adjusts (plan §4.4.6, Q-H18, Q-H25–Q-H31): fill what a
// variant's schemas allow exactly one value for, strip undeclared JSON body
// fields. Planned once per variant from `~standard.jsonSchema.input()`.
// ---------------------------------------------------------------------------

/** A JSON Schema node, as far as the plan reads one. */
type Js = Readonly<Record<string, unknown>>;

/** What `.variant()` does to one JSON value. */
type NodePlan =
  | {
      /** An object node. */
      readonly kind: "object";
      /** Required properties that admit one value: filled when `undefined`. */
      readonly fill: readonly (readonly [string, unknown])[];
      /** Declared properties' own plans (leaves left out). */
      readonly props: ReadonlyMap<string, NodePlan>;
      /** The declared property names. */
      readonly declared: ReadonlySet<string>;
      /** Whether undeclared keys are removed (no `additionalProperties: true` or schema, no `patternProperties`). */
      readonly strip: boolean;
    }
  | {
      /** An array node: each element by `items`. */
      readonly kind: "array";
      /** The elements' plan. */
      readonly items: NodePlan;
    }
  | {
      /** Anything left as it is. */
      readonly kind: "leaf";
    };

/** A variant's adjust plan. */
interface AdjustPlan {
  /** Required headers (lower-case) that admit one value. */
  readonly headers: readonly (readonly [string, string])[];
  /** Required cookies whose value and every required attribute admit one value. */
  readonly cookies: readonly (readonly [string, SetCookieView])[];
  /** The one media type the variant declares, when it declares exactly one. */
  readonly mediaType: string | undefined;
  /** Body plans by declared media key; a key absent has no plan (not JSON, or not adjustable). */
  readonly bodies: ReadonlyMap<string, NodePlan>;
  /** The parts whose schema carries no usable JSON Schema (`"headers"`, `"body application/json"`). */
  readonly unadjustable: readonly string[];
}

/** A plan's leaf. */
const LEAF: NodePlan = { kind: "leaf" };
/** Deeper than this, a node is a leaf (plan Q-H26). */
const MAX_ADJUST_DEPTH = 16;
/** Marks "not one value". */
const NOT_ONE: unique symbol = Symbol("not one value");

/** The single value a node admits (`const`, or an `enum` of one), else {@link NOT_ONE}. */
function oneValue(js: Js): unknown {
  if (Object.hasOwn(js, "const")) return js.const;
  if (Array.isArray(js.enum) && js.enum.length === 1) return js.enum[0];
  return NOT_ONE;
}

/**
 * The input JSON Schema a schema carries, `undefined` when it carries none
 * or its converter throws. zod throws on an unrepresentable type (a
 * `z.date()`) unless asked otherwise, so `unrepresentable: "any"` is passed
 * (an opaque, per-vendor option of the Standard JSON Schema spec).
 */
function inputJsonSchema(schema: Schema): Js | undefined {
  const converter = jsonSchemaOf(schema);
  if (converter === undefined) return undefined;
  try {
    const js = converter.input({
      target: "draft-2020-12",
      libraryOptions: { unrepresentable: "any" },
    });
    return isPlainObject(js) ? js : undefined;
  } catch {
    return undefined;
  }
}

/** Plans one node: `$ref`s into `$defs` followed; unions, intersections, records and tuples left alone. */
function planNode(js: Js, root: Js, depth: number): NodePlan {
  if (depth > MAX_ADJUST_DEPTH) return LEAF;
  const ref = js.$ref;
  if (typeof ref === "string") {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    const defs = m === null ? undefined : root[m[1]];
    const target = m !== null && isPlainObject(defs) ? defs[m[2]] : undefined;
    return isPlainObject(target) ? planNode(target, root, depth + 1) : LEAF;
  }
  if ("anyOf" in js || "oneOf" in js || "allOf" in js) return LEAF;
  if (js.type === "array") {
    // A tuple (`prefixItems`) is left alone.
    return isPlainObject(js.items) && !("prefixItems" in js)
      ? { kind: "array", items: planNode(js.items, root, depth + 1) }
      : LEAF;
  }
  if (js.type !== "object" && !isPlainObject(js.properties)) return LEAF;
  const properties = isPlainObject(js.properties) ? js.properties : {};
  const required = new Set(
    Array.isArray(js.required)
      ? js.required.filter((k): k is string => typeof k === "string")
      : [],
  );
  const fill: (readonly [string, unknown])[] = [];
  const props = new Map<string, NodePlan>();
  for (const [key, prop] of Object.entries(properties)) {
    if (!isPlainObject(prop)) continue;
    const value = oneValue(prop);
    if (value !== NOT_ONE && required.has(key)) fill.push([key, value]);
    const child = planNode(prop, root, depth + 1);
    if (child.kind !== "leaf") props.set(key, child);
  }
  const extra = js.additionalProperties;
  // A record (`additionalProperties` a schema or `true`) keeps its keys.
  const strip = !(
    extra === true ||
    isPlainObject(extra) ||
    "patternProperties" in js
  );
  return {
    kind: "object",
    fill,
    props,
    declared: new Set(Object.keys(properties)),
    strip,
  };
}

/** The required properties of an object node, with their nodes. */
function requiredProps(js: Js | undefined): [string, Js][] {
  if (js === undefined || !isPlainObject(js.properties)) return [];
  const required = new Set(Array.isArray(js.required) ? js.required : []);
  const out: [string, Js][] = [];
  for (const [k, v] of Object.entries(js.properties)) {
    if (required.has(k) && isPlainObject(v)) out.push([k, v]);
  }
  return out;
}

/** Adjust plans by declared variant, built once each. */
const plans = new WeakMap<object, AdjustPlan>();

/** A variant's adjust plan (built on first use, then cached for the declaration). */
function adjustPlanOf(variant: HttpVariantDecl): AdjustPlan {
  let plan = plans.get(variant);
  if (plan === undefined) {
    plan = planAdjust(variant.parts);
    plans.set(variant, plan);
  }
  return plan;
}

/** Plans a variant: its literal headers and cookies, its one media type, and each JSON body. */
function planAdjust(parts: OutboundParts): AdjustPlan {
  const unadjustable: string[] = [];
  const read = (schema: Schema | undefined, label: string): Js | undefined => {
    if (schema === undefined) return undefined;
    const js = inputJsonSchema(schema);
    if (js === undefined) unadjustable.push(label);
    return js;
  };
  const headers: [string, string][] = [];
  for (const [name, prop] of requiredProps(read(parts.headers, "headers"))) {
    const value = oneValue(prop);
    if (typeof value === "string") headers.push([name.toLowerCase(), value]);
  }
  const cookies: [string, SetCookieView][] = [];
  for (const [name, prop] of requiredProps(read(parts.cookies, "cookies"))) {
    // Filled only when the value and every attribute it requires admit one value.
    const attributes = requiredProps(prop);
    const view: Record<string, unknown> = {
      httpOnly: false,
      secure: false,
      partitioned: false,
      path: "/",
    };
    let one = attributes.some(([k]) => k === "value");
    for (const [k, v] of attributes) {
      const value = oneValue(v);
      if (value === NOT_ONE) one = false;
      else view[k] = value;
    }
    if (one && typeof view.value === "string") {
      cookies.push([name, view as unknown as SetCookieView]);
    }
  }
  const bodies = new Map<string, NodePlan>();
  const keys = parts.body ? Object.keys(parts.body) : [];
  for (const media of keys) {
    const schema = parts.body![media];
    const bare = bareMediaType(media);
    if (schema === null || kindOf(schema) !== "value") continue;
    if (!isJsonMedia(bare) && bare !== "*/*" && bare !== "application/*") {
      continue;
    }
    const js = read(schema, `body ${media}`);
    if (js !== undefined) bodies.set(media, planNode(js, js, 0));
  }
  return {
    headers,
    cookies,
    mediaType: keys.length === 1 ? keys[0] : undefined,
    bodies,
    unadjustable,
  };
}

/** Whether a value is a plain JSON object (the only kind `.variant()` fills or strips). */
const isJsonObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" &&
  x !== null &&
  !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype;

/**
 * Applies a body plan, copy-on-write: the handler's objects are never
 * mutated; a changed node is a copy. Records each change as a path and a
 * count, never a removed key's name or any value (a key of a user-keyed
 * record can be user data, plan Q-H27).
 */
function applyNode(
  plan: NodePlan,
  value: unknown,
  path: string,
  changes: string[],
): unknown {
  if (plan.kind === "array") {
    if (!Array.isArray(value)) return value;
    const list = value as readonly unknown[];
    let out: unknown[] | undefined;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const next = applyNode(plan.items, item, `${path}[]`, changes);
      if (next !== item) (out ??= [...list])[i] = next;
    }
    return out ?? list;
  }
  if (plan.kind !== "object" || !isJsonObject(value)) return value;
  let out: Record<string, unknown> | undefined;
  if (plan.strip) {
    let removed = 0;
    for (const key of Object.keys(value)) {
      if (!plan.declared.has(key)) {
        delete (out ??= { ...value })[key];
        removed++;
      }
    }
    if (removed > 0) {
      changes.push(
        `body${path}: stripped ${removed} undeclared field${removed === 1 ? "" : "s"}`,
      );
    }
  }
  for (const [key, literal] of plan.fill) {
    if (value[key] === undefined) {
      (out ??= { ...value })[key] = literal;
      changes.push(`body${path}.${key}: filled`);
    }
  }
  for (const [key, child] of plan.props) {
    const current = (out ?? value)[key];
    if (current === undefined) continue;
    const next = applyNode(child, current, `${path}.${key}`, changes);
    if (next !== current) (out ??= { ...value })[key] = next;
  }
  return out ?? value;
}

/** A `Set-Cookie` line for a cookie `.variant()` fills, as `res.cookie()` writes one. */
function cookieLine(name: string, view: SetCookieView): string {
  return serializeCookie(name, view.value, {
    path: view.path ?? "/",
    domain: view.domain,
    httpOnly: view.httpOnly,
    secure: view.secure,
    partitioned: view.partitioned,
    sameSite: view.sameSite?.toLowerCase() as
      "strict" | "lax" | "none" | undefined,
    maxAge: view.maxAge,
    priority: view.priority?.toLowerCase() as
      "low" | "medium" | "high" | undefined,
  });
}

/** What an adjust produced: the response to check and send, and what changed. */
interface Adjusted {
  /** The adjusted native `Response`. */
  readonly response: Response;
  /** The commit as the adjusted response's (its media type and body). */
  readonly commit: ResponseCommit;
  /** The changes, as paths and counts (never names it removed, never values). */
  readonly changes: readonly string[];
  /** The adjusted JSON body, when the body changed. */
  readonly body?: unknown;
  /** Its serialisation, when the body changed. */
  readonly text?: string;
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

/** What a check answers while matching variants (plan §4.4.6): only "it failed"; never reported. */
const MISMATCH: ValidationIssue<ResponsePart> = {
  target: "body",
  message: "",
  path: "",
};

/** The vendor's own verdict as a matching answer: one {@link MISMATCH}, or none. */
const verdictOf = (
  result: StandardSchemaV1.Result<unknown>,
): ValidationIssue<ResponsePart>[] => (result.issues ? [MISMATCH] : []);

/**
 * Runs one schema through the core's runner (its issues scrubbed of the
 * value, and worded per `format`: the validator's `messages` and
 * `redactPaths`). With `short`, only the vendor's pass or fail is asked
 * (plan §4.4.6's cost): no issue is built or scrubbed, and a failure is one
 * {@link MISMATCH}, which the refusal path replaces by running again in full.
 */
function run(
  schema: Schema,
  value: unknown,
  target: ResponsePart,
  status: number,
  mediaType: string | undefined,
  format: IssueFormat | undefined,
  short = false,
): Found {
  if (short) {
    const result = schema["~standard"].validate(value);
    // Any thenable is async, as in the core's runner.
    return isPromiseLike(result)
      ? Promise.resolve(result).then(verdictOf)
      : verdictOf(result);
  }
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

/** Runs a whole-body schema on a parsed body value (`short`: see {@link run}). */
function runBody(
  schema: Schema,
  value: BodyValue,
  status: number,
  key: MediaKey,
  format: IssueFormat | undefined,
  short: boolean,
): Found {
  return value.ok
    ? run(schema, value.value, "body", status, key.declared, format, short)
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
  /** The variant whose body this checks, put on its issues; `undefined` on a status with no variants. */
  #variant: string | undefined = undefined;

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
   * Names the variant whose body this checks: its issues then carry it.
   *
   * @param variant The variant's name.
   */
  tag(variant: string): this {
    this.#variant = variant;
    return this;
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
    found: ValidationIssue<ResponsePart>[],
  ): ResponseValidationError | undefined {
    if (found.length === 0) return undefined;
    const variant = this.#variant;
    const issues =
      variant === undefined ? found : found.map((i) => ({ ...i, variant }));
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

/**
 * A streamed body checked against several variants at once (plan §4.4.6,
 * Q-H24): the variants whose status, headers, cookies and media type (and,
 * for a `write()` stream, first chunk) passed at the commit **survive**, and
 * each chunk is checked against every survivor, a variant failing one
 * dropping out. When none survives, the stream is cut off under `"error"`
 * (as one variant's would be) and reported once under `"warn"`. A
 * discriminant or `res.variant()` decides at the commit instead.
 */
class SurvivorsCheck implements ResponseStreamCheck {
  /** The variants still matching, each with its own framer. */
  #alive: readonly {
    /** The variant's name. */
    readonly name: string;
    /** Its per-chunk check. */
    readonly check: StreamChecker;
  }[];
  /** The response's status. */
  readonly #status: number;
  /** Where the mismatch goes. */
  readonly #reporter: StreamReporter;

  /**
   * @param alive    The variants that passed at the commit, in declaration order.
   * @param status   The response's status.
   * @param reporter Where the mismatch goes.
   */
  constructor(
    alive: readonly {
      /** The variant's name. */
      readonly name: string;
      /** Its per-chunk check. */
      readonly check: StreamChecker;
    }[],
    status: number,
    reporter: StreamReporter,
  ) {
    this.#alive = alive;
    this.#status = status;
    this.#reporter = reporter;
  }

  /** The commit reported a mismatch already: nothing more is reported for the stream. */
  markReported(): void {
    this.#alive = [];
  }

  /**
   * Checks the next chunk against every survivor.
   *
   * @param chunk The chunk.
   */
  chunk(
    chunk: BunResponseChunk,
  ): MaybePromise<ResponseValidationError | undefined> {
    return this.#step((check) => check.issues(chunk));
  }

  /** Checks what is left at the stream's end against every survivor. */
  end(): MaybePromise<ResponseValidationError | undefined> {
    return this.#step((check) => check.endIssues());
  }

  /** Runs one step on every survivor and keeps those that pass it. */
  #step(
    of: (check: StreamChecker) => Found,
  ): MaybePromise<ResponseValidationError | undefined> {
    const alive = this.#alive;
    if (alive.length === 0) return undefined;
    const found = alive.map((s) => of(s.check));
    const settle = (
      lists: readonly ValidationIssue<ResponsePart>[][],
    ): ResponseValidationError | undefined => {
      const next = alive.filter((_, i) => lists[i].length === 0);
      if (next.length > 0) {
        this.#alive = next;
        return undefined;
      }
      this.#alive = [];
      const issues: ValidationIssue<ResponsePart>[] = [
        issue(
          "body",
          this.#status,
          `The stream matches no acceptable variant (${alive.map((s) => s.name).join(", ")})`,
        ),
      ];
      lists.forEach((list, i) => {
        const variant = alive[i].name;
        for (const one of list) issues.push({ ...one, variant });
      });
      return this.#decide(issues);
    };
    if (!found.some((f) => f instanceof Promise)) {
      return settle(found as ValidationIssue<ResponsePart>[][]);
    }
    const all = Promise.all(found);
    if (!this.#reporter.refuse) {
      void all.then(settle, (error: unknown) => this.#failed(error));
      return undefined;
    }
    return all.then(settle, (error: unknown) => {
      this.#failed(error);
      return new ResponseValidationError(
        [issue("body", this.#status, "The response could not be checked")],
        this.#status,
      );
    });
  }

  /** Reports the stream's mismatch: cut off under `"error"`, logged once under `"warn"`. */
  #decide(
    issues: ValidationIssue<ResponsePart>[],
  ): ResponseValidationError | undefined {
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
    reporter
      .logger()
      .warn(
        "streamed response does not match its contract (reported once per stream)",
        fields,
      );
    return undefined;
  }

  /** Logs a chunk check that threw. */
  #failed(error: unknown): void {
    const reporter = this.#reporter;
    reporter.logger().error("response contract check failed", {
      ...reporter.where,
      status: this.#status,
      error,
    });
  }
}

/** No variant excluded by `when`. */
const NONE: readonly CompiledVariant[] = Object.freeze([]);

/** A stream check the gate hands back. */
type GateStream = StreamChecker | SurvivorsCheck;

/** What a commit's checks found besides issues: the stream check the response needs, if any. */
interface CommitOut {
  /** The per-chunk check of a `chunks()`/`sse()` stream. */
  stream?: GateStream;
}

/**
 * What one commit's checks read more than once while matching variants: the
 * headers and cookies views, and a read body's bytes. `undefined` on a plain
 * status, whose parts are each read once.
 */
interface ViewCache {
  /** The headers view. */
  headers?: Record<string, string>;
  /** The `Set-Cookie` view. */
  cookies?: Record<string, SetCookieView>;
  /** A `Blob`'s, a file's or a passed-through `Response`'s bytes. */
  bytes?: Promise<Uint8Array>;
}

/** What a variants status's checks decided. */
interface Outcome {
  /** The mismatches; none to send. */
  readonly issues: ValidationIssue<ResponsePart>[];
  /** What `.variant()` adjusted; absent when nothing was. */
  readonly adjusted?: Adjusted;
  /** The streamed body's per-chunk check, when it has one. */
  readonly stream?: GateStream;
  /** A `when`, a `refine` or a schema threw, or a `when` answered a non-boolean: a failed check. */
  readonly failed?: {
    /** What was thrown (logged, never in an issue). */
    readonly error: unknown;
  };
}

/** Whether a commit opens or pipes a stream (rather than a buffered body). */
const isStream = (kind: ResponseCommit["kind"]): boolean =>
  kind === "stream" || kind === "open";

/**
 * The gate one validator installs on each response it lets through (one per
 * validator and router binding, not per request): checks the response at
 * its commit point against the compiled table, under one mode, and hands a
 * streamed body's per-chunk check back to the response. Under `"off"` it is
 * the adjust-only step of a table declaring variants (plan Q-H29): it applies
 * `res.variant()`'s fills and strips and checks nothing.
 */
export class ResponseContractGate implements ResponseGate {
  /** The compiled table. */
  readonly #table: CompiledTable;
  /** The table in contract form, for merging with an inner validator's. */
  readonly #def: OutboundDef;
  /** `"warn"` logs and sends; `"error"` refuses; `"off"` only adjusts (`.variant()`). */
  readonly #mode: Policy;
  /** The logger, resolved when first needed (the router's, once bound). */
  readonly #logger: () => Logger;
  /** How the schemas' issues are worded (the validator's `messages`, `redactPaths`); `undefined` for the default. */
  readonly #format: IssueFormat | undefined;
  /** Set once the gate said it does not buffer a stream (one warning per gate, i.e. per route). */
  #warnedUnread = false;
  /** Set once the gate said a `res.variant()` came after the commit (one warning per gate, i.e. per route). */
  #warnedLate = false;
  /** Gates combined with an inner validator's, cached by that gate. */
  #within: WeakMap<ResponseContractGate, ResponseContractGate> | undefined;

  /**
   * @param def    The response table, checked by {@link toOutboundDef} (and merged).
   * @param mode   `"warn"` or `"error"`; `"off"` only for a table declaring
   *   variants (the adjust-only step), since otherwise `"off"` installs no gate.
   * @param logger Resolves the logger mismatches are written to.
   * @param format The validator's `messages` and `redactPaths`, applied to
   *   every schema's issues; `undefined` (the default) for the core's scrub.
   */
  constructor(
    def: OutboundDef,
    mode: Policy,
    logger: () => Logger,
    format?: IssueFormat,
  ) {
    this.#def = def;
    this.#table = compileTable(def, logger);
    this.#mode = mode;
    this.#logger = logger;
    this.#format = format;
  }

  /**
   * The gate for a response two validators let through (a mount's, then a
   * route's): their tables merged with the inner one winning per status and
   * part (a variants status whole), under the inner one's mode, or the outer
   * one's when the inner only adjusts (`"off"`). Their issue wording is the
   * stricter of the two (`messages: "generic"` or `redactPaths` set on either
   * holds), so a route's validator never undoes its mount's. Cached, so a
   * pair compiles once.
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
        inner.#mode === "off" ? this.#mode : inner.#mode,
        inner.#logger,
        strictest(this.#format, inner.#format),
      );
      cache.set(inner, combined);
    }
    return combined;
  }

  /**
   * Told that `res.variant()` was called once the response was committed:
   * too late to select or adjust anything. Said once per gate (per route).
   *
   * @param res The response.
   */
  lateVariant(res: BunResponse): void {
    if (this.#warnedLate) return;
    this.#warnedLate = true;
    this.#logger().warn(
      "res.variant() was called after the response was committed, and is ignored (reported once per route)",
      this.#where(res),
    );
  }

  /**
   * Checks a committed response. Answers `undefined` to send it, a
   * {@link ResponseValidationError} to refuse it, the per-chunk check of a
   * `chunks()`/`sse()` stream to send it and check each chunk, an adjusted
   * response to send in its place (`res.variant()`), or a promise of one of
   * these (a Promise-answering vendor or `when`, a body that must be read)
   * to hold it; only `"error"` refuses or holds (and `"warn"` holds for a
   * named variant whose `when` answers a Promise, to adjust it), and never
   * for an error handler's response (`commit.reportOnly`), which is only
   * reported.
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
  ): MaybePromise<
    | ResponseValidationError
    | ResponseStreamCheck
    | ResponseReplacement
    | undefined
  > {
    let status = response.status;
    const named = commit.variant;
    if (named !== undefined && !commit.statusSet) {
      // `.variant(name)` with no status set: the one status declaring that
      // variant, if exactly one does (plan Q-H28).
      const only = this.#table.variantStatus.get(named);
      if (only !== undefined && only !== null) status = only;
    }
    const entry = this.#table.statuses.get(status);
    if (this.#mode === "off") {
      return this.#adjustOnly(res, response, commit, status, entry, named);
    }
    if (entry !== undefined && entry.variants !== undefined) {
      return this.#commitVariants(res, response, commit, status, entry, named);
    }
    const out: CommitOut = {};
    const found =
      named !== undefined && entry !== undefined
        ? [
            issue(
              "status",
              status,
              `variant(${JSON.stringify(named)}) was named, but this status declares no variants`,
            ),
          ]
        : this.#check(res, response, commit, status, entry, out);
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

  /** Logs a check that threw (a schema's own failure, a body read failing, a `when` or `refine`). */
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

  /** A plain status's issues (V3a's check), then its `refine`. */
  #check(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    spec: CompiledSpec | undefined,
    out: CommitOut,
  ): Found {
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
    const found = this.#checkParts(
      res,
      response,
      commit,
      status,
      spec,
      out,
      undefined,
    );
    const refine = spec.refine;
    if (refine === undefined) return found;
    return andThen(found, (issues) => {
      if (issues.length > 0) return issues;
      try {
        return this.#refined(
          [refine],
          res,
          response,
          commit,
          status,
          undefined,
          false,
          undefined,
        );
      } catch (error) {
        this.#failed(res, status, error);
        return [issue("status", status, "The response could not be checked")];
      }
    });
  }

  /**
   * One spec's parts (a plain status's, or one variant's): every declared
   * part, the checks run side by side. With `short` (matching variants), only
   * pass or fail, cheap parts first, stopping at the first that fails.
   */
  #checkParts(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    spec: CompiledSpec,
    out: CommitOut,
    cache: ViewCache | undefined,
    short = false,
  ): Found {
    if (short) {
      return this.#checkShort(res, response, commit, status, spec, out, cache);
    }
    const parts: Found[] = [];
    if (spec.headers !== undefined) {
      parts.push(
        run(
          spec.headers,
          viewHeaders(response, commit, cache),
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
          viewCookies(response, cache),
          "cookies",
          status,
          undefined,
          this.#format,
        ),
      );
    }
    if (bodyChecked(spec, commit, status)) {
      parts.push(
        this.#checkBody(res, response, commit, status, spec, out, cache, false),
      );
    }
    return parts.length === 0 ? [] : gather(parts);
  }

  /** {@link #checkParts} with `short`: headers, then cookies, then the body, stopping at the first that fails. */
  #checkShort(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    spec: CompiledSpec,
    out: CommitOut,
    cache: ViewCache | undefined,
    from = 0,
  ): Found {
    for (let step = from; step < 3; step++) {
      let found: Found | undefined;
      if (step === 0) {
        if (spec.headers !== undefined) {
          found = run(
            spec.headers,
            viewHeaders(response, commit, cache),
            "headers",
            status,
            undefined,
            undefined,
            true,
          );
        }
      } else if (step === 1) {
        if (spec.cookies !== undefined) {
          found = run(
            spec.cookies,
            viewCookies(response, cache),
            "cookies",
            status,
            undefined,
            undefined,
            true,
          );
        }
      } else if (bodyChecked(spec, commit, status)) {
        found = this.#checkBody(
          res,
          response,
          commit,
          status,
          spec,
          out,
          cache,
          true,
        );
      }
      if (found === undefined) continue;
      if (found instanceof Promise) {
        const next = step + 1;
        return found.then((issues) =>
          issues.length > 0
            ? issues
            : this.#checkShort(
                res,
                response,
                commit,
                status,
                spec,
                out,
                cache,
                next,
              ),
        );
      }
      if (found.length > 0) return found;
    }
    return [];
  }

  /** The body's issues, by kind (`short`: see {@link run}). */
  #checkBody(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    spec: CompiledSpec,
    out: CommitOut,
    cache: ViewCache | undefined,
    short: boolean,
  ): Found {
    const body = spec.body!;
    const kind = commit.kind;
    if (body === null) {
      if (kind === "empty") return [];
      if (kind === "native") {
        return readCached(response, commit, cache).then((bytes) =>
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
      return emptyBodyIssues(response, commit, status, key, cache);
    }
    if (isDocumented(entry)) return [];
    const bodyKind = kindOf(entry);
    if (bodyKind === "opaque") return [];
    const bare = bareMediaType(contentType!);
    if (bodyKind === "chunks" || bodyKind === "sse") {
      return this.#streamBody(
        res,
        commit,
        status,
        key,
        bare,
        entry as unknown as StreamChunks | SseEvents,
        out,
      );
    }
    const format = this.#format;
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
          format,
          short,
        );
      case "text":
        return runBody(
          entry,
          textValue(bare, String(commit.body)),
          status,
          key,
          format,
          short,
        );
      case "bytes":
        return runBody(
          entry,
          bytesValue(bare, toBytes(commit.body as ArrayBufferView)),
          status,
          key,
          format,
          short,
        );
      case "blob":
      case "file":
      case "native":
        // Read without consuming what is sent: a Blob (a file's too) reads
        // again; a Response is cloned (Q-H5).
        return readCached(response, commit, cache).then((bytes) =>
          runBody(entry, bytesValue(bare, bytes), status, key, format, short),
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
      this.#reporter(res, commit),
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

  /** Where a stream's mismatches go, for this response. */
  #reporter(res: BunResponse, commit: ResponseCommit): StreamReporter {
    return {
      refuse: this.#mode === "error" && !commit.reportOnly,
      logger: this.#logger,
      where: this.#where(res),
    };
  }

  // -------------------------------------------------------------------------
  // Variants (plan §4.4.6)
  // -------------------------------------------------------------------------

  /** A variants status's commit: its outcome, then the verdict (held only when it must be). */
  #commitVariants(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    set: CompiledVariants,
    named: string | undefined,
  ): MaybePromise<
    | ResponseValidationError
    | ResponseStreamCheck
    | ResponseReplacement
    | undefined
  > {
    const reportOnly = this.#mode === "warn" || commit.reportOnly;
    let outcome: MaybePromise<Outcome>;
    try {
      outcome = this.#variants(res, response, commit, status, set, named);
    } catch (error) {
      outcome = { issues: [], failed: { error } };
    }
    if (!(outcome instanceof Promise)) {
      return this.#verdict(res, commit, status, outcome, reportOnly);
    }
    const settled = outcome.catch((error: unknown): Outcome => ({
      issues: [],
      failed: { error },
    }));
    if (reportOnly && named === undefined) {
      // Nothing to adjust: sent at once, reported when the check settles,
      // as V3a's "warn" does for a Promise-answering vendor.
      void settled.then((settledOutcome) =>
        this.#verdict(res, commit, status, settledOutcome, true),
      );
      return undefined;
    }
    return settled.then((settledOutcome) =>
      this.#verdict(res, commit, status, settledOutcome, reportOnly),
    );
  }

  /** Turns a variants outcome into the gate's verdict, reporting what must be. */
  #verdict(
    res: BunResponse,
    commit: ResponseCommit,
    status: number,
    outcome: Outcome,
    reportOnly: boolean,
  ):
    | ResponseValidationError
    | ResponseStreamCheck
    | ResponseReplacement
    | undefined {
    if (outcome.failed !== undefined) {
      this.#failed(res, status, outcome.failed.error);
      if (reportOnly) return replacementOf(outcome.adjusted, outcome.stream);
      return new ResponseValidationError(
        [issue("status", status, "The response could not be checked")],
        status,
      );
    }
    const issues = outcome.issues;
    if (issues.length === 0) {
      return replacementOf(outcome.adjusted, outcome.stream);
    }
    if (reportOnly) {
      this.#report(res, status, issues, commit.reportOnly);
      outcome.stream?.markReported();
      return replacementOf(outcome.adjusted, outcome.stream);
    }
    return new ResponseValidationError(issues, status);
  }

  /**
   * The decision for a variants status (plan §4.4.6): **selected** (the
   * variant `res.variant()` named, else the one the discriminant selects,
   * else every variant), **applicable** (its `when` holds; a boolean decided
   * in place, a Promise awaited), then, for a named variant, **adjusted**
   * (the discriminant filled first, then checked to agree), and **matched
   * whole** (the first applicable variant whose every part, and refine,
   * passes). Throws for a `when` answering a non-boolean (the caller makes
   * it a failed check).
   */
  #variants(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    set: CompiledVariants,
    named: string | undefined,
  ): MaybePromise<Outcome> {
    let selected: readonly CompiledVariant[];
    if (named !== undefined) {
      const variant = set.byName.get(named);
      if (variant === undefined) {
        return {
          issues: [
            issue(
              "status",
              status,
              `variant(${JSON.stringify(named)}) is not declared (${[...set.byName.keys()].join(", ")})`,
            ),
          ],
        };
      }
      selected = [variant];
    } else if (set.by !== undefined) {
      const picked = discriminate(set.by, response, commit);
      if (picked === undefined) {
        return { issues: [this.#selectsNone(set.by, status)] };
      }
      selected = [picked];
    } else {
      selected = set.variants;
    }
    // Applicable: with no `when` among them, every selected variant, and no
    // call; else one call each, decided in place, or awaited when a Promise.
    if (!selected.some((v) => v.when !== undefined)) {
      return this.#decide(res, response, commit, status, set, selected, NONE);
    }
    const req = res.req;
    const answers: MaybePromise<boolean>[] = [];
    let pending = false;
    for (const variant of selected) {
      const answer = applies(variant, req);
      pending ||= answer instanceof Promise;
      answers.push(answer);
    }
    const split = (holds: readonly boolean[]): MaybePromise<Outcome> => {
      const acceptable: CompiledVariant[] = [];
      const excluded: CompiledVariant[] = [];
      for (let i = 0; i < selected.length; i++) {
        (holds[i] ? acceptable : excluded).push(selected[i]);
      }
      return this.#decide(
        res,
        response,
        commit,
        status,
        set,
        acceptable,
        excluded,
      );
    };
    return pending
      ? Promise.all(answers).then(split)
      : split(answers as boolean[]);
  }

  /** How a lone selected variant was chosen, for its `does not apply` issue. */
  #how(set: CompiledVariants, commit: ResponseCommit): string {
    if (commit.variant !== undefined) return "named by variant()";
    const by = set.by!;
    return `selected by ${by.part === "headers" ? "header" : "cookie"} ${by.name}`;
  }

  /** The decision once every selected variant's `when` is known: the acceptable ones, and those `when` excluded. */
  #decide(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    set: CompiledVariants,
    acceptable: readonly CompiledVariant[],
    excluded: readonly CompiledVariant[],
  ): MaybePromise<Outcome> {
    if (acceptable.length === 0) {
      if (excluded.length === 1 && (commit.variant !== undefined || set.by)) {
        const one = excluded[0];
        return {
          issues: [
            {
              ...issue(
                "status",
                status,
                `Variant "${one.name}" (${this.#how(set, commit)}) does not apply to this request`,
              ),
              variant: one.name,
            },
          ],
        };
      }
      return this.#diagnose(res, response, commit, status, excluded, [
        issue(
          "status",
          status,
          `No variant of this status applies to this request (${excluded.length} excluded by when)`,
        ),
      ]);
    }
    let checkedResponse = response;
    let checkedCommit = commit;
    let adjusted: Adjusted | undefined;
    if (commit.variant !== undefined) {
      // `.variant()` adjusts once its `when` holds (a refused response is
      // never adjusted), then the discriminant must select it.
      const named = acceptable[0];
      adjusted = this.#adjust(res, set, named, response, commit, status);
      if (adjusted !== undefined) {
        checkedResponse = adjusted.response;
        checkedCommit = adjusted.commit;
      }
      const by = set.by;
      if (by !== undefined) {
        const picked = discriminate(by, checkedResponse, checkedCommit);
        if (picked === undefined) {
          return { issues: [this.#selectsNone(by, status)], adjusted };
        }
        if (picked !== named) {
          return {
            issues: [
              {
                target: by.part,
                message: `Selects variant "${picked.name}", but variant("${named.name}") was named`,
                path: this.#format?.redactPaths === true ? "" : by.name,
                key: String(status),
                variant: named.name,
              },
            ],
            adjusted,
          };
        }
      }
    }
    if (acceptable.length === 1) {
      // One candidate: checked in full at once, so a refusal needs no second run.
      const variant = acceptable[0];
      const out: CommitOut = {};
      const found = this.#checkVariant(
        res,
        checkedResponse,
        checkedCommit,
        status,
        variant,
        out,
        undefined,
        false,
      );
      if (!(found instanceof Promise) && found.length === 0) {
        return {
          issues: found,
          adjusted,
          stream: tagStream(out.stream, variant),
        };
      }
      return andThen(found, (issues): MaybePromise<Outcome> => {
        if (issues.length === 0) {
          return { issues, adjusted, stream: tagStream(out.stream, variant) };
        }
        return this.#diagnose(
          res,
          checkedResponse,
          checkedCommit,
          status,
          excluded,
          [this.#noneMatches(status, acceptable), ...issues],
          adjusted,
        );
      });
    }
    return this.#firstMatch(
      res,
      checkedResponse,
      checkedCommit,
      status,
      set,
      acceptable,
      excluded,
      adjusted,
    );
  }

  /** The summary issue of a refusal: the acceptable variants, none of which matched. */
  #noneMatches(
    status: number,
    acceptable: readonly CompiledVariant[],
  ): ValidationIssue<ResponsePart> {
    return issue(
      "status",
      status,
      `The response matches no acceptable variant (${acceptable.map((v) => v.name).join(", ")})`,
    );
  }

  /**
   * Several acceptable variants: the first whose every part passes, asking
   * each vendor only "does it pass"; a streamed body keeps every variant
   * passing at the commit as a survivor (Q-H24). On a refusal, every
   * acceptable variant runs again in full, for its issues.
   */
  #firstMatch(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    set: CompiledVariants,
    acceptable: readonly CompiledVariant[],
    excluded: readonly CompiledVariant[],
    adjusted: Adjusted | undefined,
  ): MaybePromise<Outcome> {
    const cache: ViewCache = {};
    const survivors: { name: string; check: StreamChecker }[] = [];
    const passed = (
      variant: CompiledVariant,
      out: CommitOut,
      issues: readonly ValidationIssue<ResponsePart>[],
    ): Outcome | undefined => {
      if (issues.length > 0) return undefined;
      const stream = out.stream;
      if (stream instanceof StreamChecker) {
        survivors.push({ name: variant.name, check: stream.tag(variant.name) });
        return undefined;
      }
      // A variant that passes with no per-chunk check (a buffered body, or
      // one whose body is not checked) takes the response as it is.
      return { issues: [], adjusted };
    };
    const tryFrom = (from: number): MaybePromise<Outcome> => {
      for (let i = from; i < acceptable.length; i++) {
        const variant = acceptable[i];
        const out: CommitOut = {};
        const found = this.#checkVariant(
          res,
          response,
          commit,
          status,
          variant,
          out,
          cache,
          true,
        );
        if (found instanceof Promise) {
          const next = i + 1;
          return found.then(
            (issues) => passed(variant, out, issues) ?? tryFrom(next),
          );
        }
        const done = passed(variant, out, found);
        if (done !== undefined) return done;
      }
      if (survivors.length > 0) {
        return {
          issues: [],
          adjusted,
          stream:
            survivors.length === 1
              ? survivors[0].check
              : new SurvivorsCheck(
                  survivors,
                  status,
                  this.#reporter(res, commit),
                ),
        };
      }
      // Refused: every acceptable variant's issues, in full (the failure path only).
      const full = acceptable.map((variant) =>
        this.#checkVariant(
          res,
          response,
          commit,
          status,
          variant,
          {},
          cache,
          false,
        ),
      );
      return andThen(gatherLists(full), (lists) =>
        this.#diagnose(
          res,
          response,
          commit,
          status,
          excluded,
          [this.#noneMatches(status, acceptable), ...lists.flat()],
          adjusted,
          cache,
        ),
      );
    };
    return tryFrom(0);
  }

  /** The issue for a discriminant whose value selects no variant: the declared values, never the received one. */
  #selectsNone(by: CompiledBy, status: number): ValidationIssue<ResponsePart> {
    return {
      target: by.part,
      message: `Does not select a variant (expected ${by.allowed})`,
      path: this.#format?.redactPaths === true ? "" : by.name,
      key: String(status),
    };
  }

  /**
   * One variant's parts, then its `refine` and the status's; in full, each
   * issue tagged with the variant; with `short`, pass or fail only.
   */
  #checkVariant(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    variant: CompiledVariant,
    out: CommitOut,
    cache: ViewCache | undefined,
    short: boolean,
  ): Found {
    const found = this.#checkParts(
      res,
      response,
      commit,
      status,
      variant,
      out,
      cache,
      short,
    );
    const refines = variant.refines;
    if (!(found instanceof Promise)) {
      if (found.length > 0) return short ? found : tagged(found, variant.name);
      if (refines.length === 0) return found;
    }
    return andThen(found, (issues) => {
      if (issues.length > 0) {
        return short ? issues : tagged(issues, variant.name);
      }
      return refines.length === 0
        ? issues
        : this.#refined(
            refines,
            res,
            response,
            commit,
            status,
            variant.name,
            short,
            cache,
          );
    });
  }

  /**
   * On the failure path only: names an excluded variant (its `when` did not
   * hold) the response matches in full, the leak this exists to catch.
   */
  #diagnose(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    excluded: readonly CompiledVariant[],
    issues: ValidationIssue<ResponsePart>[],
    adjusted?: Adjusted,
    cache: ViewCache = {},
  ): MaybePromise<Outcome> {
    if (excluded.length === 0) return { issues, adjusted };
    const found = excluded.map((variant) =>
      this.#checkVariant(
        res,
        response,
        commit,
        status,
        variant,
        {},
        cache,
        true,
      ),
    );
    return andThen(gatherLists(found), (lists) => {
      lists.forEach((list, i) => {
        if (list.length > 0) return;
        const name = excluded[i].name;
        issues.push({
          ...issue(
            "status",
            status,
            `The response matches variant "${name}", which does not apply to this request`,
          ),
          variant: name,
        });
      });
      return { issues, adjusted };
    });
  }

  /**
   * Runs `refine`s on the whole response, once its parts passed. Their
   * issues are scrubbed against **every** part (a refine sees them all), and
   * worded per the validator's `messages` and `redactPaths`. Throws what a
   * refine throws.
   */
  #refined(
    refines: readonly Refine[],
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    variant: string | undefined,
    short: boolean,
    cache: ViewCache | undefined,
  ): Found {
    return andThen(bodyValueOf(response, commit, cache), (body) => {
      const headers = viewHeaders(response, commit, cache);
      const cookies = viewCookies(response, cache);
      const contentType = commit.contentType;
      const view: RefineResponse = {
        status,
        headers,
        cookies,
        mediaType:
          contentType === undefined ? undefined : bareMediaType(contentType),
        body,
        variant,
      };
      const received = { status, headers, cookies, body };
      const out: ValidationIssue<ResponsePart>[] = [];
      for (const refine of refines) {
        const found: unknown = refine(view, res.req);
        if (found === undefined) continue;
        if (!Array.isArray(found)) {
          throw new TypeError(
            "refine must return an array of issues, or undefined",
          );
        }
        if (found.length === 0) continue;
        if (short) return [MISMATCH];
        for (const one of found as RefineIssue[]) {
          out.push(this.#refineIssue(one, received, status, variant));
        }
      }
      return out;
    });
  }

  /** One `refine` issue, its message scrubbed against the whole response. */
  #refineIssue(
    one: RefineIssue,
    received: Readonly<Record<string, unknown>>,
    status: number,
    variant: string | undefined,
  ): ValidationIssue<ResponsePart> {
    const part: ResponsePart = RESPONSE_PARTS.has(one.part)
      ? one.part
      : "status";
    const path = typeof one.path === "string" ? one.path : "";
    // The path is read from the response's root (`headers.x-total`), so the
    // value it leads to is compared with the message too.
    const [scrubbed] = toIssues(
      [
        {
          message: typeof one.message === "string" ? one.message : "",
          path: path === "" ? [part] : [part, ...path.split(".")],
        },
      ],
      received,
      part,
      String(status),
      undefined,
      this.#format,
      // A refine sees every part, so its message is compared with them all.
      "whole",
    );
    return {
      target: part,
      message: scrubbed.message,
      path: this.#format?.redactPaths === true ? "" : path,
      key: String(status),
      ...(variant === undefined ? {} : { variant }),
    };
  }

  /** The adjust-only step under `"off"` (Q-H29): `.variant()`'s fills and strips, no `when`, no check. */
  #adjustOnly(
    res: BunResponse,
    response: Response,
    commit: ResponseCommit,
    status: number,
    entry: CompiledEntry | undefined,
    named: string | undefined,
  ): ResponseStreamCheck | ResponseReplacement | undefined {
    if (named === undefined || entry?.variants === undefined) return undefined;
    const variant = entry.byName.get(named);
    if (variant === undefined) return undefined;
    return replacementOf(
      this.#adjust(res, entry, variant, response, commit, status),
      undefined,
    );
  }

  /**
   * What `.variant()` adjusts (plan §4.4.6, Q-H18): fills what the variant's
   * schemas allow exactly one value for and the handler did not set (the
   * discriminant first, single-literal headers and cookies, `Content-Type`
   * for a JSON body whose type is only `json()`'s implicit one, required
   * literal body fields, and the status, already chosen by the caller), and
   * strips JSON body fields the variant does not declare, copy-on-write. A
   * value the handler set is never overwritten: it is left to the check.
   * `undefined` when nothing changes. Never throws: an adjust that fails
   * leaves the response as the handler made it, and is logged.
   */
  #adjust(
    res: BunResponse,
    set: CompiledVariants,
    variant: CompiledVariant,
    response: Response,
    commit: ResponseCommit,
    status: number,
  ): Adjusted | undefined {
    try {
      const plan = variant.adjust;
      const changes: string[] = [];
      let headers: Headers | undefined;
      const writable = (): Headers =>
        (headers ??= new Headers(response.headers));
      const fillHeader = (name: string, value: string): void => {
        if ((headers ?? response.headers).has(name)) return;
        writable().set(name, value);
        changes.push(`headers.${name}: filled`);
      };
      let cookies: Record<string, SetCookieView> | undefined;
      const fillCookie = (name: string, view: SetCookieView): void => {
        cookies ??= setCookieView(response.headers.getSetCookie());
        if (cookies[name] !== undefined) return;
        writable().append("set-cookie", cookieLine(name, view));
        cookies[name] = view;
        changes.push(`cookies.${name}: filled`);
      };
      // 1. The discriminant, from `by.values` (an exact value only).
      const by = set.by;
      const exact = by?.exact.get(variant.name);
      if (by !== undefined && exact !== undefined) {
        if (by.part === "headers") fillHeader(by.name, exact);
        else {
          fillCookie(by.name, {
            value: exact,
            httpOnly: false,
            secure: false,
            partitioned: false,
            path: "/",
          });
        }
      }
      // 2. Declared headers and cookies admitting one value.
      for (const [name, value] of plan.headers) fillHeader(name, value);
      for (const [name, view] of plan.cookies) fillCookie(name, view);
      // 3. Content-Type: the variant's one media type, for a JSON body sent
      //    with json()'s implicit type only (Q-H28).
      const json = commit.kind === "json";
      let contentType = commit.contentType;
      const declared = plan.mediaType;
      if (json && commit.typeImplicit && declared !== undefined) {
        const bare = bareMediaType(declared);
        if (
          isJsonMedia(bare) &&
          (contentType === undefined || bareMediaType(contentType) !== bare)
        ) {
          contentType = declared;
          writable().set("content-type", declared);
          changes.push("headers.content-type: filled");
        }
      }
      // 4. The body: a JSON value only (json(), send(object)).
      let body = commit.body;
      if (json && contentType !== undefined && variant.body) {
        const matched = variant.body.match(contentType);
        const node =
          matched === undefined
            ? undefined
            : plan.bodies.get(matched[0].declared);
        if (node !== undefined) body = applyNode(node, body, "", changes);
      }
      // 5. The status (Q-H28), chosen by the caller.
      const statusChanged = status !== response.status;
      if (statusChanged) changes.unshift(`status: filled (${status})`);
      if (changes.length === 0) return undefined;
      const init = writable();
      if (contentType !== undefined && !init.has("content-type")) {
        init.set("content-type", contentType);
      }
      const bodyChanged = body !== commit.body;
      const text = json ? JSON.stringify(body) : undefined;
      const adjusted = new Response(
        json ? text : bodyInitOf(response, commit),
        statusChanged
          ? { status, headers: init }
          : { status, statusText: response.statusText, headers: init },
      );
      const logger = this.#logger();
      if (logger.isLevelEnabled("debug")) {
        logger.debug("response adjusted by res.variant()", {
          ...this.#where(res),
          status,
          variant: variant.name,
          changes,
        });
      }
      return {
        response: adjusted,
        commit: { ...commit, contentType, body },
        changes,
        ...(bodyChanged ? { body, text } : {}),
      };
    } catch (error) {
      this.#logger().error(
        "res.variant() could not adjust the response; it is sent as the handler made it",
        { ...this.#where(res), status, variant: variant.name, error },
      );
      return undefined;
    }
  }
}

/** Whether a spec's body is checked for this commit: declared, and not a redirect's, a status's or a body-less status's. */
function bodyChecked(
  spec: CompiledSpec,
  commit: ResponseCommit,
  status: number,
): boolean {
  const kind = commit.kind;
  // A redirect's or a status's generated body, and the body-less statuses,
  // are exempt: only their status and headers are the handler's.
  return (
    spec.body !== undefined &&
    kind !== "redirect" &&
    kind !== "status" &&
    status !== 204 &&
    status !== 205 &&
    status !== 304
  );
}

/** The headers view, cached while matching variants. */
function viewHeaders(
  response: Response,
  commit: ResponseCommit,
  cache: ViewCache | undefined,
): Record<string, string> {
  if (cache === undefined) return headersView(response, commit.contentType);
  return (cache.headers ??= headersView(response, commit.contentType));
}

/** The `Set-Cookie` view, cached while matching variants. */
function viewCookies(
  response: Response,
  cache: ViewCache | undefined,
): Record<string, SetCookieView> {
  if (cache === undefined) {
    return setCookieView(response.headers.getSetCookie());
  }
  return (cache.cookies ??= setCookieView(response.headers.getSetCookie()));
}

/** A read body's bytes, read once while matching variants. */
async function readCached(
  response: Response,
  commit: ResponseCommit,
  cache: ViewCache | undefined,
): Promise<Uint8Array> {
  if (cache === undefined) return readBytes(response, commit);
  return (cache.bytes ??= readBytes(response, commit));
}

/** The body a `refine` sees, as the body's schema would (parsed JSON, text, bytes); `undefined` for a stream or none. */
function bodyValueOf(
  response: Response,
  commit: ResponseCommit,
  cache: ViewCache | undefined,
): MaybePromise<unknown> {
  const contentType = commit.contentType;
  const bare = contentType === undefined ? "" : bareMediaType(contentType);
  const valueOf = (value: BodyValue): unknown =>
    value.ok ? value.value : undefined;
  switch (commit.kind) {
    case "json":
      return commit.body;
    case "text":
      return valueOf(textValue(bare, String(commit.body)));
    case "bytes":
      return valueOf(bytesValue(bare, toBytes(commit.body as ArrayBufferView)));
    case "blob":
    case "file":
    case "native":
      return readCached(response, commit, cache).then((bytes) =>
        valueOf(bytesValue(bare, bytes)),
      );
    default:
      return undefined;
  }
}

/** What an adjusted response's body is built from, for a body that is not a JSON value (never re-read). */
function bodyInitOf(
  response: Response,
  commit: ResponseCommit,
): ConstructorParameters<typeof Response>[0] {
  switch (commit.kind) {
    case "text":
      return String(commit.body);
    case "bytes":
      return toBytes(commit.body as ArrayBufferView) as Uint8Array<ArrayBuffer>;
    case "blob":
    case "file":
      return commit.body as Blob;
    case "open":
    case "empty":
      return null;
    default:
      return response.body;
  }
}

/** The verdict that sends an adjusted response (with its stream check), or the stream check alone. */
function replacementOf(
  adjusted: Adjusted | undefined,
  stream: GateStream | undefined,
): ResponseStreamCheck | ResponseReplacement | undefined {
  if (adjusted === undefined) return stream;
  return {
    replacement: adjusted.response,
    stream,
    ...(adjusted.text === undefined || !("body" in adjusted)
      ? {}
      : { body: adjusted.body, text: adjusted.text }),
  };
}

/** Names the variant on a single variant's stream check. */
function tagStream(
  stream: GateStream | undefined,
  variant: CompiledVariant,
): GateStream | undefined {
  return stream instanceof StreamChecker ? stream.tag(variant.name) : stream;
}

/** The variant a discriminant's value (as sent) selects; `undefined` when none. */
function discriminate(
  by: CompiledBy,
  response: Response,
  commit: ResponseCommit,
): CompiledVariant | undefined {
  let value: string | undefined;
  if (by.part === "headers") {
    value =
      response.headers.get(by.name) ??
      (by.name === "content-type" ? commit.contentType : undefined);
  } else {
    value = setCookieView(response.headers.getSetCookie())[by.name]?.value;
  }
  return by.select(value);
}

/**
 * Whether variant `variant`'s `when` holds for `req`: a boolean decided in
 * place (no Promise made), a Promise (or any thenable) of one awaited. A
 * non-boolean answer, or a Promise resolving to one, throws (a failed check).
 */
function applies(
  variant: CompiledVariant,
  req: BunRequest,
): MaybePromise<boolean> {
  const when = variant.when;
  if (when === undefined) return true;
  const answer = (when as (valid: unknown, req: BunRequest) => unknown)(
    req.valid,
    req,
  );
  if (typeof answer === "boolean") return answer;
  if (isPromiseLike(answer)) {
    return Promise.resolve(answer).then((resolved: unknown) => {
      if (typeof resolved !== "boolean") {
        throw new TypeError(
          `variant ${JSON.stringify(variant.name)}: when must resolve to a boolean`,
        );
      }
      return resolved;
    });
  }
  throw new TypeError(
    `variant ${JSON.stringify(variant.name)}: when must return a boolean`,
  );
}

/** Issues tagged with the variant they were checked against (the refusal path only). */
function tagged(
  issues: readonly ValidationIssue<ResponsePart>[],
  variant: string,
): ValidationIssue<ResponsePart>[] {
  return issues.map((i) => ({ ...i, variant }));
}

/** Resolves a list of issue lists, staying synchronous when it can. */
function gatherLists(
  list: readonly Found[],
): MaybePromise<ValidationIssue<ResponsePart>[][]> {
  return list.some((f) => f instanceof Promise)
    ? Promise.all(list)
    : (list as ValidationIssue<ResponsePart>[][]);
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
  cache: ViewCache | undefined,
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
      return readCached(response, commit, cache).then((bytes) =>
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
