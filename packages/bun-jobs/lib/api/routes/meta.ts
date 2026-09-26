import type { BunRequest } from "@kingsleyweb/bun-common";
import type { JobsDriver } from "../../drivers/index";
import type {
  JobsApiAction,
  JobsApiAuthorizeContext,
  JobsApiRouteInfo,
  ResolvedJobsApiConfig,
} from "../config";
import type {
  ChannelPermissionDto,
  MetaCsrfDto,
  MetaLimitsDto,
} from "../contract/types";
import type { MetaDto } from "../serialize";
import type { AnyRouteDef, RouteMode } from "./define";
import { supportsWorkers } from "../../drivers/index";
import { supportsWorkerControl } from "../../queue/workerControl";
import { decide, denialError } from "../auth";
import { JOBS_API_ACTIONS } from "../config";
import { JOBS_API_PROTOCOL_VERSION } from "../contract/constants";
import { builtInRoutes } from "../createJobsApi";
import { RETRY_ALL_MAX_IDS } from "../schemas/jobs";
import {
  MetaSchema,
  PermissionsQuerySchema,
  PermissionsSchema,
} from "../schemas/meta";
import { defaultCleanLimit } from "../schemas/queues";
import { isWebSocketEnabled, parseChannel } from "../ws/channels";
import { analyticsMetaOf } from "./analytics";
import { defineRoute, isRouteEnabled, joinPath } from "./define";

/** The API protocol version, reported by `/meta` and the socket's `hello`. Defined in the contract. */
export { JOBS_API_PROTOCOL_VERSION } from "../contract/constants";

/**
 * The driver methods every analytics route needs: what a range is resolved
 * against, and the jobs series. `/meta.analytics` is non-`null` exactly when
 * a driver implements all three, and every analytics route requires them —
 * so `analytics: null` means every analytics route is pruned.
 *
 * Defined here rather than beside the analytics routes (which re-export it)
 * because {@link DRIVER_FEATURES} is built from it when this module loads,
 * and the analytics module imports this one: defined there, whichever of the
 * two loaded second would read it before it existed.
 */
export const ANALYTICS_METHODS = [
  "getMetricsSupport",
  "getNamespaceMetrics",
  "getQueueMetrics",
] as const;

/**
 * The driver methods behind each optional feature. A feature is on when the
 * driver implements every one — the same probe `BunQueue` makes before using
 * an optional method. The last three arrive with the 2.13 read APIs.
 *
 * Where a feature describes routes, its list is what those routes `require`,
 * and the routes name this list rather than a copy, so the flag and the
 * pruning cannot disagree.
 */
export const DRIVER_FEATURES = {
  logs: ["getJobLogs"],
  update: ["updateJob"],
  limits: ["getQueueState", "setQueueState"],
  flows: ["recordChild"],
  search: ["findJobs"],
  workers: ["listWorkers"],
  workerControl: ["getQueueState", "setQueueState", "listQueueState"],
  throughput: ["getThroughput"],
  // Both, deliberately: a driver that can read a log it can never write has
  // nothing to serve, and the flag says logs exist to be read, not that a
  // method does.
  runnerLogs: ["appendRunLog", "getRunLog"],
  // The same rule for the two analytics flags: a series that can be read but
  // never written is an empty chart, so each names its write and its read.
  // Each also needs `ANALYTICS_METHODS`, because every analytics route does:
  // without them the runner and worker routes are pruned, and a flag reading
  // `true` would advertise a route that is not there. These two lists are
  // exactly what those routes require. All five built-in drivers implement
  // every method named; a custom driver may implement none, some or all.
  runnerMetrics: [...ANALYTICS_METHODS, "countRunnerRun", "getRunnerMetrics"],
  workerMetrics: [...ANALYTICS_METHODS, "countWorkerJobs", "getWorkerMetrics"],
  // A capability, not a method: `findJobs` already exists on drivers that
  // record nothing, so no method list can say whether `processedBy` is
  // written. `probeFeatures` reads `capabilities.jobAttribution` instead
  // (`supportsJobAttribution`), and this empty list only keeps the map total.
  jobAttribution: [],
  // Reads by creation time: the per-state counts of the jobs added in a range,
  // and `sort=createdAt` on the job list. A driver implements the count only
  // where an index or memory bounds it, never by reading every job record —
  // the Redis and file drivers do not — and the same backends are the ones
  // whose `findJobs` can order by `createdAt`, so the one method stands for
  // both. The memory, SQL and MongoDB drivers implement it.
  addedByState: ["countAddedJobs"],
  // A queue's stored override lives in queue state, beside limits and worker
  // config, so these are exactly limits' methods. Every built-in driver has
  // them; `readJobDefaults` answers "no override" on a driver without.
  jobDefaults: ["getQueueState", "setQueueState"],
  // Applying it needs the override (queue state) and the batched rewrite. All
  // five built-in drivers implement `rewritePendingOptions`; a custom driver
  // without it keeps saving defaults and loses only the apply route.
  jobDefaultsApply: ["getQueueState", "setQueueState", "rewritePendingOptions"],
  // The demand routes, like every other flag: whether they are served. They
  // need no driver method — without `countDemand`, `readDemand` falls back to
  // reads every driver has — so the list is empty and the flag is false only
  // where the API's mode prunes the routes (`runner`). Whether one answer's
  // figures are exact is that answer's `exact`, never this flag.
  demand: [],
} as const satisfies Record<keyof MetaDto["features"], readonly string[]>;

