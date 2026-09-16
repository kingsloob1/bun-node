import type {
  BunRequest,
  BunResponse,
  BunRouter,
  RouterHandler,
  ValidationSchemas,
} from "@kingsleyweb/bun-common";
import type { AuthorizeTarget } from "../auth";
import type {
  JobsApiAction,
  JobsApiRouteInfo,
  OpenApiDocument,
  ResolvedJobsApiConfig,
} from "../config";
import type { ApiErrorCode } from "../errors";
import type { Infer, Schema } from "../schema/builder";
import type { QueueSource, RunnerSource } from "../sources";
import { validate } from "@kingsleyweb/bun-common";
import { ConfigError } from "../../shared/errors";
import { authorizeHandler, csrfGuard, deferFailure } from "../auth";
import {
  bodySizeGuard,
  declaredBodySizeGuard,
  emptyBodyAsObject,
  jsonBodyGuard,
} from "../body";
import { isMutation } from "../config";

/**
 * One route definition feeds three things: the router (validation, CSRF,
 * authorization, the handler), the handler's types (inferred from the same
 * schemas), and the OpenAPI document. A route that exists in one of those and
 * not the others is how an API and its spec come to disagree.
 */

/** The HTTP methods routes use. */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Which half of the API a route belongs to; `"any"` is routed in every mode. */
export type RouteMode = "jobs" | "runner" | "any";

/** Declared responses by status. `null` means the status carries no body (e.g. 204). */
export type RouteResponses = Readonly<Record<number, Schema<any, any> | null>>;

/** The body types a route's responses allow: a union over every declared status. */
export type ResponseBody<R extends RouteResponses> = {
  [K in keyof R]: R[K] extends Schema<any, any> ? Infer<R[K]> : undefined;
}[keyof R];

/** What handlers are given besides the request: the API's resolved pieces. */
export interface RouteServices {
  /** The resolved configuration. */
  config: ResolvedJobsApiConfig;
  /** Queue membership and lookup. */
  queues: QueueSource;
  /** Runner lookup, local or remote. */
  runners: RunnerSource;
  /** Every registered route, after pruning. */
  routes: () => readonly JobsApiRouteInfo[];
  /** A fresh copy of the OpenAPI document. */
  openapi: () => OpenApiDocument;
}

/** What a route handler receives, with validated and typed inputs. */
export interface RouteContext<P, Q, B> {
  /** The request. */
  req: BunRequest;
  /** The response, for the rare handler that writes it itself. */
  res: BunResponse;
  /** Path parameters, as the `params` schema produced them. */
  params: P;
  /** Query values, as the `query` schema produced them. */
  query: Q;
  /** The body, as the `body` schema produced it. */
  body: B;
  /** The API's resolved pieces. */
  services: RouteServices;
}

