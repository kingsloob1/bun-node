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
import { decide, denialError } from "../auth";
import { JOBS_API_ACTIONS } from "../config";
import { JOBS_API_PROTOCOL_VERSION } from "../contract/constants";
import { RETRY_ALL_MAX_IDS } from "../schemas/jobs";
import {
  MetaSchema,
  PermissionsQuerySchema,
  PermissionsSchema,
} from "../schemas/meta";
import { defaultCleanLimit } from "../schemas/queues";
import { isWebSocketEnabled, parseChannel } from "../ws/channels";
import { defineRoute, joinPath } from "./define";

/** The API protocol version, reported by `/meta` and the socket's `hello`. Defined in the contract. */
export { JOBS_API_PROTOCOL_VERSION } from "../contract/constants";

/**
 * The driver methods behind each optional feature. A feature is on when the
 * driver implements every one — the same probe `BunQueue` makes before using
 * an optional method. The last three arrive with the 2.13 read APIs.
 */
export const DRIVER_FEATURES = {
  logs: ["getJobLogs"],
  update: ["updateJob"],
  limits: ["getQueueState", "setQueueState"],
  flows: ["recordChild"],
  search: ["findJobs"],
  workers: ["listWorkers"],
  throughput: ["getThroughput"],
} as const satisfies Record<keyof MetaDto["features"], readonly string[]>;

/** Whether a driver implements every named method. */
export function driverImplements(
  driver: JobsDriver,
  methods: readonly string[],
): boolean {
  const record = driver as unknown as Record<string, unknown>;
  return methods.every((method) => typeof record[method] === "function");
}

/** The optional features a driver supports. */
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
  };
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
      capabilities: { ...driver.capabilities },
    },
    features: probeFeatures(driver),
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

/**
 * Evaluates `authorize` once for each of `actions` — by default every action
 * relevant to the API's mode; the `/meta/permissions` route passes
 * {@link permissionActions}, so the cost is one call per distinct action among
 * the registered routes (plus two with a socket). An action disabled by
 * configuration is `false` without asking `authorize`: `decide` applies the
 * static limits first. `queue` is passed to queue-side actions and `runner` to
 * runner actions.
 */
export async function evaluatePermissions(
  config: ResolvedJobsApiConfig,
  req: BunRequest,
  target: { queue?: string; runner?: string },
  actions?: readonly JobsApiAction[],
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
      const context: Omit<JobsApiAuthorizeContext, "mutation"> = {
        action,
        transport: "http",
        ...(mode === "jobs" && target.queue ? { queue: target.queue } : {}),
        ...(mode === "runner" && target.runner
          ? { runner: target.runner }
          : {}),
      };
      return [action, (await decide(config, req, context)).allow] as const;
    }),
  );
  return Object.fromEntries(answers);
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
      handler: ({ services }) => ({
        body: buildMeta(services.config, services.routes(), {
          port: services.socketPort?.(),
        }),
      }),
    }),
    defineRoute({
      method: "GET",
      path: "/meta/permissions",
      operationId: "getPermissions",
      action: "meta.read",
      mode: "any",
      summary: "Which actions the caller may perform",
      description:
        "Asks `authorize` once for each distinct action among the routes this API registered (plus `events.connect` and `events.subscribe` when it has a socket), optionally for one queue or runner, so a client can hide what it may not do. The cost is that many `authorize` calls per request. With `channel`, also previews a WebSocket subscription: the channel is parsed and checked as a `subscribe` frame's would be, and `authorize` is asked once more, about `events.subscribe` on that channel.",
      tags: ["Meta"],
      query: PermissionsQuerySchema,
      responses: { 200: PermissionsSchema },
      handler: async ({ req, query, services }) => ({
        body: {
          actions: (await evaluatePermissions(
            services.config,
            req,
            query,
            permissionActions(services.config, services.routes()),
          )) as Record<string, boolean>,
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