/**
 * Whether a driver declares the job-attribution capability: it stamps
 * `processedBy` in the claim's own write, keeps it through every settle, and
 * its `findJobs` honours the worker and `finishedOn` filters
 * (`DriverCapabilities.jobAttribution`). Only `true` counts. Every built-in
 * driver declares it; a custom driver that does not reads `false`, and the
 * job list then serves the four filters by scanning.
 */
export function supportsJobAttribution(driver: JobsDriver): boolean {
  return driver.capabilities.jobAttribution === true;
}

/** Whether a driver implements every named method. */
export function driverImplements(
  driver: JobsDriver,
  methods: readonly string[],
): boolean {
  const record = driver as unknown as Record<string, unknown>;
  return methods.every((method) => typeof record[method] === "function");
}

/**
 * The optional features a driver supports, whatever the API around it
 * serves. `/meta` reports {@link servedFeatures}, which narrows this to the
 * routes actually served.
 */
export function probeFeatures(driver: JobsDriver): MetaDto["features"] {
  return {
    ...(Object.fromEntries(
      Object.entries(DRIVER_FEATURES).map(([feature, methods]) => [
        feature,
        driverImplements(driver, methods),
      ]),
    ) as MetaDto["features"]),
    // Worker records need *either* the three native methods or queue state, so
    // no single method list describes them: `DRIVER_FEATURES.workers` names
    // only the native path. Ask the same predicate the queue asks before it
    // lists, or every driver that keeps workers in queue state — the memory
    // and file drivers among them — would be reported as having no workers
    // while `/workers` happily answered.
    workers: supportsWorkers(driver),
    // Control needs both: a registry to address a worker in, and queue state
    // to record what it should be. `DRIVER_FEATURES` names only the second.
    workerControl: supportsWorkers(driver) && supportsWorkerControl(driver),
    // Worker analytics needs the registry too, and for the same kind of
    // reason: the series are keyed by the worker's stable key and the rows
    // are the worker listing, so counters without records serve no route.
    // `DRIVER_FEATURES.workerMetrics` names only the driver methods.
    workerMetrics:
      supportsWorkers(driver) &&
      driverImplements(driver, DRIVER_FEATURES.workerMetrics),
    // Attribution is a promise about what the claim writes and what
    // `findJobs` filters on, which no method's presence can show — so the
    // driver says so itself. `DRIVER_FEATURES.jobAttribution` is empty.
    jobAttribution: supportsJobAttribution(driver),
  };
}