/** What a route handler answers. */
export interface RouteResult<TBody> {
  /** The status; defaults to the route's first 2xx response. */
  status?: number;
  /** The body; omitted for a body-less status. */
  body?: TBody;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

/** A route: its place in the router, its contract, and its handler. */
export interface RouteDef<P, Q, B, R extends RouteResponses> {
  /** The HTTP method. */
  method: RouteMethod;
  /** Express-syntax path under `basePath`, e.g. `"/queues/:queue/jobs/:id"`. */
  path: `/${string}`;
  /** Unique OpenAPI operation id, e.g. `"retryJob"`. */
  operationId: string;
  /** The action `authorize` is asked about. */
  action: JobsApiAction;
  /** Which half the route belongs to. */
  mode: RouteMode;
  /** Optional driver methods the route needs; it is pruned on a driver lacking any. */
  requires?: readonly string[];
  /** Whether the route needs a `jobs` source (e.g. `/definitions`). */
  needsJobsSource?: boolean;
  /**
   * Accept a blank body as `{}`, so the body schema's defaults apply to a
   * request that sends none (`POST …/pause` with no payload). The docs mark
   * the body optional. Defaults to `false`.
   */
  bodyOptional?: boolean;
  /**
   * Largest request body accepted, in bytes; a larger one is 413
   * `PAYLOAD_TOO_LARGE`, checked before the body is validated. Unset, only
   * bun-common's own cap applies.
   */
  maxBodyBytes?: number;
  /** An extra condition on the configuration, e.g. docs being enabled. */
  enabledWhen?: (config: ResolvedJobsApiConfig) => boolean;
  /** One-line summary for the docs. */
  summary: string;
  /** Longer Markdown description for the docs. */
  description?: string;
  /** Docs tags. */
  tags: readonly string[];
  /** Validates and types `req.params`. Wrap in `s.query` to coerce. */
  params?: Schema<P, any>;
  /** Validates and types `req.query`. Wrap in `s.query` to coerce. */
  query?: Schema<Q, any>;
  /** Validates and types `req.body`. */
  body?: Schema<B, any>;
  /** Declared responses by status. */
  responses: R;
  /**
   * Problem codes the route answers with, beyond the ones every route gets
   * (401/403, validation, CSRF and JSON errors where they apply).
   */
  errors?: readonly ApiErrorCode[];
  /** Reads the authorization target out of the validated inputs. */
  target?: (input: { params: P; query: Q; body: B }) => AuthorizeTarget;
  /** Answers the request. */
  handler: (
    ctx: RouteContext<P, Q, B>,
  ) => RouteResult<ResponseBody<R>> | Promise<RouteResult<ResponseBody<R>>>;
}

/**
 * A route of any shape, as the registrar and the spec generator hold them.
 * `R` is `any` too: `ResponseBody<RouteResponses>` would collapse to
 * `undefined` and refuse every concrete route.
 */
export type AnyRouteDef = RouteDef<any, any, any, any>;

/**
 * Declares a route, inferring the handler's `params`, `query` and `body` from
 * the schemas and its allowed bodies from `responses`.
 */
export function defineRoute<
  P = Record<string, string>,
  Q = Record<string, unknown>,
  // `unknown`, not `undefined`: without a body schema a JSON mutation still
  // carries whatever body was sent (often `{}`), unvalidated.
  B = unknown,
  const R extends RouteResponses = RouteResponses,
>(def: RouteDef<P, Q, B, R>): RouteDef<P, Q, B, R> {
  return def;
}

/**
 * The single pruning predicate: a route is registered, documented and reported
 * by `/meta/permissions` only when this holds.
 *
 * - its mode matches (`"any"`, or the API's mode, or the API is `"both"`);
 * - it is not a mutation under `readOnly`;
 * - its action is allowed by `actions` (or the default);
 * - the driver implements every method in `requires`;
 * - it has a `jobs` source when it needs one;
 * - its own `enabledWhen` holds.
 */
export function isRouteEnabled(
  def: AnyRouteDef,
  config: ResolvedJobsApiConfig,
): boolean {
  if (
    def.mode !== "any" &&
    config.mode !== "both" &&
    config.mode !== def.mode
  ) {
    return false;
  }
  if (config.readOnly && isMutation(def.action)) {
    return false;
  }
  if (!config.enabledActions.has(def.action)) {
    return false;
  }
  const driver = config.driver as unknown as Record<string, unknown>;
  if (
    !(def.requires ?? []).every(
      (method) => typeof driver[method] === "function",
    )
  ) {
    return false;
  }
  if (def.needsJobsSource && !config.jobs) {
    return false;
  }
  return def.enabledWhen ? def.enabledWhen(config) : true;
}

/** The first 2xx status a route declares, or 200. */
export function defaultStatus(def: AnyRouteDef): number {
  const statuses = Object.keys(def.responses)
    .map(Number)
    .sort((a, b) => a - b);
  return statuses.find((status) => status >= 200 && status < 300) ?? 200;
}

/** Turns a handler's result into the response, checking it against its schema when asked. */
function respond(def: AnyRouteDef, services: RouteServices): RouterHandler {
  const fallback = defaultStatus(def);
  return async (req, res) => {
    const result = await def.handler({
      req,
      res,
      params: req.params,
      query: req.query,
      body: req.body,
      services,
    });
    if (res.headersSent) {
      return;
    }

    const status = result.status ?? fallback;
    const schema = def.responses[status];

    if (services.config.validateResponses) {
      const mismatch = await responseMismatch(schema, status, result.body);
      if (mismatch) {
        services.config.logger.error(
          "jobs api response did not match its schema",
          { operationId: def.operationId, status, mismatch },
        );
      }
    }

    for (const [name, value] of Object.entries(result.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.status(status);
    if (schema === null || result.body === undefined) {
      return res.end();
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.send(JSON.stringify(result.body));
  };
}

/** Why a response does not match its declaration, or `undefined` when it does. */
async function responseMismatch(
  schema: Schema<any, any> | null | undefined,
  status: number,
  body: unknown,
): Promise<string | undefined> {
  if (schema === undefined) {
    return `status ${status} is not declared`;
  }
  if (schema === null) {
    return body === undefined ? undefined : `status ${status} declares no body`;
  }
  const result = await schema["~standard"].validate(body);
  if (!result.issues) {
    return undefined;
  }
  return result.issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) =>
          typeof segment === "object" && segment !== null && "key" in segment
            ? String(segment.key)
            : String(segment),
        )
        .join(".");
      return `${path || "(body)"}: ${issue.message}`;
    })
    .join("; ");
}

