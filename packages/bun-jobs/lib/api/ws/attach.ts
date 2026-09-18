import type {
  BunWebSocketHandlerType,
  RouteConstructorOption,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  UpgradeToWebsocketOptions,
  WebSocketClient,
  WebSocketClientData,
} from "@kingsleyweb/bun-common";
import type { Server } from "bun";
import type {
  JobsApiSocketData,
  JobsApiWebSocket,
  ResolvedJobsApiConfig,
  ResolvedJobsApiWebSocketOptions,
} from "../config";
import type { WsClock } from "./hub";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  BunWebSocket,
} from "@kingsleyweb/bun-common";
import { ConfigError } from "../../shared/errors";
import { decide, denialError, originGuard } from "../auth";
import { ApiError, sendProblem, tagRequestAction, toProblem } from "../errors";
import { EventHub, SYSTEM_CLOCK } from "./hub";
import { JOBS_API_WS_CLOSE, JOBS_API_WS_SUBPROTOCOL } from "./protocol";
import { Session } from "./session";

/**
 * Wiring the socket into a server.
 *
 * `BunRouter.ws()` registers its upgrade layer on the `BunWebSocket`'s own
 * router, and that layer cannot refuse an upgrade — its data function only
 * produces data. So the guard is a separate layer registered first, at the
 * same full path and in the same way:
 *
 * 1. refuse after `close()` (404), and a subprotocol list without `bun-jobs.v1` (400);
 * 2. the `Origin` check (403) — browsers send cookies on cross-site upgrades;
 * 3. the connection cap (429);
 * 4. the configured `middleware`;
 * 5. `authorize` for `events.connect` (401/403), which reserves a connection slot.
 *
 * Each step runs only for upgrade requests; anything else falls through to
 * the host's routing untouched. A refusal is an ordinary problem response,
 * before any socket exists.
 */

/** One callback of a route, as `setRoute` takes it. */
type RouteCallback = RouteConstructorOption["callbacks"][number];

/** How long a slot reserved by an allowed upgrade is held waiting for the socket to open. */
const SLOT_TTL_MS = 10_000;

/** The refusal for a closed socket. */
const closedError = () =>
  new ApiError("ROUTE_NOT_FOUND", 404, "The live-events socket is closed");

/** Options for {@link createJobsApiWebSocket}. */
export interface JobsApiWebSocketInternalOptions {
  /** The clock and timers. Defaults to the system's. */
  clock?: WsClock;
}

/** The socket, with what the API needs to manage it. */
export interface JobsApiSocket {
  /** The public half. */
  websocket: JobsApiWebSocket;
  /** The hub. */
  hub: EventHub;
  /** Open sessions, by socket. */
  sessions: ReadonlyMap<unknown, Session>;
  /** Closes sessions (1001), the hub's notifier and the dedicated server. Idempotent. */
  close: () => Promise<void>;
}

/** Reads a header from either request kind. */
type HeaderReader = (name: string) => string | null;

/**
 * Whether a request asks to upgrade. Deliberately at least as broad as the
 * check `BunWebSocket` upgrades on — a request that check would upgrade must
 * never be one this guard lets through unchecked.
 */
function wantsUpgrade(method: string, header: HeaderReader): boolean {
  return (
    method.toUpperCase() === "GET" &&
    ((header("upgrade") ?? "") !== "" ||
      (header("connection") ?? "").toLowerCase().includes("upgrade"))
  );
}

/** Whether a routed request asks to upgrade. */
function isUpgrade(req: BunRequest): boolean {
  return wantsUpgrade(req.method, (name) => req.getHeader(name));
}

/**
 * The API router's first layer at the socket path: an upgrade leaves the API
 * router (`next("router")`), so the guard and the `ws()` route that `attach()`
 * registered on the host see it instead of the API's JSON 404 — whichever
 * order the host mounted the router and attached the socket in.
 */
export function upgradePassthrough(): RouterHandler {
  return (req, _res, next) => (isUpgrade(req) ? next("router") : next());
}