/**
 * The routes each feature flag describes, by operation id. A flag is on only
 * when the backend supports the feature ({@link probeFeatures}) **and** every
 * route named here is served by this API — the same pruning predicate the
 * router applies, so a flag cannot advertise a route that answers 404. A
 * route that needs more than the flag's driver methods (none today) would
 * turn the flag off with it; one that needs less (the run-log read, which
 * needs only `getRunLog`) leaves the flag to the methods.
 *
 * `search` has no route of its own: it is `?search=` on the job list. Nor has
 * `jobAttribution`: it is `processedBy` on every job and four filters on the
 * same list.
 */
export const FEATURE_ROUTES = {
  logs: ["getJobLogs"],
  update: ["updateJob"],
  limits: ["getQueueLimits", "setQueueLimits"],
  flows: ["getJobChildren"],
  search: ["listJobs"],
  workers: ["listQueueWorkers", "listWorkers", "getWorker"],
  workerControl: [
    "pauseWorker",
    "resumeWorker",
    "stopWorker",
    "startWorker",
    "listWorkerConfigs",
    "configureWorker",
    "resetWorkerConfig",
  ],
  throughput: ["getQueueThroughput"],
  runnerLogs: ["getRunLogs"],
  runnerMetrics: ["getRunnersAnalytics", "getRunnerAnalytics"],
  workerMetrics: ["getWorkersAnalytics", "getWorkerAnalytics"],
  // Like `search`, no route of its own: `processedBy` rides every job read and
  // the filters are on the job list, so the list is what must be served.
  jobAttribution: ["listJobs"],
  // The two count routes, and the job list that `sort=createdAt` rides. The
  // count routes `require` `DRIVER_FEATURES.addedByState`, so they are pruned
  // exactly where the flag's driver half is false, and in `runner` mode.
  addedByState: ["getAddedByState", "getQueueAddedByState", "listJobs"],
  // Reading, saving and resetting; each `requires` `DRIVER_FEATURES.jobDefaults`.
  jobDefaults: ["getJobDefaults", "setJobDefaults", "resetJobDefaults"],
  // The rewrite, which `requires` `DRIVER_FEATURES.jobDefaultsApply`.
  jobDefaultsApply: ["applyJobDefaults"],
  // The depth endpoint, one queue and the namespace. Neither is pruned for
  // the driver, so only the API's mode turns the flag off, through these.
  demand: ["getQueueDemand", "listQueueDemand"],
} as const satisfies Record<keyof MetaDto["features"], readonly string[]>;

/**
 * Which features have every route {@link FEATURE_ROUTES} names served, once
 * per resolved configuration: the routes do not change after construction.
 * Support is not cached with it — see {@link servedFeatures}.
 */
const routedCache = new WeakMap<
  ResolvedJobsApiConfig,
  Record<keyof MetaDto["features"], boolean>
>();

/**
 * The features this API serves, as `/meta.features` reports them: what the
 * backend supports ({@link probeFeatures}), narrowed to the features whose
 * routes ({@link FEATURE_ROUTES}) this API registers — the API's `mode`, a
 * `jobs` source where a route needs one, and each route's own condition, by
 * the router's own predicate (`isRouteEnabled`).
 *
 * `readOnly` and `actions` are deliberately left out. They are permissions,
 * which `/meta.readOnly` and `/meta/permissions` already answer; a flag says
 * whether the thing exists here, so a UI can tell "this backend cannot" from
 * "you may not".
 */
export function servedFeatures(
  config: ResolvedJobsApiConfig,
): MetaDto["features"] {
  let routed = routedCache.get(config);
  if (!routed) {
    const permitted: ResolvedJobsApiConfig = {
      ...config,
      readOnly: false,
      enabledActions: new Set(JOBS_API_ACTIONS),
    };
    const served = new Set(
      builtInRoutes(config)
        .filter((def) => isRouteEnabled(def, permitted))
        .map((def) => def.operationId),
    );
    routed = Object.fromEntries(
      Object.entries(FEATURE_ROUTES).map(([feature, ids]) => [
        feature,
        ids.every((id) => served.has(id)),
      ]),
    ) as Record<keyof MetaDto["features"], boolean>;
    routedCache.set(config, routed);
  }
  // Probed on every call: support can change under a running API. The SQL
  // driver's `jobAttribution` turns on when a sync adds the stamp's columns,
  // and a cached `false` would hide that until a restart.
  const probed = probeFeatures(config.driver);
  return Object.fromEntries(
    Object.entries(probed).map(([feature, supported]) => [
      feature,
      supported && routed[feature as keyof MetaDto["features"]],
    ]),
  ) as MetaDto["features"];
}

