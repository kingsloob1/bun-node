/**
 * The route model (bun-validate V12, plan `docs/plans/bun-validate/` §6 row
 * 18, §4.11, §4.12 M2/M3/M6/m3/m4/m6): what a document generator or a typed
 * client reads from a router.
 *
 * - {@link listRoutes} walks a router's route table and, for every endpoint
 *   (a verb or `all()` route — never `use()` middleware or an error handler),
 *   answers a {@link ListedRoute}: its key, path, params, the effective
 *   contract of the layers that run for it, and the router's per-route
 *   response policy.
 * - {@link effectiveContract} merges the contracts the matched layers carry
 *   (`getContract`) into the one that applies, outermost first (plan Q-C11),
 *   with the route record's `commonResponses` merged under the route's
 *   outbound side.
 * - {@link bodyPlacement} reads a described request-body row into the
 *   placement a document needs (plan §4.12 m6).
 *
 * It lives at the package root, not the browser-safe `/contract` entry,
 * because it reads the router.
 */
import type { Route } from "@routejs/router";
import type { ContractDescription, ContractEntry } from "./contract/describe";
import { describeContract, mergeContracts } from "./contract/describe";
import { httpTransport } from "./contract/http";
import type { AnyContract, Schema, WireInput } from "./contract/model";
import { isPromiseLike } from "./contract/model";
import { isDocumented, jsonSchemaOf } from "./contract/schemas";
import { getContract, makeContract } from "./contract/transport";
import type { LoggerLike } from "./logging";
import type {
  OutboundDef,
  ResponseOutputMode,
  ResponseSchemas,
  ResponseValidationMode,
} from "./responseValidation";
import { mergeOutboundDefs, toOutboundDef } from "./responseValidation";
import type { Jsonify } from "./utils/native";
import { CAPTURE_PARAM } from "./utils/expressPath";
import type { BunRouter } from "./BunRouter";

/**
 * The fields of a BunRouter route record the listing reads: a routejs `Route`
 * plus BunRouter's tags (`RouteWithGroup`, `lib/BunRouter.ts`). Structural,
 * so a route from a plain `@routejs/router` `Router` (no tags) reads as an
 * endpoint when it has a `path` — the router's own flatten rule.
 */
interface RouteRecord {
  /** The route's host pattern; set on host-scoped routes (`domain()`). */
  readonly host: string | null;
  /** The route's method (upper-case), an array of them (`any()`), or null (`all()`, `use()`). */
  readonly method: string | string[] | null;
  /** The path as written; `null` on middleware and pathless `all()` handlers. */
  readonly path: string | null;
  /** The capture names (a name repeats across an alternation's alternatives). */
  readonly params: string[] | null;
  /** BunRouter's endpoint tag: `true` for verb/`all` route handlers. */
  readonly isEndpoint?: boolean;
  /** What the matcher does with each capture, by index (wildcards take an array). */
  readonly paramKinds?: readonly number[];
  /** Builds a concrete path from params (`route(name, params)`'s builder). */
  readonly compilePathRegexpToPath?: (params?: object) => string;
  /** The innermost router's `responseValidation` that set one, carried per route. */
  readonly responseValidation?: ResponseValidationMode;
  /** The innermost router's `responseOutput` that set one, carried per route. */
  readonly responseOutput?: ResponseOutputMode;
  /** Every enclosing router's `commonResponses`, outermost first (compiled). */
  readonly commonResponses?: readonly OutboundDef[];
  /** The route's callbacks, in registration order. */
  readonly callbacks: readonly unknown[];
}

/** The origin the router-level `commonResponses` merge records on the rows it wins. */
const COMMON_RESPONSES_ORIGIN = "router commonResponses";

/**
 * The default origin of a layer: its function name when it has one, else
 * `layer #i` (its position in `layers`). `listRoutes` names layers instead by
 * the mount path they run under (`req.baseUrl`, e.g. `"/users"`), and the
 * route's own callbacks by its key (`"GET /users/:id"`).
 */
function defaultOrigin(callback: unknown, index: number): string {
  const name =
    typeof callback === "function"
      ? (callback as { name?: string }).name
      : undefined;
  return typeof name === "string" && name !== "" ? name : `layer #${index}`;
}

/** What {@link effectiveContract} takes. */
export interface EffectiveContractOptions {
  /** Receives the merge's warnings (a part refined by an inner layer). */
  readonly logger?: LoggerLike;
  /**
   * Names a layer (what its won rows record as `origin`), by its position in
   * `layers`. Default: the callback's function name, else `layer #i`.
   */
  readonly origins?: (callback: unknown, index: number) => string;
  /**
   * A router-level response table merged **under** the layers' outbound side
   * (the innermost wins, plan Q-C11), as a route record carries it: either
   * the compiled `commonResponses` of every enclosing router, outermost
   * first, or one `ResponseSchemas` declaration (checked as `validate()`'s
   * `responses` is). Only applied when some layer carries an HTTP contract —
   * a channel route (the `websocket` transport) has no HTTP side to merge
   * under. Alone, without any layer carrying a contract, it makes none.
   */
  readonly commonResponses?: ResponseSchemas | readonly OutboundDef[];
}

