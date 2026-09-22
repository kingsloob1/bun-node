import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  AsyncApiDocument,
  JobsApi,
  JobsApiConfig,
  JobsApiRouteInfo,
  JobsApiWebSocket,
  OpenApiDocument,
  ResolvedJobsApiConfig,
} from "./config";
import type { JobsApiInfo } from "./contract/types";
import type { AnyRouteDef, RouteServices } from "./routes/define";
import type { SourceOptions } from "./sources";
import type { JobsApiWebSocketInternalOptions } from "./ws/attach";
import { BunRouter, cors } from "@kingsleyweb/bun-common";
import { resolveConfig } from "./config";
import { createApiErrorHandler, createNotFoundHandler } from "./errors";
import { analyticsRoutes } from "./routes/analytics";
import { isRouteEnabled, registerRoutes } from "./routes/define";
import { docsRoutes } from "./routes/docs";
import { jobRoutes } from "./routes/jobs";
import { buildMeta, csrfOf, metaRoutes } from "./routes/meta";
import { queueRoutes } from "./routes/queues";
import { repeatableRoutes } from "./routes/repeatables";
import { runnerRoutes } from "./routes/runners";
import { workerRoutes } from "./routes/workers";
import { QueueSource, RunnerSource } from "./sources";
import {
  asyncApiForRequest,
  generateAsyncApi,
  registerAsyncApiSource,
} from "./spec/asyncapi";
import { generateOpenApi } from "./spec/openapi";
import { createJobsApiWebSocket, upgradePassthrough } from "./ws/attach";
import { isWebSocketEnabled } from "./ws/channels";

/** Every route the API knows, before pruning. */
export function builtInRoutes(config: ResolvedJobsApiConfig): AnyRouteDef[] {
  return [
    ...metaRoutes(),
    ...docsRoutes(config),
    ...queueRoutes(config),
    ...workerRoutes(),
    ...jobRoutes(config),
    ...repeatableRoutes(),
    ...runnerRoutes(config),
    // Last, so each shared action's preview route stays what it was:
    // `metrics.read` previews as `GET /overview` and, for a queue,
    // `GET /queues/:queue/throughput`.
    ...analyticsRoutes(),
  ];
}

/**
 * What `api.info` reports: the resolved configuration, and the documents and
 * socket actually registered — the docs paths from `/meta`'s own reading of
 * the routes, the socket's path and bound port from the socket itself.
 */
function apiInfo(
  config: ResolvedJobsApiConfig,
  routes: readonly JobsApiRouteInfo[],
  socket: JobsApiWebSocket | undefined,
): JobsApiInfo {
  const meta = buildMeta(config, routes, socket);
  const websocket = socket
    ? Object.freeze({
        path: socket.path,
        ...(socket.port === undefined ? {} : { port: socket.port }),
      })
    : null;
  return Object.freeze({
    basePath: config.basePath,
    namespace: config.namespace,
    mode: config.mode,
    readOnly: config.readOnly,
    csrf: Object.freeze(csrfOf(config)),
    docs: meta.docs
      ? Object.freeze({
          openapi: meta.docs.openapi,
          ...(meta.docs.asyncapi === undefined
            ? {}
            : { asyncapi: meta.docs.asyncapi }),
        })
      : null,
    websocket,
  });
}

/**
 * Assembles an API from a resolved configuration and a route list: prunes the
 * routes, generates the document (so a spec problem fails here, not on the
 * first docs request), and builds the router in this order —
 * CORS, `middleware`, the routes, the JSON 404, the error handler.
 *
 * `createJobsApi` is this with the built-in routes; tests use it directly to
 * exercise the registrar with routes of their own.
 */
export function buildJobsApi(
  config: ResolvedJobsApiConfig,
  defs: readonly AnyRouteDef[],
  options?: SourceOptions & JobsApiWebSocketInternalOptions,
): JobsApi {
  const enabled = defs.filter((def) => isRouteEnabled(def, config));
  const document = generateOpenApi(enabled, config);

  // The socket, when the configuration has one. A dedicated port is bound
  // here, so a failure generating its document must release it.
  const socket = isWebSocketEnabled(config)
    ? createJobsApiWebSocket(config, options)
    : undefined;
  let asyncDocument: AsyncApiDocument | undefined;
  if (socket) {
    const info = {
      path: socket.websocket.path,
      get port() {
        return socket.websocket.port;
      },
    };
    try {
      asyncDocument = generateAsyncApi(config, info);
    } catch (error) {
      void socket.close();
      throw error;
    }
    const built = asyncDocument!;
    const asyncApiSource = (req: BunRequest): AsyncApiDocument =>
      asyncApiForRequest(built, req, info);
    registerAsyncApiSource(config, asyncApiSource);
    // Only when the context says it does not publish: with `publishEvents`
    // set, the live events carry what its producers publish.
    if (config.jobs && !config.jobs.publishesEvents) {
      config.logger.warn(
        "jobs api live events only carry what producers publish: set publishEvents on BunJobs (or publish on each queue, worker and runner) in every process that produces events",
        { path: socket.websocket.path },
      );
    }
  }

  let routes: readonly JobsApiRouteInfo[] = [];
  const openapi = (): OpenApiDocument => structuredClone(document);
  const socketPort = (): number | undefined => socket?.websocket.port;
  const services: RouteServices = {
    config,
    queues: new QueueSource(config, options),
    runners: new RunnerSource(config, options),
    routes: () => routes,
    openapi,
    socketPort,
  };

  const router = new BunRouter();
  if (
    socket &&
    config.websocket !== false &&
    config.websocket.port === undefined
  ) {
    // Before anything else, so an upgrade for the socket never reaches CORS,
    // the middleware (the guard runs it) or the JSON 404.
    router.setRoute({
      path: config.websocket.path,
      method: undefined,
      callbacks: [upgradePassthrough()],
    });
  }
  if (config.cors !== false) {
    router.use(cors(config.cors));
  }
  for (const handler of config.middleware) {
    router.use(handler);
  }
  routes = Object.freeze(registerRoutes(router, enabled, services));
  router.use(createNotFoundHandler());
  router.use(createApiErrorHandler({ logger: config.logger }));

  return {
    router,
    basePath: config.basePath,
    mode: config.mode,
    info: apiInfo(config, routes, socket?.websocket),
    routes,
    websocket: socket?.websocket,
    openapi,
    asyncapi: () =>
      asyncDocument === undefined ? undefined : structuredClone(asyncDocument),
    // What the API opened: its sessions (closed 1001), its notifier and a
    // dedicated socket server. The `BunJobs`, queues, runners and driver are
    // never the API's to close.
    close: async () => {
      await socket?.close();
    },
  };
}

/**
 * Creates the management API: validates the configuration (throwing
 * `ConfigError` for anything unusable), then builds the router and the
 * OpenAPI document for exactly the routes this configuration enables.
 *
 * ```ts
 * const api = createJobsApi({ jobs, basePath: "/admin/jobs", authorize });
 * app.use(api.basePath, api.router);
 * ```
 */
export function createJobsApi(config: JobsApiConfig): JobsApi {
  const resolved = resolveConfig(config);
  return buildJobsApi(resolved, builtInRoutes(resolved));
}