/** Which half of the API an action belongs to. */
export function actionMode(action: JobsApiAction): RouteMode {
  if (action.startsWith("runners.")) {
    return "runner";
  }
  if (
    action.startsWith("meta.") ||
    action.startsWith("docs.") ||
    action.startsWith("events.")
  ) {
    return "any";
  }
  return "jobs";
}

/**
 * The docs `/meta` reports: from the registered docs routes when `routes` is
 * given — so a pruned docs route is never advertised — else from the
 * configuration.
 */
function docsOf(
  config: ResolvedJobsApiConfig,
  routes: readonly JobsApiRouteInfo[] | undefined,
): MetaDto["docs"] {
  if (!routes) {
    return config.docs !== false && config.enabledActions.has("docs.read")
      ? {
          openapi: joinPath(config.basePath, config.docs.openapiPath),
          ...(isWebSocketEnabled(config)
            ? { asyncapi: joinPath(config.basePath, config.docs.asyncapiPath) }
            : {}),
        }
      : null;
  }
  const openapi = routes.find(
    (route) => route.operationId === "getOpenApiDocument",
  );
  if (!openapi) {
    return null;
  }
  const asyncapi = routes.find(
    (route) => route.operationId === "getAsyncApiDocument",
  );
  const ui = routes.find((route) => route.operationId === "getDocsUi");
  const asyncapiUi = routes.find(
    (route) => route.operationId === "getAsyncApiUi",
  );
  return {
    openapi: openapi.path,
    ...(asyncapi ? { asyncapi: asyncapi.path } : {}),
    ...(ui ? { ui: ui.path } : {}),
    ...(asyncapiUi ? { asyncapiUi: asyncapiUi.path } : {}),
  };
}

/** The CSRF rules as `/meta` and `api.info` report them. */
export function csrfOf(
  config: Pick<ResolvedJobsApiConfig, "csrf">,
): MetaCsrfDto {
  return config.csrf === false
    ? { header: null, requireJson: false }
    : {
        header: config.csrf.header === false ? null : config.csrf.header,
        requireJson: config.csrf.requireJson,
      };
}

/**
 * The caps `/meta` reports: read from `config.limits`, the very object the
 * routes read theirs from, or from the constant or expression the route's
 * schema uses, so the two cannot disagree.
 */
export function limitsOf(
  config: Pick<ResolvedJobsApiConfig, "limits">,
): MetaLimitsDto {
  const { limits } = config;
  return {
    defaultPageSize: limits.defaultPageSize,
    maxPageSize: limits.maxPageSize,
    maxBulkIds: limits.maxBulkIds,
    maxRetryAll: limits.maxRetryAll,
    maxRetryAllIds: RETRY_ALL_MAX_IDS,
    maxClean: limits.maxClean,
    defaultClean: defaultCleanLimit(limits.maxClean),
    maxLogPage: limits.maxLogPage,
    maxHistory: limits.maxHistory,
    maxJobDataBytes: limits.maxJobDataBytes,
    maxQueues: limits.maxQueues,
    maxApplyDefaults: limits.maxApplyDefaults,
  };
}

/**
 * Whether an operation is routed: from the registered routes when given,
 * else from the static limits and the mode (what pruning would decide
 * before driver capabilities).
 */
function isRouted(
  config: ResolvedJobsApiConfig,
  routes: readonly JobsApiRouteInfo[] | undefined,
  operationId: string,
  action: JobsApiAction,
): boolean {
  if (routes) {
    return routes.some((route) => route.operationId === operationId);
  }
  const mode = actionMode(action);
  return (
    config.enabledActions.has(action) &&
    (mode === "any" || config.mode === "both" || config.mode === mode)
  );
}

/**
 * The names `POST /queues/:queue/jobs` accepts right now: `null` for any
 * name, `[]` when the route is not registered, else the configured list or —
 * by default — the names of `jobs.definitions()`, read now, exactly as the
 * route reads them (`isAddableName`).
 */