/**
 * The contract that applies to a route: the contracts its layers carry
 * (`getContract` — a `validate()` middleware, a channel's checks, a wrapper
 * with `forwardContract`), merged outermost first through `mergeContracts`
 * (inbound, the outermost declaring a part is the wire schema; outbound, the
 * innermost wins), with `options.commonResponses` merged under the outbound
 * side. Returns `undefined` when no layer carries a contract.
 *
 * The layers of one route are all of one transport in practice. When they
 * are not (a channel's `websocket` contract under a mount's HTTP validators),
 * each transport's layers merge on their own and the **innermost** layer's
 * transport gives the result; the others' contracts still apply at runtime
 * but are not folded in.
 *
 * @param layers  The callbacks that run for the route, outermost first (the pipeline's order).
 * @param options See {@link EffectiveContractOptions}.
 */
export function effectiveContract(
  layers: readonly unknown[],
  options: EffectiveContractOptions = {},
): AnyContract | undefined {
  const carried: { contract: AnyContract; origin: string }[] = [];
  layers.forEach((callback, index) => {
    const contract = getContract(callback);
    if (contract === undefined) return;
    carried.push({
      contract,
      origin:
        options.origins?.(callback, index) ?? defaultOrigin(callback, index),
    });
  });
  if (carried.length === 0) return undefined;

  // One merge per transport, the layers keeping their order within it.
  const groups = new Map<string, typeof carried>();
  for (const layer of carried) {
    const name = layer.contract.transport.name;
    let group = groups.get(name);
    if (group === undefined) {
      group = [];
      groups.set(name, group);
    }
    group.push(layer);
  }

  const http = groups.get(httpTransport.spec.name);
  if (http !== undefined && options.commonResponses !== undefined) {
    const def = Array.isArray(options.commonResponses)
      ? mergeOutboundDefs(options.commonResponses)
      : toOutboundDef(
          options.commonResponses,
          "effectiveContract(): commonResponses",
        );
    http.unshift({
      contract: makeContract(httpTransport.spec, { outbound: def }, {}),
      origin: COMMON_RESPONSES_ORIGIN,
    });
  }

  const innermost = carried[carried.length - 1].contract.transport.name;
  return mergeContracts(groups.get(innermost)!, { logger: options.logger });
}

/** One route in the listing. */
export interface ListedRoute {
  /**
   * `METHOD /path` — `"ALL /path"` for an `all()` route (and for `any()`,
   * which may name several verbs). A GET route also answers HEAD; the listing
   * holds no second entry for it.
   */
  readonly key: string;
  /** The method as {@link key} carries it (`"GET"`, `"ALL"`). */
  readonly method: string;
  /** The path as written (`"/users/:id"`); `"*"` for a pathless `all()` handler. */
  readonly path: string;
  /** The path's parameter names, in order. */
  readonly params: string[];
  /**
   * The route's position in `router.routes()`. A consumer that needs more
   * than the listing carries (the terminal callback, for the `.describe()`
   * doc lookup) reads `router.routes()[routeIndex]` (AD (a)).
   */
  readonly routeIndex: number;
  /**
   * The route's effective contract, described (`describeContract` of
   * {@link effectiveContract}): each row carries the `origin` of the layer it
   * came from. `undefined` when no layer of the route carries one. A
   * channel's route (its `checks()` registered with `router.get`, as
   * `defineChannel` documents) lists its `websocket` contract here — the
   * `transport` field names it, and consumers filter on it.
   */
  readonly contract: ContractDescription | undefined;
  /**
   * The route record's `responseValidation`: the innermost router's setting
   * (a mounted router's over its parent's). A validator's own per-validator
   * setting wins over it at runtime and is not reflected here.
   */
  readonly responseValidation?: ResponseValidationMode;
  /** The route record's `responseOutput`, as {@link responseValidation}. */
  readonly responseOutput?: ResponseOutputMode;
  /**
   * `true` when no concrete request path could be synthesized for the route
   * (a regex-constrained or host-scoped path, or a pathless `all()` handler),
   * so the middleware before it could not be replayed and the contract is
   * built from the route's own callbacks alone.
   */
  readonly partial?: true;
}

