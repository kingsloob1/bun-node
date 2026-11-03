/**
 * `.describe()` metadata (AD (a), plan `docs/plans/api-docs-generation/`
 * §3.2): what a route contributes to the generated documents, and the store
 * it lives in.
 *
 * The store is a module-level `WeakMap` keyed on the route's **terminal
 * callback**, not on the `Route` object: mounting a sub-router creates a new
 * `Route` and a new `callbacks` array, but the callback identities survive
 * (Decision 1, measured in the plan), so a sub-router's routes keep their
 * docs when mounted — and both mounts of a double-mounted sub-router share
 * one doc. Never consulted at request time: the zero-cost story (§3.1) is an
 * empty `WeakMap` and one branch in `describe()`.
 *
 * This module is imported by `BunRouter.ts`, so it must not import the
 * generator (`./openapi`) or the router itself — types only, no runtime edge.
 */
import type { DtoClass } from "../classDto";
import type { StandardSchemaV1 } from "../types/standardSchema";
import type { JsonSchemaLike } from "./convert";

/** One declared response (plan §3.2). */
export interface RouteResponseDoc {
  /** Required by OpenAPI. Default: the status's reason phrase. */
  description?: string;
  /**
   * The body schema: any Standard Schema, a raw JSON Schema, or a DTO class
   * (AD (b2)) — wrapped with `fromDto` for conversion, so a document from a
   * DTO needs `useClassDtos` to have run.
   */
  schema?: StandardSchemaV1 | JsonSchemaLike | DtoClass;
  /** Media type. Default: `"application/json"`. */
  mediaType?: string;
  /** Response headers, by name. Default: none. */
  headers?: Readonly<
    Record<string, { description?: string; schema?: JsonSchemaLike }>
  >;
  /** Examples, by name, merged into the media-type object. Default: none. */
  examples?: Readonly<Record<string, { summary?: string; value: unknown }>>;
}

/**
 * One file field of a multipart body (`RouteDoc.request.files`), as the
 * document describes it. Every field optional: `{}` documents one optional
 * file of any type and size.
 */
export interface RouteFileDoc {
  /** What the file is, as the property's `description`. Default: none. */
  description?: string;
  /**
   * The body must carry the field: listed in the schema's `required`.
   * Default: `false`, as for any property.
   */
  required?: boolean;
  /**
   * How many files the field takes, as bun-common's upload handlers'
   * `maxCount` says: `1` documents one file; more documents a list of them
   * (`type: "array"` with `maxItems`), and `Infinity` a list with no bound.
   * Default: `1`. Anything but a positive integer or `Infinity` is
   * documented as `1`, with a warning.
   */
  maxCount?: number;
  /**
   * The largest file accepted, in bytes, as the file schema's
   * `x-bun-max-bytes` (JSON Schema has no size keyword for binary content).
   * Default: none, and no `x-bun-max-bytes`.
   */
  maxBytes?: number;
  /**
   * The media types a file may have, as the multipart body's
   * `encoding[field].contentType` (OpenAPI's place for a part's media
   * types, joined with `", "`; `type/*` allowed). Default: none, and no
   * `encoding` entry.
   */
  mediaTypes?: readonly string[];
}