export function addableNamesOf(
  config: ResolvedJobsApiConfig,
  routes?: readonly JobsApiRouteInfo[],
): string[] | null {
  if (!isRouted(config, routes, "addJob", "jobs.add")) {
    return [];
  }
  if (config.addableNames === "any") {
    return null;
  }
  const names =
    config.addableNames === "defined"
      ? (config.jobs?.definitions() ?? []).map((definition) => definition.name)
      : config.addableNames;
  return [...new Set(names)];
}

/**
 * What `/meta` reports. `routes`, the registered routes, decides which docs
 * are advertised and whether adding and triggering are routed; without it the
 * configuration does. `socket` gives the dedicated port the socket bound.
 */
export function buildMeta(
  config: ResolvedJobsApiConfig,
  routes?: readonly JobsApiRouteInfo[],
  socket?: { readonly port: number | undefined },
): MetaDto {
  const { driver } = config;
  const port = socket?.port;
  return {
    namespace: config.namespace,
    mode: config.mode,
    readOnly: config.readOnly,
    protocol: JOBS_API_PROTOCOL_VERSION,
    driver: {
      name: driver.name,
      // Picked, never spread: the schema admits no key it does not name, so
      // a driver declaring a capability this version does not know (a newer
      // or custom one) would otherwise fail `/meta`'s response validation.
      capabilities: {
        blockingWait: driver.capabilities.blockingWait,
        events: driver.capabilities.events,
        multiProcess: driver.capabilities.multiProcess,
        multiHost: driver.capabilities.multiHost,
        jobAttribution: supportsJobAttribution(driver),
      },
    },
    // What this API serves, not only what the driver can do: a feature whose
    // routes the mode prunes reads `false`.
    features: servedFeatures(config),
    events: driver.capabilities.events,
    // The context's resolved `publishEvents`. Without a `BunJobs` there is
    // nothing to ask, so a client is told honestly that it is unknown.
    publishing: config.jobs ? config.jobs.publishesEvents : null,
    websocket:
      config.websocket !== false && isWebSocketEnabled(config)
        ? {
            path: joinPath(config.basePath, config.websocket.path),
            heartbeatMs: config.websocket.heartbeatMs,
            maxSubscriptions: config.websocket.maxSubscriptions,
            ...(port === undefined ? {} : { port }),
          }
        : null,
    docs: docsOf(config, routes),
    csrf: csrfOf(config),
    limits: limitsOf(config),
    // From the driver's own `getMetricsSupport()`, so a client sizes its
    // picker from what this backend keeps. `null` exactly when every
    // analytics route is pruned.
    analytics: analyticsMetaOf(driver),
    addableNames: addableNamesOf(config, routes),
    runnerTriggerArgs:
      config.runnerTriggerArgs &&
      isRouted(config, routes, "triggerRunner", "runners.trigger"),
  };
}

/**
 * Whether subscribing to `channel` would be authorized: the socket's own
 * checks, in the socket's own order — {@link parseChannel} (syntax,
 * availability, a configured queue or runner list), then `authorize` for
 * `events.subscribe` with the channel's target, as a `subscribe` frame asks
 * it. Read-only: nothing is subscribed.
 */
export async function previewChannel(
  config: ResolvedJobsApiConfig,
  req: BunRequest,
  channel: string,
): Promise<ChannelPermissionDto> {
  const parsed = parseChannel(channel, config);
  if (!parsed.ok) {
    return {
      channel,
      // Present whenever the name parsed, refused afterwards or not.
      ...(parsed.key === undefined ? {} : { key: parsed.key }),
      allowed: false,
      code: parsed.rejection.code,
      status: parsed.rejection.status,
      detail: parsed.rejection.detail,
    };
  }
  const key = parsed.channel.key;
  const decision = await decide(config, req, {
    action: "events.subscribe",
    transport: "ws",
    ...parsed.channel.target,
  });
  if (decision.allow) {
    return { channel, key, allowed: true };
  }
  const error = denialError(decision);
  return {
    channel,
    key,
    allowed: false,
    code: error.code,
    status: error.status,
    detail: error.message,
  };
}