/** What {@link listRoutes} takes. */
export interface ListRoutesOptions {
  /** Receives the contract merges' warnings. */
  readonly logger?: LoggerLike;
  /**
   * Names a layer (what its won rows record as `origin`), by its position in
   * the route's callback list. Default: the mount path the layer runs under
   * for middleware, the route's key (`"GET /users/:id"`) for its own
   * callbacks, `layer #i` where neither applies.
   */
  readonly origins?: (callback: unknown, index: number) => string;
}

/** The representative value a synthesized path fills a capture with. */
function captureValues(route: RouteRecord): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  (route.params ?? []).forEach((name, index) => {
    const kind = route.paramKinds?.[index];
    values[name] = kind === undefined || kind === CAPTURE_PARAM ? name : [name];
  });
  return values;
}

/**
 * A concrete path the route matches, for the replay that finds the middleware
 * running before it: each `:param` filled with its own name, wildcards with
 * one segment, optional segments filled or dropped by the route's own path
 * builder. `undefined` when no path can be synthesized: a regex constraint
 * (`/re/:id(\d+)` — nothing says which value matches), a host-scoped route
 * (its host pattern is part of the match), or a pathless `all()` handler.
 */
function synthesizePath(route: RouteRecord): string | undefined {
  if (route.host != null) return undefined;
  const path = route.path;
  if (path == null || path.includes("(")) return undefined;
  const compile = route.compilePathRegexpToPath;
  if (typeof compile !== "function") return undefined;
  try {
    const built = compile(captureValues(route));
    return typeof built === "string" && built.startsWith("/")
      ? built
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a replayed layer is an error handler (Express's arity rule): those carry no contract. */
function isErrorCallback(callback: unknown): boolean {
  return typeof callback === "function" && callback.length === 4;
}

/**
 * Lists a router's endpoints with the contract each runs under (bun-validate
 * V12). Read the root router (or the adapter): sub-router routes are already
 * flattened into its table, with the mounts' paths joined in. The listing is
 * a point-in-time read of the route table — register every route first.
 *
 * For each endpoint the listing synthesizes a concrete request path (params
 * filled with their names) and replays it through the router's own matching
 * (`getMatchedLayers`) to gather the middleware that runs before the route,
 * exactly as a request would meet it; those callbacks plus the route's own,
 * with the route record's `commonResponses`, feed {@link effectiveContract}.
 * When no path can be synthesized the entry is marked {@link ListedRoute.partial}
 * and its contract comes from the route's own callbacks alone.
 *
 * `use()` middleware and error handlers are never listed. A channel
 * (`defineChannel`) appears as `GET <path>` with its `websocket` contract
 * when its `checks()` are registered, as its docs direct
 * (`router.get(channel.path, channel.checks())` before `router.ws(...)`).
 *
 * @param router  The router (or adapter) to list.
 * @param options See {@link ListRoutesOptions}.
 */
export function listRoutes(
  router: BunRouter,
  options: ListRoutesOptions = {},
): ListedRoute[] {
  const routes = router.routes() as Route[] as RouteRecord[];
  const listed: ListedRoute[] = [];
  routes.forEach((route, routeIndex) => {
    if (!(route.isEndpoint ?? route.path != null)) return;
    const method = typeof route.method === "string" ? route.method : "ALL";
    const path = route.path ?? "*";
    const own = `${method} ${path}`;

    const synthesized = synthesizePath(route);
    let callbacks: unknown[] | undefined;
    let originNames: string[] | undefined;
    if (synthesized !== undefined) {
      const layers = router.getMatchedLayers({
        requestHost: "localhost",
        requestMethod: method === "ALL" ? "GET" : method,
        requestUrl: synthesized,
        requestPath: synthesized,
      });
      // The route's own layers occupy one contiguous span of the pipeline;
      // everything up to and including its last layer runs before it (or is
      // it). Layers past that belong to routes a request meets only after.
      let lastOwn = -1;
      layers.forEach((layer, index) => {
        if (layer.routeIndex === routeIndex) lastOwn = index;
      });
      if (lastOwn !== -1) {
        callbacks = [];
        originNames = [];
        for (let index = 0; index <= lastOwn; index++) {
          const layer = layers[index];
          if (layer.isErrorHandler) continue;
          callbacks.push(layer.callback);
          originNames.push(
            layer.routeIndex === routeIndex
              ? own
              : layer.baseUrl !== ""
                ? layer.baseUrl
                : `layer #${callbacks.length - 1}`,
          );
        }
      }
    }
    // The synthesized path must have matched the route itself; when it did
    // not (or none could be synthesized), fall back to the route's own
    // callbacks, marked partial.
    const partial = callbacks === undefined;
    const routeCallbacks: unknown[] = callbacks ?? [];
    const routeOriginNames: string[] = originNames ?? [];
    if (partial) {
      for (const callback of route.callbacks) {
        if (isErrorCallback(callback)) continue;
        routeCallbacks.push(callback);
        routeOriginNames.push(own);
      }
    }

    const byCallback = new Map<unknown, string>();
    routeCallbacks.forEach((callback, index) => {
      if (!byCallback.has(callback)) {
        byCallback.set(callback, routeOriginNames[index]);
      }
    });
    const contract = effectiveContract(routeCallbacks, {
      logger: options.logger,
      origins: (callback, index) =>
        options.origins?.(callback, index) ??
        byCallback.get(callback) ??
        defaultOrigin(callback, index),
      ...(route.commonResponses === undefined
        ? {}
        : { commonResponses: route.commonResponses }),
    });

    listed.push({
      key: own,
      method,
      path,
      params: route.params ?? [],
      routeIndex,
      contract: contract === undefined ? undefined : describeContract(contract),
      ...(route.responseValidation === undefined
        ? {}
        : { responseValidation: route.responseValidation }),
      ...(route.responseOutput === undefined
        ? {}
        : { responseOutput: route.responseOutput }),
      ...(partial ? { partial: true as const } : {}),
    });
  });
  return listed;
}

/** Where a request body goes in a document, from its described row (plan §4.12 m6). */
export interface BodyPlacement {
  /** The row's media type; `"application/json"` when the row declares none. */
  readonly mediaType: string;
  /**
   * Whether a client must send the body: `false` when the schema's input
   * accepts `undefined`.
   */
  readonly required: boolean;
}

/** JSON Schema keys that say nothing about which values are allowed. */
const ANNOTATION_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
]);

/**
 * Whether a JSON Schema document constrains the value at all. Absence is not
 * expressible in JSON Schema, so only an unconstrained document (`{}` modulo
 * annotations) decides "accepts `undefined`" here; anything else falls to the
 * schema itself.
 */
function constrainsValue(document: Record<string, unknown>): boolean {
  return Object.keys(document).some((key) => !ANNOTATION_KEYS.has(key));
}

/**
 * The placement of a request body row (plan §4.12 m6): its media type
 * (default `"application/json"`) and whether the body is required — `false`
 * when the schema's input accepts `undefined`.
 *
 * The rule, in order:
 *
 * 1. a `null` row (the body declared absent) is not required;
 * 2. a schema carrying `~standard.jsonSchema` whose **input** document
 *    constrains nothing (annotations aside) is not required — JSON Schema
 *    cannot express "may be undefined", so an unconstrained document is the
 *    only affirmative answer it can give, and a constrained one decides
 *    nothing;
 * 3. otherwise the schema itself is asked, once, with
 *    `~standard.validate(undefined)`: a synchronous pass means not required.
 *    A failure, a throw, or a Promise (an async vendor this synchronous
 *    helper cannot wait for) means required. A `documented()` schema never
 *    checks, so it answers from its document alone (step 2, and required
 *    when constrained).
 *
 * @param row A described request-body row (`ContractEntry` with `side:
 *   "inbound"`, `part: "body"`).
 */
export function bodyPlacement(row: ContractEntry): BodyPlacement {
  const mediaType = row.mediaType ?? "application/json";
  const schema = row.schema;
  if (schema === null) return { mediaType, required: false };
  const converter = jsonSchemaOf(schema);
  if (converter !== undefined) {
    let document: Record<string, unknown> | undefined;
    try {
      document = converter.input({ target: "draft-2020-12" });
    } catch {
      document = undefined;
    }
    if (document !== undefined && !constrainsValue(document)) {
      return { mediaType, required: false };
    }
    if (isDocumented(schema)) return { mediaType, required: true };
  }
  let verdict: unknown;
  try {
    verdict = schema["~standard"].validate(undefined);
  } catch {
    return { mediaType, required: true };
  }
  if (isPromiseLike(verdict)) return { mediaType, required: true };
  const failed = (verdict as { issues?: unknown }).issues !== undefined;
  return { mediaType, required: failed };
}

/**
 * What a client sees of one contract row's value on the wire (plan §4.12
 * M2/m3): a body's `Jsonify<WireInput<S>>` — the schema's input, field by
 * field, as JSON serializes it, so a `transform`'s source type is what
 * crosses (`{ n: z.string().transform((s) => s.length) }` sends `n` as a
 * `string`) — `null` for a part declared absent, and a `string` for every
 * path, query, header or cookie part.
 *
 * @typeParam E The row, narrowed to its `encoding` and `schema`.
 */
export type RowWireValue<E extends ContractEntry = ContractEntry> = E extends {
  encoding: "body";
}
  ? E["schema"] extends Schema
    ? Jsonify<WireInput<E["schema"]>>
    : null
  : string;