/** What a route contributes to the generated document. Every field optional. */
export interface RouteDoc {
  /**
   * One-line summary, rendered as the operation's title.
   * Default: none — the operation gets no `summary`.
   */
  summary?: string;
  /**
   * Longer CommonMark description. Default: none.
   */
  description?: string;
  /**
   * Tags the operation is grouped under. Default: `[]`, which means the
   * operation is untagged and viewers list it under "default".
   */
  tags?: readonly string[];
  /**
   * The operation id. Must be unique across the document; on a router
   * mounted at several paths, the first mount's route keeps it and each
   * later mount's gets a suffix from its mount (`getUser`, `getUserV2`).
   * Default: derived from method + path (see
   * {@link import("./openapi").OpenApiOptions.operationId}).
   */
  operationId?: string;
  /**
   * Marks the operation deprecated. Default: `false`.
   */
  deprecated?: boolean;
  /**
   * Leaves this route out of every generated document, including the
   * `paths` entry. Default: `false`. Use for health checks, the docs routes
   * themselves, and anything whose path OpenAPI cannot express.
   */
  hidden?: boolean;
  /**
   * Request schemas, when the route has no `validate()` middleware or when
   * the validator's schemas describe less than the route accepts. A target
   * given here **replaces** whatever was discovered for that target — but it
   * documents without enforcing (nothing validates it at runtime), and when
   * it disagrees with a discovered *checking* schema the generator warns.
   * Default: discovered from the pipeline's validators.
   */
  request?: {
    /** Path parameters. Keys must be names the path declares. */
    params?: StandardSchemaV1 | JsonSchemaLike | DtoClass;
    /** Query string. */
    query?: StandardSchemaV1 | JsonSchemaLike | DtoClass;
    /** Request body, for the media types in {@link RouteDoc.requestMediaTypes}. */
    body?: StandardSchemaV1 | JsonSchemaLike | DtoClass;
    /** Request headers. Emitted as `in: "header"` parameters. */
    headers?: StandardSchemaV1 | JsonSchemaLike | DtoClass;
    /** Request cookies. Emitted as `in: "cookie"` parameters (plan §4.11). */
    cookies?: StandardSchemaV1 | JsonSchemaLike | DtoClass;
    /**
     * The file fields of a `multipart/form-data` body, by field name
     * (typed-client plan, `other-transports.md` §3): each documented as a
     * `{ type: "string", format: "binary" }` property of the multipart
     * body's schema (a list of them when {@link RouteFileDoc.maxCount} is
     * above 1), beside the body's own fields (`request.body`, else the
     * validator's body). A client generator types them as files.
     * Documentation only: the multipart handlers' limits stay the
     * enforcement (a file is not a validation target). With files and no
     * {@link RouteDoc.requestMediaTypes}, the body is documented as
     * `multipart/form-data`; files given beside media types that include no
     * `multipart/form-data` are left out, with a warning. Default: none.
     */
    files?: Readonly<Record<string, RouteFileDoc>>;
  };
  /**
   * Media types the body is accepted as: `request.body`'s, or the
   * validator's body when it declares no media type of its own (a
   * validator's body is JSON by default; `["application/x-www-form-urlencoded"]`
   * documents a form). Default: `["multipart/form-data"]` when
   * `request.files` is given, else `["application/json"]` when a body schema
   * exists, otherwise no `requestBody` is emitted.
   */
  requestMediaTypes?: readonly string[];
  /**
   * Whether a body must be sent. Default: `true` when a body schema exists.
   */
  requestRequired?: boolean;
  /**
   * Declared responses by status, **for documentation only**. `null` means
   * "no body" (204). A bare Standard Schema is shorthand for
   * `{ schema, description: <reason phrase> }`; a raw JSON Schema goes under
   * `{ schema: … }` (a bare plain object reads as a `RouteResponseDoc`).
   *
   * This never reaches the type system and is never checked at runtime — it
   * cannot be, because `.describe()` runs after the handler was already
   * type-checked (§3.4, spiked). To *enforce* responses, declare them on the
   * validator instead: `validate(schemas, { responses })` (§3.5). Use this
   * form for a route with no validator, or for a status the handler never
   * produces itself (a 401 added by middleware).
   *
   * When both exist, the validator wins (Decision 4): a status the validator
   * declares is documented from the validator, and `.describe()`'s entry for
   * it is merged for documentation only, with a warning if they disagree.
   *
   * Default: `{}` — the generator then emits a single
   * `default: { description: "Unspecified" }`, which is valid but useless,
   * and `strict` mode (see `OpenApiOptions.strict`) rejects it.
   */
  responses?: Readonly<
    Record<number, RouteResponseDoc | StandardSchemaV1 | DtoClass | null> & {
      default?: RouteResponseDoc | StandardSchemaV1 | DtoClass | null;
    }
  >;
  /**
   * Security requirements for this operation, overriding the document-wide
   * one. `[]` means "explicitly public". Default: inherit the document's.
   */
  security?: readonly Record<string, readonly string[]>[];
  /**
   * The error codes this route answers with (the `code` of its problem+json
   * bodies), emitted as the operation's `x-bun-errors` array in the order
   * given (typed-client plan §4.3: a client turns them into a `code` union).
   * Documentation only: nothing checks that the handler sends them. `[]`
   * declares "no codes" and is emitted as `[]`. Default: none, and no
   * `x-bun-errors` is emitted. Wins over an `extensions["x-bun-errors"]`
   * given beside it (with a warning when the two differ).
   */
  errors?: readonly string[];
  /**
   * The cache tags this route's response carries and the tags a successful
   * call invalidates, emitted as the operation's `x-bun-cache` object
   * (typed-client plan §6.4, in bun-cache's vocabulary). A template may name
   * the route's own path params in braces (`"user:{id}"`); a name the path
   * does not declare is emitted as written, with a warning. It reaches
   * neither the handler's types nor bun-cache's runtime; with
   * `liveInvalidation()` (`@kingsleyweb/bun-common/live`) mounted,
   * `invalidates` is published, filled from the request's params, when the
   * response is a 2xx. Default: none, and no `x-bun-cache` is emitted. Wins over an
   * `extensions["x-bun-cache"]` given beside it (with a warning when the two
   * differ).
   */
  cache?: {
    /**
     * Tags the response carries (`["user:{id}"]`): what a client files the
     * cached result under, so that invalidating a tag refetches it.
     * Default: none, and the field is left out of `x-bun-cache`.
     */
    tags?: readonly string[];
    /**
     * Tags a successful call invalidates (`["user:{id}", "users"]`),
     * typically declared on a mutation. Default: none, and the field is left
     * out of `x-bun-cache`.
     */
    invalidates?: readonly string[];
  };
  /**
   * Vendor extensions merged into the operation object verbatim. Keys must
   * start with `x-`. `x-bun-route-key` is the generator's own and is never
   * taken from here (a warning says so); `x-bun-errors` and `x-bun-cache`
   * yield to {@link RouteDoc.errors} and {@link RouteDoc.cache} when those
   * are given. Default: none.
   */
  extensions?: Readonly<Record<`x-${string}`, unknown>>;
}