/**
 * The actions `/meta/permissions` reports: those of the routes actually
 * registered — so the pruning predicate (mode, `readOnly`, `actions`, driver
 * capabilities, docs) is applied once, where routes are built — plus the two
 * socket actions when the API has a socket.
 */
export function permissionActions(
  config: ResolvedJobsApiConfig,
  routes: readonly JobsApiRouteInfo[],
): JobsApiAction[] {
  const actions = new Set<JobsApiAction>(routes.map((route) => route.action));
  if (isWebSocketEnabled(config)) {
    for (const action of ["events.connect", "events.subscribe"] as const) {
      if (config.enabledActions.has(action)) {
        actions.add(action);
      }
    }
  }
  return [...actions];
}

/** Whether a route pattern names a path parameter, e.g. `":queue"`. */
function namesParam(path: string, param: ":queue" | ":runner"): boolean {
  return path.split("/").includes(param);
}

/**
 * The route a real request for `action` would carry as `ctx.route`, for the
 * `/meta/permissions` preview: the method and the pattern under `basePath`,
 * exactly as the route's own `authorize` call reports them (`registerRoutes`).
 * `undefined` for an action no registered route carries — the socket's two
 * actions, whose real calls carry no route either.
 *
 * Where several routes share an action, the choice is deterministic, in
 * registration order (the order of `api.routes`):
 *
 * - asked about a queue (a queue-side action) or a runner (a runner action):
 *   the first route whose pattern names `:queue` (or `:runner`) —
 *   `metrics.read` for a queue is `GET /queues/:queue/throughput`;
 * - asked about neither: the first route whose pattern names neither —
 *   `metrics.read` is `GET /overview`, `workers.list` is `GET /workers`;
 * - no route matches that preference: the action's first route, e.g.
 *   `jobs.read` untargeted is `POST /queues/:queue/jobs/lookup` (a read).
 */
export function previewRoute(
  config: Pick<ResolvedJobsApiConfig, "basePath">,
  routes: readonly JobsApiRouteInfo[],
  action: JobsApiAction,
  target: { queue?: string; runner?: string },
): JobsApiAuthorizeContext["route"] {
  const candidates = routes.filter((route) => route.action === action);
  if (candidates.length === 0) {
    return undefined;
  }
  const mode = actionMode(action);
  const param =
    mode === "jobs" && target.queue !== undefined
      ? ":queue"
      : mode === "runner" && target.runner !== undefined
        ? ":runner"
        : undefined;
  const preferred = param
    ? candidates.find((route) => namesParam(route.path, param))
    : candidates.find(
        (route) =>
          !namesParam(route.path, ":queue") &&
          !namesParam(route.path, ":runner"),
      );
  const chosen = preferred ?? candidates[0]!;
  return {
    method: chosen.method,
    // `api.routes` holds full paths; `ctx.route.path` is the pattern under
    // `basePath`, which `joinPath` prefixed by plain concatenation.
    path: chosen.path.slice(config.basePath.length),
  };
}

/**
 * Evaluates `authorize` once for each of `actions` — by default every action
 * relevant to the API's mode; the `/meta/permissions` route passes
 * {@link permissionActions}, so the cost is one call per distinct action among
 * the registered routes (plus two with a socket). An action disabled by
 * configuration is `false` without asking `authorize`: `decide` applies the
 * static limits first. `queue` is passed to queue-side actions and `runner` to
 * runner actions.
 *
 * Each call is shaped like the real request it previews, so an `authorize`
 * that decides by any field of the context gives the map the answer the
 * request would get:
 *
 * - an HTTP action carries `transport: "http"` and, when `routes` (the
 *   registered routes, `api.routes`) is given, `route` as
 *   {@link previewRoute} picks it. Without `routes` there is no `route`;
 * - `events.connect` and `events.subscribe` carry `transport: "ws"` and no
 *   `route`, as the upgrade and a `subscribe` frame do.
 *
 * What no preview can carry is a job: `jobId` and `jobIds` are never set.
 */
