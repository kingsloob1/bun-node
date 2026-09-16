import type { BunRequest } from "@kingsleyweb/bun-common";
import type { JobsDriver } from "../../drivers/index";
import type {
  JobsApiAction,
  JobsApiAuthorizeContext,
  JobsApiRouteInfo,
  ResolvedJobsApiConfig,
} from "../config";
import type { MetaDto } from "../serialize";
import type { AnyRouteDef, RouteMode } from "./define";
import { supportsWorkers } from "../../drivers/index";
import { decide } from "../auth";
import { JOBS_API_ACTIONS } from "../config";
import {
  MetaSchema,
  PermissionsQuerySchema,
  PermissionsSchema,
} from "../schemas/meta";
import { isWebSocketEnabled } from "../ws/channels";
import { defineRoute, joinPath } from "./define";

/** The API protocol version, reported by `/meta` and the socket's `hello`. */
export const JOBS_API_PROTOCOL_VERSION = 1 as const;

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

/**
 * What `/meta` reports. `routes`, the registered routes, decides which docs
 * are advertised; without it the configuration does.
 */
export function buildMeta(
  config: ResolvedJobsApiConfig,
  routes?: readonly JobsApiRouteInfo[],
): MetaDto {
  const { driver } = config;
  const publishing = (config.jobs as { publishesEvents?: unknown } | undefined)
    ?.publishesEvents;
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
    // `BunJobs` has no public getter for `publishEvents` yet (gap G3); until
    // it does, a client is told honestly that this is unknown.
    publishing: typeof publishing === "boolean" ? publishing : null,
    websocket:
      config.websocket !== false && isWebSocketEnabled(config)
        ? {
            path: joinPath(config.basePath, config.websocket.path),
            heartbeatMs: config.websocket.heartbeatMs,
            maxSubscriptions: config.websocket.maxSubscriptions,
          }
        : null,
    docs: docsOf(config, routes),
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
        body: buildMeta(services.config, services.routes()),
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
        "Asks `authorize` once for each distinct action among the routes this API registered (plus `events.connect` and `events.subscribe` when it has a socket), optionally for one queue or runner, so a client can hide what it may not do. The cost is that many `authorize` calls per request.",
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
        },
      }),
    }),
  ];
}