/**
 * The store: terminal callback → its doc. A `WeakMap`, so a dropped router's
 * docs go with it.
 */
const routeDocs = new WeakMap<object, RouteDoc>();

/**
 * Records `doc` against a route's terminal callback; called by
 * `BunRouter.describe()`. Calling it twice for one route merges, last write
 * winning per (top-level) key.
 */
export function attachRouteDoc(callback: object, doc: RouteDoc): void {
  const existing = routeDocs.get(callback);
  routeDocs.set(
    callback,
    existing === undefined ? doc : { ...existing, ...doc },
  );
}

/**
 * The reflect-metadata key a framework decorator records a {@link RouteDoc}
 * under: bun-nest's `@Describe` (typed-client plan `nest-typed-routes.md`
 * §3.2, §9.5). Written by value on both sides, as the `"bun:*"` keys are.
 */
const ROUTE_DOC_METADATA = "bun:describe";

/**
 * The reflect-metadata polyfill's reader, when it is loaded (a Nest
 * application's always is); read structurally, so this module neither
 * imports nor types the polyfill.
 */
const reflectMeta = Reflect as unknown as {
  getMetadata?: (key: unknown, target: object) => unknown;
};

/**
 * The doc recorded against a terminal callback, if any. Reads `undefined` for
 * a non-function, so the generator can call it on whatever `callbacks.at(-1)`
 * holds.
 *
 * Besides `describe()`'s store, it reads the `"bun:describe"` reflect
 * metadata on the callback, when the polyfill is loaded: bun-nest's
 * `@Describe` writes it on a controller method, and NestJS's
 * `RouterExplorer.copyMetadataToCallback` carries it onto the handler it
 * registers — the path a `@Validate` contract takes too (`getContract`).
 * When both exist, `describe()`'s doc is merged over the metadata's, per
 * top-level key.
 */
export function routeDocFor(callback: unknown): RouteDoc | undefined {
  if (
    (typeof callback !== "function" && typeof callback !== "object") ||
    callback === null
  ) {
    return undefined;
  }
  const stored = routeDocs.get(callback);
  const meta = reflectMeta.getMetadata?.(ROUTE_DOC_METADATA, callback);
  if (typeof meta !== "object" || meta === null) return stored;
  const written: RouteDoc = meta;
  return stored === undefined ? written : { ...written, ...stored };
}