export async function evaluatePermissions(
  config: ResolvedJobsApiConfig,
  req: BunRequest,
  target: { queue?: string; runner?: string },
  actions?: readonly JobsApiAction[],
  routes?: readonly JobsApiRouteInfo[],
): Promise<Partial<Record<JobsApiAction, boolean>>> {
  const relevant =
    actions ??
    JOBS_API_ACTIONS.filter((action) => {
      const mode = actionMode(action);
      return mode === "any" || config.mode === "both" || config.mode === mode;
    });

  const answers = await Promise.all(
    relevant.map(async (action) => {
      const mode = actionMode(action);
      const socket = action.startsWith("events.");
      const route =
        socket || !routes
          ? undefined
          : previewRoute(config, routes, action, target);
      const context: Omit<JobsApiAuthorizeContext, "mutation"> = {
        action,
        transport: socket ? "ws" : "http",
        ...(mode === "jobs" && target.queue ? { queue: target.queue } : {}),
        ...(mode === "runner" && target.runner
          ? { runner: target.runner }
          : {}),
        ...(route ? { route } : {}),
      };
      return [action, (await decide(config, req, context)).allow] as const;
    }),
  );
  return Object.fromEntries(answers) as Partial<Record<JobsApiAction, boolean>>;
}

/** `/meta` and `/meta/permissions`, routed in every mode. */
export function metaRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: "GET",
      path: "/meta",
      operationId: "getMeta",
      action: "meta.read",
      mode: "any",
      summary: "What this API exposes and what its backend supports",
      tags: ["Meta"],
      responses: { 200: MetaSchema },
      // Connected first: a driver's capabilities can depend on what connecting
      // finds. The SQL driver's `jobAttribution` reads `false` until connect
      // has confirmed the stamp's columns, so an API process nothing else had
      // connected yet would report the feature missing, and a client caching
      // `/meta` would hide the worker filters for no reason. Every built-in
      // driver's `connect()` is shared or a no-op after the first call. A
      // failure is mapped like any other route's (a `DriverError` is a 503,
      // anything unrecognised a bare 500), so no internals reach the body.
      handler: async ({ services }) => {
        await services.config.driver.connect();
        return {
          body: buildMeta(services.config, services.routes(), {
            port: services.socketPort?.(),
          }),
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/meta/permissions",
      operationId: "getPermissions",
      action: "meta.read",
      mode: "any",
      summary: "Which actions the caller may perform",
      description:
        "Answers, for each distinct action among the routes this API registered (plus `events.connect` and `events.subscribe` when it has a socket), whether the caller may perform it, optionally for one queue or runner, so a client can hide what it may not do. An action whose routes are pruned is absent, not `false`.\n\n" +
        "**Cost.** `authorize` is called N + 1 times per request, where N is the number of actions in `actions`: once for this request itself (`meta.read` on `GET /meta/permissions`, like any route), then once per action. The request's own call is not reused for the map's `meta.read`: that entry previews `GET /meta`, a different route. With `channel`, add one more call when the channel parses and is available (a refused channel costs none).\n\n" +
        '**Each call is shaped like the real request.** An HTTP action carries `transport: "http"` and `route`: the method and pattern of one of the action\'s routes, the first registered whose pattern names the queue or runner asked about (or, with neither, names neither; else the action\'s first route). `events.connect` and `events.subscribe` carry `transport: "ws"` and no `route`, as the upgrade and a `subscribe` frame do. No call names a job. With `channel`, the channel is parsed and checked as a `subscribe` frame\'s would be, and `authorize` is asked about `events.subscribe` on it with exactly the context that frame would carry.',
      tags: ["Meta"],
      query: PermissionsQuerySchema,
      responses: { 200: PermissionsSchema },
      handler: async ({ req, query, services }) => ({
        body: {
          actions: await evaluatePermissions(
            services.config,
            req,
            query,
            permissionActions(services.config, services.routes()),
            services.routes(),
          ),
          ...(query.channel === undefined
            ? {}
            : {
                channel: await previewChannel(
                  services.config,
                  req,
                  query.channel,
                ),
              }),
        },
      }),
    }),
  ];
}