/** Runs a handler only for upgrade requests, keeping its arity (an error handler stays one). */
function upgradeOnly(handler: RouterHandler): RouteCallback {
  if (handler.length === 4) {
    const errorHandler = handler as unknown as RouterErrorMiddlewareHandler;
    return ((error, req, res, next) =>
      isUpgrade(req)
        ? errorHandler(error, req, res, next)
        : next(error as Error)) satisfies RouterErrorMiddlewareHandler;
  }
  return ((req, res, next) =>
    isUpgrade(req) ? handler(req, res, next) : next()) satisfies RouterHandler;
}

/** A connection-slot reservation. */
interface Slot {
  /** The expiry timer. */
  timer: unknown;
}

/**
 * Builds the socket for a resolved configuration whose `websocket` is enabled:
 * the hub, the handler, the guard, `attach`, `upgrade`, and — with
 * `websocket.port` — a dedicated server, bound now.
 */
export function createJobsApiWebSocket(
  config: ResolvedJobsApiConfig,
  internal?: JobsApiWebSocketInternalOptions,
): JobsApiSocket {
  if (config.websocket === false) {
    throw new ConfigError("The WebSocket is disabled by configuration");
  }
  const options: ResolvedJobsApiWebSocketOptions = config.websocket;
  const clock = internal?.clock ?? SYSTEM_CLOCK;
  const fullPath = `${config.basePath}${options.path}`;
  const hub = new EventHub(config, { clock });
  const sessions = new Map<WebSocketClient<JobsApiSocketData>, Session>();
  const slots = new Map<BunRequest, Slot>();
  const attachedTo = new WeakSet<object>();
  /** `BunWebSocket`s this socket's handler is registered on. */
  const handlerRegisteredOn = new WeakSet<BunWebSocket<any>>();
  /** The instance `attach()` resolved, as a fallback when the router has none now. */
  let boundTo: BunWebSocket<any> | undefined;
  /**
   * The router the socket was attached to. Its `getBunWebsocket()` is asked at
   * upgrade time, so a `BunWebSocket` swapped in later — as
   * `app.useWebSocketAdapter()` does — is the one the handler lands on.
   */
  let boundRouter: BunRouter | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  /** Releases a request's reserved slot. */
  const release = (req: BunRequest) => {
    const slot = slots.get(req);
    if (slot) {
      clock.clearTimeout(slot.timer);
      slots.delete(req);
    }
  };

  /** Whether another connection would exceed `maxConnections`. */
  const full = () => sessions.size + slots.size >= options.maxConnections;

  /** The refusal for a full API. */
  const limitError = () =>
    new ApiError(
      "CONNECTION_LIMIT",
      429,
      `At most ${options.maxConnections} live-event connections are allowed`,
      {
        headers: { "Retry-After": "1" },
        context: { max: options.maxConnections },
      },
    );

  const stateGuard: RouterHandler = (req, _res, next) => {
    if (closed) {
      return next(closedError());
    }
    const offered = req.getHeader("sec-websocket-protocol");
    if (
      offered &&
      !offered
        .split(",")
        .map((protocol) => protocol.trim())
        .includes(JOBS_API_WS_SUBPROTOCOL)
    ) {
      return next(
        new ApiError(
          "UNSUPPORTED_SUBPROTOCOL",
          400,
          `Offer the ${JOBS_API_WS_SUBPROTOCOL} subprotocol, or none`,
          { context: { subprotocol: JOBS_API_WS_SUBPROTOCOL } },
        ),
      );
    }
    return next();
  };

  const capacityGuard: RouterHandler = (_req, _res, next) =>
    full() ? next(limitError()) : next();

  const authorizeUpgrade: RouterHandler = async (req, _res, next) => {
    tagRequestAction(req, "events.connect");
    const decision = await decide(config, req, {
      action: "events.connect",
      transport: "ws",
    });
    if (!decision.allow) {
      return next(denialError(decision));
    }
    // Checked again now that `authorize` has settled: concurrent upgrades
    // all pass the early check before any of them reserves.
    if (closed) {
      return next(closedError());
    }
    if (full()) {
      return next(limitError());
    }
    return next();
  };

  const refuse: RouterErrorMiddlewareHandler = (error, req, res, next) => {
    if (!isUpgrade(req)) {
      return next(error as Error);
    }
    const result = toProblem(error, { instance: req.path });
    const fields = {
      error,
      code: result.problem.code,
      status: result.status,
      action: "events.connect",
      path: req.path,
    };
    if (result.status >= 500) {
      config.logger.error("jobs api upgrade failed", fields);
    } else {
      config.logger.debug("jobs api upgrade refused", fields);
    }
    sendProblem(res, result);
  };

  /**
   * Everything that decides whether an upgrade may proceed, in order, and
   * nothing that performs one.
   *
   * Named rather than sliced off the full guard: raw `Bun.serve` upgrades
   * itself and must run exactly these steps, while the routed path follows
   * them with {@link upgradeHere}. Deriving one from the other by index is how
   * the two silently disagree when a step is added.
   */
  const preUpgrade: RouteCallback[] = [
    upgradeOnly(stateGuard),
    // The same `trustProxy` the HTTP routes use: behind a TLS-terminating
    // proxy the forwarded host and scheme are the ones the browser's `Origin`
    // names, and comparing against the direct ones would refuse a legitimate
    // same-origin upgrade.
    upgradeOnly(
      originGuard(options.allowedOrigins, { trustProxy: config.trustProxy }),
    ),
    upgradeOnly(capacityGuard),
    ...config.middleware.map(upgradeOnly),
    upgradeOnly(authorizeUpgrade),
  ];

  /** The guard as a route: the checks, the upgrade, then the refusal handler. */
  const guard: RouteCallback[] = [
    ...preUpgrade,
    // Last, and only for upgrades: this is where the socket is actually taken
    // over, the serving `BunWebSocket` resolved and the connection slot
    // reserved. A non-upgrade request falls through to the host's routing.
    //
    // Called through an arrow rather than passed directly: this array is built
    // while the module body runs, and `upgradeHere` — which belongs below the
    // handler and session data it uses — is not initialised yet. Deferring the
    // lookup to request time is what keeps both orders legal, and passing it
    // directly is a real `ReferenceError`, not a style question. The rule
    // cannot see that the call happens per request, long after both exist.
    // eslint-disable-next-line ts/no-use-before-define -- deferred to request time; see above
    upgradeOnly((req, res, next) => upgradeHere(req, res, next)),
    refuse,
  ];

  /**
   * The session for a socket, when the socket is one of ours.
   *
   * Every lifecycle lookup goes through the marker, not just `message`: a
   * connection this API did not upgrade — a NestJS gateway's client, when its
   * `"/*"` namespace matches this path on the shared server — must not be able
   * to drive a session, nor to disturb the bookkeeping on its way out.
   */
  const sessionOf = (
    client: WebSocketClient<JobsApiSocketData>,
  ): Session | undefined => {
    const data = client.data?.custom as Partial<JobsApiSocketData> | undefined;
    return data?.bunJobsApi === true ? sessions.get(client) : undefined;
  };

  const handler: BunWebSocketHandlerType<JobsApiSocketData> = {
    open(client) {
      const data = client.data?.custom as
        | Partial<JobsApiSocketData>
        | undefined;
      if (data?.request instanceof BunRequest) {
        release(data.request);
      }
      if (closed) {
        client.close(JOBS_API_WS_CLOSE.GOING_AWAY, "server closing");
        return;
      }
      // Session data is produced only once the guard allowed the upgrade, and
      // carries this API's marker. A socket without it is somebody else's —
      // a NestJS gateway with a `"/*"` namespace on the shared server also
      // matches this path — so it is left alone rather than driven as a
      // session of ours.
      if (
        data?.bunJobsApi !== true ||
        !(data.request instanceof BunRequest) ||
        typeof data.sessionId !== "string"
      ) {
        return;
      }
      const session: Session = new Session(
        client,
        { bunJobsApi: true, sessionId: data.sessionId, request: data.request },
        {
          config,
          options,
          hub,
          clock,
          onEnded: () => {
            if (sessions.get(client) === session) {
              sessions.delete(client);
            }
          },
        },
      );
      sessions.set(client, session);
      session.open();
    },
    message(client, message) {
      sessionOf(client)?.receive(message);
    },
    close(client) {
      sessionOf(client)?.ended();
    },
    drain(client) {
      sessionOf(client)?.drain();
    },
  };

  /**
   * Produces a session's data, after the guard. The marker is what tells this
   * API's connections from another handler's on the same server.
   */
  const sessionData = (req: BunRequest): JobsApiSocketData => ({
    bunJobsApi: true,
    sessionId: crypto.randomUUID(),
    request: req,
  });

  /**
   * The last guard step: perform the upgrade ourselves.
   *
   * Two things make this a layer rather than `router.ws()`:
   *
   * 1. **The serving `BunWebSocket` is resolved here, not at `attach()`.**
   *    Its constructor calls `setBunWebSocket(this)`, so a later
   *    `new BunWebSocketAdapter({ httpAdapter })` — which is what
   *    `app.useWebSocketAdapter()` installs — replaces the router's instance.
   *    Lifecycle dispatch goes through whichever instance is current *at call
   *    time* and looks the handler up in **its** route table, so binding at
   *    `attach()` would leave sockets that connect and then do nothing.
   *    Registering here, once per instance, follows the swap.
   * 2. **The connection slot is reserved at the moment we upgrade.** Another
   *    non-endpoint layer on this path — a NestJS gateway whose `"/*"`
   *    namespace matches — may upgrade first, which sets `headersSent` and
   *    ends the pipeline before this runs. Reserving earlier would then leak
   *    a slot for every such request until its TTL expired.
   */
  const upgradeHere: RouterHandler = (req, res, next) => {
    // Somebody else already answered (a gateway won the race): nothing was
    // reserved, and there is nothing of ours to do.
    if (res.headersSent) {
      return;
    }
    if (closed) {
      return next(closedError());
    }
    if (full()) {
      return next(limitError());
    }

    // Resolved from the router this socket was attached to, at call time —
    // `getBunWebsocket()` returns whichever instance is current now, which is
    // the whole point. (`BunRequest` carries no router of its own.)
    const current = boundRouter?.getBunWebsocket() as
      | BunWebSocket<JobsApiSocketData>
      | undefined;
    const target = current ?? boundTo;
    if (!target) {
      return next(
        new ApiError(
          "INTERNAL",
          500,
          "The live-events socket has no BunWebSocket to upgrade on",
        ),
      );
    }
    // Once per instance: `setRouteHandler` also registers a route of its own,
    // which is harmless — ours runs first and answers.
    if (!handlerRegisteredOn.has(target)) {
      handlerRegisteredOn.add(target);
      void target
        .setRouteHandler(fullPath, handler, undefined)
        .catch((error: unknown) => {
          config.logger.error(
            "jobs api could not register its socket handler",
            { error, path: fullPath },
          );
        });
    }

    const custom = sessionData(req);
    slots.set(req, {
      timer: clock.setTimeout(() => slots.delete(req), SLOT_TTL_MS),
    });
    // Name the subprotocol on the 101 whenever the client offered any, as the
    // raw `upgrade()` path does: `stateGuard` has already refused a list
    // without it, and left to itself Bun answers with the FIRST protocol
    // offered — `["other", "bun-jobs.v1"]` would negotiate `other`.
    const negotiate: UpgradeToWebsocketOptions | undefined = req.getHeader(
      "sec-websocket-protocol",
    )
      ? { headers: { "Sec-WebSocket-Protocol": JOBS_API_WS_SUBPROTOCOL } }
      : undefined;
    res.upgradeToWebsocket(
      {
        host: req.host,
        path: req.path,
        search: req.search,
        hash: req.hash,
        originalUrl: req.originalUrl,
        headers: req.headersObj,
        user: undefined,
        custom,
        route: fullPath,
        params: {},
        ...(typeof req.server?.port === "number"
          ? { port: req.server.port }
          : {}),
      } as WebSocketClientData<JobsApiSocketData>,
      negotiate,
    );
  };

  /**
   * A ws route pattern as a matcher: `"/*"` and `"/admin/*"` cover paths
   * beneath them, anything else matches itself.
   */
  const patternMatches = (pattern: string, path: string): boolean => {
    if (pattern === path) {
      return true;
    }
    if (!pattern.includes("*")) {
      return false;
    }
    const source = pattern
      .replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)
      .replaceAll(/\*\w*/g, ".*");
    return new RegExp(`^${source}/?$`).test(path);
  };

  /**
   * Refuses to attach where another WebSocket route already covers this path.
   *
   * Both routes would be non-endpoint middleware on one router, and the first
   * to upgrade ends the pipeline (`headersSent`), so the later one never runs.
   * A NestJS gateway declared with a `"/*"` namespace is exactly this: it
   * matches `<basePath>/ws` and, registered first, would silently make the
   * socket unreachable. Better to say so at `attach()` than to serve a path
   * that can never answer.
   *
   * Detection reads the `BunWebSocket`'s own route table, whose keys are the
   * patterns `setRouteHandler` registered and whose values identify the owner
   * by reference. That table is private to bun-common, so the shape is checked
   * before it is trusted: if it is ever not a `Map`, this warns and skips
   * rather than guessing — matching arbitrary middleware would report every
   * ordinary `use()` layer as a conflict.
   */
  const assertNoConflictingRoute = (bunWebSocket: BunWebSocket<any>) => {
    const table = (
      bunWebSocket as unknown as {
        _routeHandlers?: Map<string, unknown[]>;
      }
    )._routeHandlers;
    if (!(table instanceof Map)) {
      config.logger.warn(
        "jobs api could not check for a conflicting WebSocket route: bun-common's route table is not in the expected shape",
        { path: fullPath },
      );
      return;
    }
    for (const [pattern, handlers] of table) {
      if (
        patternMatches(pattern, fullPath) &&
        Array.isArray(handlers) &&
        !handlers.includes(handler)
      ) {
        throw new ConfigError(
          `attach(): a WebSocket route for "${pattern}" is already registered on this router and covers the socket's path "${fullPath}". Both are middleware on one router, so whichever upgrades first ends the request and the other never runs — attach the jobs API before registering a catch-all gateway, or give the socket its own port with \`websocket.port\`.`,
          { path: fullPath, conflict: pattern },
        );
      }
    }
  };

  /**
   * Registers the guard on a `BunWebSocket`'s router.
   *
   * The socket route itself is **not** registered here: `upgradeHere` performs
   * the upgrade and registers the handler on whichever `BunWebSocket` is
   * current at that moment, so an adapter swapped in later still dispatches.
   */
  const register = (bunWebSocket: BunWebSocket<any>) => {
    if (attachedTo.has(bunWebSocket)) {
      return;
    }
    assertNoConflictingRoute(bunWebSocket);
    attachedTo.add(bunWebSocket);
    boundTo = bunWebSocket;
    boundRouter = bunWebSocket.router;
    boundRouter.setRoute({
      path: fullPath,
      method: undefined,
      callbacks: guard,
    });
  };

  let dedicated: BunWebSocket<JobsApiSocketData> | undefined;
  if (options.port !== undefined) {
    const ownRouter = new BunRouter();
    ownRouter.setLogger(config.logger);
    dedicated = new BunWebSocket<JobsApiSocketData>({
      newInstance: true,
      listen: { port: options.port },
      router: ownRouter,
    });
    register(dedicated);
  }

  const attach: JobsApiWebSocket["attach"] = (target) => {
    if (closed) {
      throw new ConfigError("attach(): the jobs API is closed", {
        path: fullPath,
      });
    }
    if (dedicated) {
      throw new ConfigError(
        "attach(): websocket.port serves the socket on its own server; there is nothing to attach",
        { path: fullPath, port: dedicated.port },
      );
    }
    const found = resolveBunWebSocket(target);
    if (!found) {
      throw new ConfigError(
        "attach() needs a router with a BunWebSocket — a BunHttpAdapter, its `instance`, or bun-nest's `getInstance()` — and none is attached, so the socket could never upgrade",
        { path: fullPath },
      );
    }
    register(found);
  };

  /*
   * Ordering, for a host that also registers WebSocket routes:
   *
   * - **Attach before any catch-all gateway.** A gateway declared with a
   *   `"/*"` namespace matches this socket's path too. Both are middleware on
   *   one router and the first to upgrade ends the request, so a catch-all
   *   registered first would make the socket unreachable — `attach()` refuses
   *   with `ConfigError` rather than mounting into a dead path.
   * - **Attach before or after `useWebSocketAdapter()`, either way.** The
   *   serving `BunWebSocket` is resolved when a client upgrades, not here, so
   *   an adapter installed afterwards still receives this socket's lifecycle.
   * - **Or avoid the question entirely** with `websocket.port`, which serves
   *   the socket on a server of its own.
   */

  /** The guard as a router of its own, for raw `Bun.serve`. */
  let guardRouter: BunRouter | undefined;
  /** Requests that passed the private guard. */
  const passed = new WeakSet<BunRequest>();

  const upgrade: JobsApiWebSocket["upgrade"] = async (req, server) => {
    const header: HeaderReader = (name) => req.headers.get(name);
    if (!wantsUpgrade(req.method, header)) {
      return null;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return null;
    }
    if (pathname !== fullPath) {
      return null;
    }

    if (!guardRouter) {
      guardRouter = new BunRouter();
      guardRouter.setLogger(config.logger);
      const markPassed: RouterHandler = (request) => {
        passed.add(request);
      };
      guardRouter.setRoute({
        path: fullPath,
        method: undefined,
        // The checks, then a mark — this path upgrades through `server.upgrade`
        // below rather than through `upgradeHere`.
        callbacks: [...preUpgrade, markPassed, refuse],
      });
    }

    const request = await BunRequest.init(req, server, {
      parseBody: false,
      parseCookies: true,
      parseQuery: true,
    });
    const response = new BunResponse(request);
    await guardRouter.handle({
      requestHost: request.host,
      requestMethod: request.method,
      response,
      request,
      requestUrl: request.originalUrl,
    });

    if (!passed.has(request)) {
      return response.headersSent
        ? await response.getNativeResponse(0)
        : new Response(null, { status: 404 });
    }

    const data: WebSocketClientData<JobsApiSocketData> = {
      host: request.host,
      path: request.path,
      search: request.search,
      hash: request.hash,
      originalUrl: request.originalUrl,
      headers: request.headersObj,
      custom: sessionData(request),
      route: fullPath,
      params: {},
      ...(typeof server.port === "number" ? { port: server.port } : {}),
    };
    // Reserved here, as the routed path reserves inside `upgradeHere`: the
    // slot covers the window between deciding to upgrade and `open()`, and is
    // released below if the upgrade fails.
    slots.set(request, {
      timer: clock.setTimeout(() => slots.delete(request), SLOT_TTL_MS),
    });
    const upgraded = server.upgrade(req, {
      data,
      ...(header("sec-websocket-protocol")
        ? { headers: { "Sec-WebSocket-Protocol": JOBS_API_WS_SUBPROTOCOL } }
        : {}),
    });
    if (!upgraded) {
      release(request);
      return new Response("The WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  };

  const websocket: JobsApiWebSocket = {
    path: fullPath,
    get sessions() {
      return sessions.size;
    },
    get port() {
      return dedicated?.port;
    },
    handler,
    attach,
    upgrade,
  };

  const close = async (): Promise<void> => {
    closing ??= (async () => {
      closed = true;
      for (const session of [...sessions.values()]) {
        session.close(JOBS_API_WS_CLOSE.GOING_AWAY, "server closing");
      }
      for (const slot of slots.values()) {
        clock.clearTimeout(slot.timer);
      }
      slots.clear();
      await hub.close();
      if (dedicated) {
        dedicated.killServer(dedicated.getServer());
      }
    })();
    await closing;
  };

  return { websocket, hub, sessions, close };
}

/** The `BunWebSocket` a target carries: its own, or its `instance`'s. */
function resolveBunWebSocket(
  target: BunRouter | { instance: BunRouter },
): BunWebSocket<any> | undefined {
  const own = (
    target as { getBunWebsocket?: () => BunWebSocket<any> | undefined }
  ).getBunWebsocket;
  const direct = typeof own === "function" ? own.call(target) : undefined;
  if (direct) {
    return direct;
  }
  const instance = (target as { instance?: BunRouter }).instance;
  return instance && typeof instance.getBunWebsocket === "function"
    ? (instance.getBunWebsocket() as BunWebSocket<any> | undefined)
    : undefined;
}

/** The server type raw `Bun.serve` hosts pass to `upgrade`. */
export type JobsApiSocketServer = Server<
  WebSocketClientData<JobsApiSocketData>
>;
