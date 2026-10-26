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
   * The operation id. Must be unique across the document.
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
  };
  /**
   * Media types the body is accepted as. Default: `["application/json"]`
   * when a body schema exists, otherwise no `requestBody` is emitted.
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
   * Vendor extensions merged into the operation object verbatim. Keys must
   * start with `x-`. Default: none.
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
 * The doc recorded against a terminal callback, if any. Reads `undefined` for
 * a non-function, so the generator can call it on whatever `callbacks.at(-1)`
 * holds.
 */
export function routeDocFor(callback: unknown): RouteDoc | undefined {
  if (
    (typeof callback !== "function" && typeof callback !== "object") ||
    callback === null
  ) {
    return undefined;
  }
  return routeDocs.get(callback);
}