/** Joins `basePath` and a route path. */
export function joinPath(basePath: string, path: string): string {
  return `${basePath}${path}`;
}

/**
 * Registers routes on a router, in this order per route:
 *
 * 1. `declaredBodySizeGuard` — routes reading a body: a `Content-Length` over
 *    the cap (`maxBodyBytes`, else `limits.maxJobDataBytes`) is 413 at once;
 * 2. `csrfGuard` — mutations only, when CSRF is on;
 * 3. `bodySizeGuard` and `jsonBodyGuard` — routes reading a body;
 * 4. `validate({ params, query, body })`;
 * 5. `authorizeHandler` — with the target read from the **validated** inputs;
 * 6. the handler.
 *
 * Steps 2–4 are deferred ({@link deferFailure}): a failure is recorded, not
 * answered, and step 5 asks `authorize` once — without a target — before the
 * client learns what was wrong. Only the declared-size 413 is answered before
 * `authorize`. bun-common parses a body before the router runs, so this cap
 * cannot stop bun-common buffering one: its own `maxContentLength` bounds that.
 *
 * Refuses (with `ConfigError`) two routes on one method and path, and two
 * routes with one operation id. Returns what was registered.
 */
export function registerRoutes(
  router: BunRouter,
  defs: readonly AnyRouteDef[],
  services: RouteServices,
): JobsApiRouteInfo[] {
  const { config } = services;
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  const registered: JobsApiRouteInfo[] = [];

  for (const def of defs) {
    const key = `${def.method} ${def.path}`;
    if (seenPaths.has(key)) {
      throw new ConfigError(`Two routes are registered for ${key}`, {
        route: key,
      });
    }
    if (seenIds.has(def.operationId)) {
      throw new ConfigError(
        `Two routes share the operation id "${def.operationId}"`,
        {
          operationId: def.operationId,
        },
      );
    }
    seenPaths.add(key);
    seenIds.add(def.operationId);

    const mutation = isMutation(def.action);
    const readsBody = def.body !== undefined || mutation;
    const bodyCap = def.maxBodyBytes ?? config.limits.maxJobDataBytes;
    // Checks whose failure must not be answered before `authorize`: each
    // records the first failure instead of answering it, and the authorize
    // step decides what the client is told.
    const failures = new WeakMap<BunRequest, unknown>();
    const deferred = (handler: RouterHandler) =>
      deferFailure(handler, failures);
    const handlers: RouterHandler[] = [];
    if (readsBody) {
      // The one answer given before `authorize`: a declared size over the
      // cap, refused unread. It reveals nothing but the configured cap.
      handlers.push(declaredBodySizeGuard(bodyCap));
    }
    if (mutation && config.csrf !== false) {
      handlers.push(
        deferred(csrfGuard(config.csrf, { trustProxy: config.trustProxy })),
      );
    }
    if (readsBody) {
      handlers.push(deferred(bodySizeGuard(bodyCap)));
      handlers.push(deferred(jsonBodyGuard()));
    }
    if (def.body && def.bodyOptional) {
      handlers.push(deferred(emptyBodyAsObject()));
    }
    const schemas: ValidationSchemas = {};
    if (def.params) {
      schemas.params = def.params;
    }
    if (def.query) {
      schemas.query = def.query;
    }
    if (def.body) {
      schemas.body = def.body;
    }
    if (Object.keys(schemas).length > 0) {
      handlers.push(deferred(validate(schemas)));
    }
    const target = def.target;
    handlers.push(
      authorizeHandler(config, def.action, {
        route: { method: def.method, path: def.path },
        pending: (req) => failures.get(req),
        ...(target
          ? {
              target: (req: BunRequest) =>
                target({
                  params: req.params,
                  query: req.query,
                  body: req.body,
                }),
            }
          : {}),
      }),
    );
    handlers.push(respond(def, services));

    const verb = def.method.toLowerCase() as Lowercase<RouteMethod>;
    const register = router[verb] as unknown as (
      path: string,
      ...callbacks: RouterHandler[]
    ) => unknown;
    register.call(router, def.path, ...handlers);

    registered.push({
      method: def.method,
      path: joinPath(config.basePath, def.path),
      operationId: def.operationId,
      action: def.action,
      mutation,
    });
  }

  return registered;
}
