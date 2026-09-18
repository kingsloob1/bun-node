import type {
  Server as BunServerType,
  ErrorLike,
  ServerWebSocket,
  WebSocketHandler,
} from "bun";
import type { BunRequestOptions } from "./BunHttpAdapter";
import type {
  BunRouter,
  BunServeNormalOptions,
  matchedRoute,
  NextFunction,
} from "./index";
import { EventEmitter } from "node:events";
import { BunRequest } from "./BunRequest";
import { BunResponse } from "./BunResponse";
// A value import (not just a type): an instance built without a `router`
// creates a private one on first use. `BunRouter.ts` imports this module only
// as a type, so there is no runtime cycle.
import { BunRouter as BunRouterClass } from "./BunRouter";
import { get, isArray, isFunction, isObject, set } from "./utils/native";
import {
  mergeUpgradeHeaders,
  routeUpgradeHook,
  toUpgradeHook,
} from "./utils/wsUpgrade";

/**
 * Minimal strongly-typed `EventEmitter` surface — replaces the `typed-emitter`
 * package without any runtime footprint.
 */
export interface TypedEmitter<
  Events extends Record<string, (...args: any[]) => any>,
> {
  addListener: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  on: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  once: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  prependListener: <E extends keyof Events>(
    event: E,
    listener: Events[E],
  ) => this;
  prependOnceListener: <E extends keyof Events>(
    event: E,
    listener: Events[E],
  ) => this;
  off: <E extends keyof Events>(event: E, listener: Events[E]) => this;
  removeAllListeners: <E extends keyof Events>(event?: E) => this;
  removeListener: <E extends keyof Events>(
    event: E,
    listener: Events[E],
  ) => this;
  emit: <E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ) => boolean;
  eventNames: () => (keyof Events | string | symbol)[];
  listeners: <E extends keyof Events>(event: E) => Events[E][];
  listenerCount: <E extends keyof Events>(event: E) => number;
  getMaxListeners: () => number;
  setMaxListeners: (maxListeners: number) => this;
}

/**
 * Per-connection data stored on `ws.data`. The URL fields mirror what
 * `BunRequest.splitRequestUrl()` exposes for the upgrade request.
 */
export interface WebSocketClientData<TCustom = unknown> {
  /** Authority (`host[:port]`) of the upgrade request. */
  host: string;
  /** Concrete pathname the client connected to, e.g. `/rooms/42`. */
  path: string;
  /** Query string of the upgrade request (`?…`), or `""`. */
  search: string;
  /**
   * Always `""` for a WebSocket upgrade: clients never send a URL fragment
   * (RFC 6455 forbids one in a `ws:`/`wss:` URI). Kept so the shape matches
   * `BunRequest`'s split URL.
   */
  hash: string;
  /** `path + search` of the upgrade request (`BunRequest.originalUrl`). */
  originalUrl: string;
  /** Headers of the upgrade request. */
  headers: Headers;
  /** `req.user` at upgrade time, when an auth middleware set one. */
  user?: Record<string, unknown>;
  /**
   * The route's `custom` value: what an `onUpgrade` hook returned as `custom`
   * (or the deprecated `customDataToWsClientFn` returned), else a router- or
   * response-level `webSocketUpgradeData.custom`, else `undefined` on a
   * `ws()` route and `{}` on a bare `res.upgradeToWebsocket()`.
   */
  custom: TCustom;
  /**
   * The route pattern the upgrade matched, as registered with
   * {@link BunWebSocket.setRouteHandler} / `router.ws()` (e.g. `/rooms/:id`).
   * Route handlers are dispatched by this key. Absent when the data was built
   * some other way (e.g. a bare `res.upgradeToWebsocket()`), in which case
   * dispatch falls back to {@link path}.
   */
  route?: string;
  /**
   * Route params of the matched {@link route}, e.g. `{ id: "42" }`. A copy,
   * so it is safe to mutate. Absent alongside {@link route}.
   */
  params?: Record<string, string>;
  /**
   * The port of the server that accepted the upgrade — the real bound port,
   * never `0`, even for a server started on port `0`. Lets a handler tell a
   * client of the shared HTTP server from one of a dedicated server on
   * another port, when both route through the same router. Set for every
   * upgrade routed through {@link BunWebSocket.setRouteHandler} (any server),
   * for every upgrade a server built by this class performs, and for a bare
   * `res.upgradeToWebsocket()` whenever the server that accepted the request
   * has a port. Absent only when there is none — no real server accepted the
   * request (a socket-free `fetch()`).
   */
  port?: number;
}

/**
 * What an {@link WebSocketUpgradeHook} (`onUpgrade`) may return for one
 * upgrade. Every field is optional; returning nothing (or `undefined`)
 * contributes nothing, so the upgrade proceeds with the layers beneath.
 */
export interface WebSocketUpgradeResult<TCustom = unknown> {
  /**
   * Becomes `ws.data.custom`, over any `custom` from the router- or
   * response-level `webSocketUpgradeData`, and over `data.custom` when both
   * are returned. Set whenever the key is present, even to `undefined`.
   */
  custom?: TCustom;
  /**
   * Headers for the `101 Switching Protocols`, merged over the router's
   * `webSocketUpgradeHeaders` and then the response's; a name given here
   * replaces every value of that name beneath. A `Sec-WebSocket-Protocol`
   * here is how the route picks a subprotocol (Bun otherwise echoes the
   * client's first offer).
   */
  headers?: Bun.HeadersInit;
  /**
   * Replaces `ws.data` entirely: the data built from the request and every
   * `webSocketUpgradeData` layer are discarded. Dispatch still needs `route`,
   * `params` and `port`, so each one this object leaves `undefined` is filled
   * in from the matched route (the route pattern, its params, and the
   * accepting server's port) — a value given here is kept.
   */
  data?: WebSocketClientData<TCustom>;
}

/**
 * The `onUpgrade` hook: runs once per upgrade request that matched a `ws()`
 * route, after the middleware registered before it, and decides what the
 * upgrade carries — see {@link WebSocketUpgradeResult}. May be async. A route's
 * own hook replaces the instance-wide one for that route.
 */
export type WebSocketUpgradeHook<TCustom = unknown> = (
  req: BunRequest,
  res: BunResponse,
) =>
  | WebSocketUpgradeResult<TCustom>
  | void
  | Promise<WebSocketUpgradeResult<TCustom> | void>;

/**
 * The deprecated `customDataToWsClientFn` shape: maps an upgrade request to
 * `ws.data.custom`. Accepted as the instance-wide `customDataToWsClientFn`
 * option and as a function in the third argument of `ws()` /
 * `setRouteHandler()`, and treated as
 * `(req, res) => ({ custom: await fn(req, res) })` — its result is `custom`
 * whatever its shape, `{ data, headers }` included.
 *
 * @deprecated Use a {@link WebSocketUpgradeHook} returning `{ custom }`: the
 * `onUpgrade` option, or `{ onUpgrade }` as a route's third argument.
 */
export type WebSocketCustomDataFn<TCustom = unknown> = (
  req: BunRequest,
  res: BunResponse,
) => TCustom | Promise<TCustom>;

/**
 * Per-route options: the third argument of `BunRouter.ws()`,
 * `BunHttpAdapter.ws()` and `BunWebSocket.setRouteHandler()`, in place of the
 * deprecated custom-data function. An object so that more per-route settings
 * can join it later without another positional argument.
 */
export interface WebSocketRouteOptions<TCustom = unknown> {
  /**
   * The route's {@link WebSocketUpgradeHook}: its `custom` becomes
   * `ws.data.custom`, its `headers` go out on the `101`, and its `data`
   * replaces `ws.data` (with `route`/`params`/`port` filled in from the match
   * where it leaves them out). Replaces the `BunWebSocket`'s instance-wide
   * `onUpgrade` for this route. Default: none, so the instance-wide hook (if
   * any) applies. `TCustom` is inferred from the `custom` it returns.
   */
  onUpgrade?: WebSocketUpgradeHook<TCustom>;
}

/**
 * Where router-wide upgrade defaults are read from. A {@link BunRouter}
 * satisfies it; `BunResponse.webSocketUpgradeDefaults` holds one.
 */
export interface WebSocketUpgradeDefaults {
  /** Router-wide headers for every `101` — the lowest header layer. */
  readonly webSocketUpgradeHeaders: Headers | undefined;
  /** Router-wide base for built `ws.data` — the lowest data layer. */
  readonly webSocketUpgradeData: Partial<WebSocketClientData> | undefined;
}

/**
 * The port `req` was accepted on: that of the `Bun.serve` server it was built
 * with, read from `req.server` (its `socket.localPort` is the *peer's* port).
 * `undefined` for a server with no port, such as the socket-free `fetch()`
 * stub.
 */
function acceptingPort(req: BunRequest): number | undefined {
  const port = req.server?.port;
  return typeof port === "number" && Number.isInteger(port) && port > 0
    ? port
    : undefined;
}

/**
 * The `Bun.serve` server a {@link BunWebSocket} rides on or owns. `TCustom` is
 * the per-connection `ws.data.custom` type; it defaults to `unknown` because,
 * undeclared, it is whatever the `onUpgrade` hook returned as `custom`.
 */
export type BunWebSocketServerType<TCustom = unknown> = BunServerType<
  WebSocketClientData<TCustom>
>;

/** A route's WebSocket lifecycle handlers, with `ws.data.custom` as `TCustom`. */
export type BunWebSocketHandlerType<TCustom = unknown> = WebSocketHandler<
  WebSocketClientData<TCustom>
>;

/** One lifecycle method of {@link BunWebSocketHandlerType}, e.g. `"message"`. */
export type BunWebsocketHandlerFor<
  MethodName extends keyof BunWebSocketHandlerType,
  TCustom = unknown,
> = BunWebSocketHandlerType<TCustom>[MethodName];

/** A connected client as the server sees it, with `ws.data.custom` as `TCustom`. */
export type WebSocketClient<TCustom = unknown> = ServerWebSocket<
  WebSocketClientData<TCustom>
>;

/** The lifecycle events a route's {@link BunWebSocketHandlerType} can handle. */
export type BunWebSocketRouteEvent =
  | "open"
  | "close"
  | "drain"
  | "message"
  | "ping"
  | "pong";

/**
 * What a route handler for `E` receives after the client itself: `[message]`
 * for `message`, `[code, reason]` for `close`, `[data]` for `ping`/`pong`, and
 * nothing for `open`/`drain`.
 */
export type BunWebSocketRouteEventRest<
  TCustom,
  E extends BunWebSocketRouteEvent,
> =
  Parameters<NonNullable<BunWebSocketHandlerType<TCustom>[E]>> extends [
    unknown,
    ...infer Rest,
  ]
    ? Rest
    : never;

export interface BunWebSocketGeneralOptions<TCustom = unknown> {
  /**
   * Bun `WebSocketHandler` config (e.g. `idleTimeout`, `maxPayloadLength`,
   * `perMessageDeflate`). Defaults: `idleTimeout` 30 (seconds),
   * `maxPayloadLength` 1 MB, `perMessageDeflate` on. WebSocket-only — none of
   * it affects HTTP requests. The lifecycle callbacks
   * (`open`/`message`/`close`/…) are omitted — this class supplies and
   * dispatches those itself.
   */
  wsOptions?: Omit<
    BunWebSocketHandlerType<TCustom>,
    "open" | "close" | "message" | "drain" | "ping" | "pong"
  >;
  /**
   * The {@link BunRouter} this adapter registers WebSocket upgrade routes on
   * (via {@link BunWebSocket.setRouteHandler}). Usually the HTTP server's
   * router, so upgrades flow through the same routing pipeline as HTTP.
   * Optional: without one, a private empty router is created on first use,
   * so `setRouteHandler` still works and a standalone server answers 404 to
   * anything that is not a registered WebSocket route.
   */
  router?: BunRouter;
  /**
   * Whether this adapter owns a dedicated `Bun.serve` server (`true`) or rides
   * on an existing one supplied via `getServer` (`false`).
   */
  newInstance: boolean;
  /**
   * Instance-wide {@link WebSocketUpgradeHook}, run for every upgrade on a
   * route registered without a hook of its own (a route's hook replaces it):
   * returns the connection's `custom`, headers for the `101`, or a whole
   * replacement `ws.data`. May be async. Default: none.
   */
  onUpgrade?: WebSocketUpgradeHook<TCustom>;
  /**
   * Maps an upgrade request to the per-connection `custom` payload stored on
   * `ws.data.custom`. Runs at upgrade time; may be async. Treated as
   * `onUpgrade: async (req, res) => ({ custom: await fn(req, res) })`; when
   * both are given, `onUpgrade` wins and a warning is logged once.
   *
   * @deprecated Use {@link onUpgrade} returning `{ custom }`.
   */
  customDataToWsClientFn?: WebSocketCustomDataFn<TCustom>;
}

export interface BunWebSocketCreateServerOptions<
  TCustom = unknown,
  routesType extends string = never,
> extends Omit<BunWebSocketGeneralOptions<TCustom>, "server"> {
  /** Discriminant: this adapter creates and owns its own server. */
  newInstance: true;
  /** Address the dedicated server binds to. */
  listen: {
    /** Hostname/interface to bind. Defaults to Bun's default (all interfaces). */
    host?: string;
    /**
     * Port to bind, `0`–`65535`. `0` lets the OS pick a free port; read the
     * bound one from {@link BunWebSocket.port}.
     */
    port: number;
  };
  /**
   * Milliseconds the dedicated server waits for a (non-upgrade) HTTP response
   * once the route pipeline has returned without one (e.g. a handler that
   * responds later from a callback), before failing the request. Handlers the
   * pipeline awaits finish before the timer starts. `0` (the default) means
   * no timeout, matching `BunHttpAdapter`'s `requestTimeout`. Unrelated to
   * `wsOptions.idleTimeout`, which only governs open WebSocket connections.
   */
  responseTimeout?: number;
  /**
   * Base `Bun.serve` options for the dedicated server (TLS, body limits, etc.);
   * `port`/`hostname`/`fetch`/`websocket` are managed by this class.
   */
  serverOptions?: BunServeNormalOptions<
    WebSocketClientData<TCustom>,
    routesType
  >;
  /** Pre-built {@link BunRequest} to reuse instead of constructing one per fetch. */
  request?: BunRequest;
  /** Pre-built {@link BunResponse} to reuse instead of constructing one per fetch. */
  response?: BunResponse<TCustom>;
  /** Parsing options for requests the dedicated server constructs itself. */
  bunRequestOpts?: BunRequestOptions;
}

export interface BunWebSocketNormalOptions<
  TCustom = unknown,
> extends BunWebSocketGeneralOptions<TCustom> {
  /** Discriminant: this adapter rides on an existing, externally-owned server. */
  newInstance: false;
  /**
   * Returns the shared server to ride on (e.g. the HTTP adapter's). May return
   * `undefined` before that server has started listening.
   */
  getServer: () => BunWebSocketServerType<TCustom> | undefined;
}

export type BunWebSocketOptions<
  TCustom = unknown,
  routesType extends string = never,
> =
  | BunWebSocketNormalOptions<TCustom>
  | BunWebSocketCreateServerOptions<TCustom, routesType>;

/**
 * The event map emitted by {@link BunWebSocket}. Declared as a `type` (not an
 * `interface`) so it satisfies `TypedEmitter`'s `Record<string, …>` constraint
 * — interfaces are open to augmentation and so lack an implicit index sig.
 */
// eslint-disable-next-line ts/consistent-type-definitions
export type BunWebSocketEvents<TCustom = unknown> = {
  /** A client connected: `(ws)`. Emitted together with, and before, `open`. */
  connect: NonNullable<BunWebSocketHandlerType<TCustom>["open"]>;
  /** A client connected: `(ws)`. */
  open: NonNullable<BunWebSocketHandlerType<TCustom>["open"]>;
  /** A client sent a frame: `(ws, message)`, a `string` or a `Buffer`. */
  message: NonNullable<BunWebSocketHandlerType<TCustom>["message"]>;
  /** A client disconnected: `(ws, code, reason)`. Emitted before `close`. */
  disconnect: NonNullable<BunWebSocketHandlerType<TCustom>["close"]>;
  /** A client disconnected: `(ws, code, reason)`. */
  close: NonNullable<BunWebSocketHandlerType<TCustom>["close"]>;
  /** A client sent a ping: `(ws, data)`. */
  ping: NonNullable<BunWebSocketHandlerType<TCustom>["ping"]>;
  /** A client sent a pong: `(ws, data)`. */
  pong: NonNullable<BunWebSocketHandlerType<TCustom>["pong"]>;
  /** A client's send buffer drained and can take more: `(ws)`. */
  drain: NonNullable<BunWebSocketHandlerType<TCustom>["drain"]>;
};

/** The typed emitter surface {@link BunWebSocket} implements. */
export type BunWebSocketEventHandlersType<TCustom = unknown> = TypedEmitter<
  BunWebSocketEvents<TCustom>
>;

/**
 * The status the dedicated server answers an error with: the error's own
 * `status` or `statusCode` when that is a 4xx/5xx code, else `500`.
 */
function errorStatus(error: ErrorLike): number {
  for (const key of ["status", "statusCode"]) {
    // Arbitrary errors: the property may be anything, or absent.
    const value: unknown = Reflect.get(error, key);
    if (
      Number.isInteger(value) &&
      Number(value) >= 400 &&
      Number(value) <= 599
    ) {
      return Number(value);
    }
  }
  return 500;
}

/** A {@link BunWebSocket} event name. */
type WsEventName<T> = keyof BunWebSocketEvents<T>;
/** The listener signature for a given {@link BunWebSocket} event. */
type WsListener<T, E extends WsEventName<T>> = BunWebSocketEvents<T>[E];

export class BunWebSocket<
  TCustom = unknown,
> implements BunWebSocketEventHandlersType<TCustom> {
  /** Servers this instance serves on, by port. */
  private _wsServers = new Map<number, BunWebSocketServerType<TCustom>>();

  /**
   * Lazily-created event bus. `BunWebSocket` is not an `EventEmitter`
   * subclass; the emitter is built on the first `on`/`once`/... call so an
   * instance nobody listens to costs nothing, and `emit` is a no-op until
   * then.
   */
  #emitter: EventEmitter | undefined = undefined;

  /** The dedicated server, when `newInstance` is `true`. */
  private _serverInstance?: BunWebSocketServerType<TCustom>;
  /** Returns the shared server, when `newInstance` is `false`. */
  private _getServerInstance?: () =>
    | BunWebSocketServerType<TCustom>
    | undefined;

  /** The router upgrade routes register on; created lazily when none was given. */
  private _routerInstance: BunRouter | undefined = undefined;
  /** The aggregate handler Bun calls: emits events, then runs route handlers. */
  private _wsHandler!: BunWebSocketHandlerType<TCustom>;

  /** Handlers registered with {@link setRouteHandler}, by route pattern. */
  private _routeHandlers = new Map<
    string,
    BunWebSocketHandlerType<TCustom>[]
  >();

  /**
   * The instance-wide upgrade hook — `onUpgrade`, else the deprecated
   * `customDataToWsClientFn` adapted to one — used when a route has none.
   */
  private _onUpgrade: WebSocketUpgradeHook<TCustom> | undefined = undefined;

  constructor(
    /**
     * Adapter configuration. The `newInstance` discriminant selects the mode:
     * `true` ({@link BunWebSocketCreateServerOptions}) binds a dedicated server
     * on `listen.port`; `false` ({@link BunWebSocketNormalOptions}) rides on the
     * server returned by `getServer`. Shared fields are documented on
     * {@link BunWebSocketGeneralOptions}.
     */
    private options: BunWebSocketOptions<TCustom>,
  ) {
    this._wsHandler = {
      perMessageDeflate: true,
      idleTimeout: 30, // 30 seconds
      maxPayloadLength: 1024 * 1024, // 1 MB
      ...(options?.wsOptions || {}),
      open: async (...args) => {
        this.emit("connect", ...args);
        this.emit("open", ...args);
        await this.processRegisteredRouteHandlerFor("open", ...args);
      },
      message: async (...args) => {
        this.emit("message", ...args);
        await this.processRegisteredRouteHandlerFor("message", ...args);
      },
      close: async (...args) => {
        this.emit("disconnect", ...args);
        this.emit("close", ...args);
        await this.processRegisteredRouteHandlerFor("close", ...args);
      },
      ping: async (...args) => {
        this.emit("ping", ...args);
        await this.processRegisteredRouteHandlerFor("ping", ...args);
      },
      pong: async (...args) => {
        this.emit("pong", ...args);
        await this.processRegisteredRouteHandlerFor("pong", ...args);
      },
      drain: async (...args) => {
        this.emit("drain", ...args);
        await this.processRegisteredRouteHandlerFor("drain", ...args);
      },
    } as BunWebSocketHandlerType<TCustom>;

    if (options.router) {
      this.router = options.router;
    }

    if (options.newInstance) {
      const port = Number(options.listen?.port);
      if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) {
        throw new Error(
          "Ooops.. listen.port must be an integer from 0 to 65535 (0 picks a free port)",
        );
      }

      // Bound directly rather than through `getOrCreateWebsocketServer`, where
      // port `0` means "ride on the shared server" — here it means "any port".
      const server = this.buildWebsocketServer(port);
      this._wsServers.set(server.port ?? port, server);
      this._serverInstance = server;
    } else {
      this._getServerInstance = options?.getServer;
    }

    this._onUpgrade =
      toUpgradeHook(options.onUpgrade, "hook") ??
      toUpgradeHook(options.customDataToWsClientFn, "custom");
    if (
      isFunction(options.onUpgrade) &&
      isFunction(options.customDataToWsClientFn)
    ) {
      // A warning, not an error: a deprecated option left beside its
      // replacement is redundant, not wrong, and `onUpgrade` wins either way.
      this.router.logger.warn(
        "BunWebSocket: both `onUpgrade` and the deprecated `customDataToWsClientFn` were given; `onUpgrade` is used and `customDataToWsClientFn` is ignored.",
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * `TypedEmitter` surface — lazily backed by a `node:events` emitter.
   * ---------------------------------------------------------------- */

  /** Returns the emitter, creating it on demand. */
  private get events(): EventEmitter {
    if (!this.#emitter) {
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.#emitter = emitter;
    }
    return this.#emitter;
  }

  public addListener<E extends WsEventName<TCustom>>(
    event: E,
    listener: WsListener<TCustom, E>,
  ): this {
    this.events.addListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public on<E extends WsEventName<TCustom>>(
    event: E,
    listener: WsListener<TCustom, E>,
  ): this {
    this.events.on(event, listener as (...args: any[]) => void);
    return this;
  }

  public once<E extends WsEventName<TCustom>>(
    event: E,
    listener: WsListener<TCustom, E>,
  ): this {
    this.events.once(event, listener as (...args: any[]) => void);
    return this;
  }

  public prependListener<E extends WsEventName<TCustom>>(
    event: E,
    listener: WsListener<TCustom, E>,
  ): this {
    this.events.prependListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public prependOnceListener<E extends WsEventName<TCustom>>(
    event: E,
    listener: WsListener<TCustom, E>,
  ): this {
    this.events.prependOnceListener(
      event,
      listener as (...args: any[]) => void,
    );
    return this;
  }

  public off<E extends WsEventName<TCustom>>(
    event: E,
    listener: WsListener<TCustom, E>,
  ): this {
    this.#emitter?.off(event, listener as (...args: any[]) => void);
    return this;
  }

  public removeListener<E extends WsEventName<TCustom>>(
    event: E,
    listener: WsListener<TCustom, E>,
  ): this {
    this.#emitter?.removeListener(event, listener as (...args: any[]) => void);
    return this;
  }

  public removeAllListeners<E extends WsEventName<TCustom>>(event?: E): this {
    // `EventEmitter#removeAllListeners` branches on `arguments.length`, not on
    // the argument's value: forwarding `undefined` explicitly makes it look
    // like "remove listeners for the event named `undefined`", which removes
    // nothing. The no-argument case has to call it with no argument.
    if (event === undefined) {
      this.#emitter?.removeAllListeners();
    } else {
      this.#emitter?.removeAllListeners(event);
    }
    return this;
  }

  /** Emits an event; returns `false` when there is no emitter/listener. */
  public emit<E extends WsEventName<TCustom>>(
    event: E,
    ...args: Parameters<WsListener<TCustom, E>>
  ): boolean {
    return this.#emitter ? this.#emitter.emit(event, ...args) : false;
  }

  public listeners<E extends WsEventName<TCustom>>(
    event: E,
  ): WsListener<TCustom, E>[] {
    return (this.#emitter?.listeners(event) ?? []) as WsListener<TCustom, E>[];
  }

  public listenerCount<E extends WsEventName<TCustom>>(event: E): number {
    return this.#emitter?.listenerCount(event) ?? 0;
  }

  public eventNames(): (WsEventName<TCustom> | string | symbol)[] {
    return this.#emitter?.eventNames() ?? [];
  }

  public getMaxListeners(): number {
    return this.#emitter?.getMaxListeners() ?? EventEmitter.defaultMaxListeners;
  }

  public setMaxListeners(maxListeners: number): this {
    this.events.setMaxListeners(maxListeners);
    return this;
  }

  public getOrCreateWebsocketServer(port: number) {
    const sharedServer = this.getServer();
    if (sharedServer && String(sharedServer.port) === String(port)) {
      this._wsServers.set(port, sharedServer);
      return sharedServer;
    }

    const cached = this._wsServers.get(port);
    if (cached) {
      return cached;
    }

    // Port `0` / unspecified means "ride on the existing (shared) server" — e.g.
    // a NestJS `@WebSocketGateway()` with no port shares the HTTP adapter's
    // server (which may not be listening yet, hence possibly `undefined`).
    if (!port || Number(port) <= 0) {
      return sharedServer;
    }

    // A specific port was requested (a standalone `newInstance` adapter, or a
    // `@WebSocketGateway(port)` declaring a non-shared port): bind a dedicated
    // server that listens on exactly that port.
    const server = this.buildWebsocketServer(port);
    this._wsServers.set(port, server);
    return server;
  }

  /**
   * Builds a Bun server (HTTP + WebSocket) bound to `port`, routing requests
   * through this instance's router and upgrading matched WS routes. Used both
   * for standalone (`newInstance`) adapters and for gateways that declare an
   * explicit port distinct from the shared HTTP server.
   */
  private buildWebsocketServer(port: number) {
    const options = this.options;
    const createOpts = options.newInstance ? options : undefined;

    return Bun.serve<WebSocketClientData<TCustom>>({
      ...(createOpts?.serverOptions || {}),
      port,
      hostname: createOpts?.listen?.host,
      development: Bun.env.NODE_ENV !== "production",
      fetch: async (nativeRequest: Request, server) => {
        const req =
          createOpts?.request ||
          (await BunRequest.init(
            nativeRequest,
            server,
            createOpts?.bunRequestOpts || {
              parseBody: true,
              parseCookies: true,
              parseQuery: true,
            },
          ));

        const res = createOpts?.response || new BunResponse<TCustom>(req);
        let routeUsed: matchedRoute | true | undefined;

        try {
          routeUsed = await this.router.handle({
            requestHost: req.host,
            requestMethod: req.method,
            response: res,
            request: req,
            requestUrl: req.originalUrl,
          });
        } catch (e) {
          // Anything can be thrown; wrap a primitive so the request can ride
          // along to the `error` callback.
          const err = isObject(e) ? e : new Error(String(e));
          set(err, "req", req);
          throw err;
        }

        const hasNativeResponse = !!routeUsed;

        if (hasNativeResponse) {
          if (res.upgradeToWsData) {
            const success = server.upgrade(nativeRequest, {
              // The server is known here, so record it even when the data
              // was built elsewhere (a bare `res.upgradeToWebsocket()`).
              data: {
                ...res.upgradeToWsData,
                port: res.upgradeToWsData.port ?? server.port,
              },
              // Only headers the upgrade was explicitly given; the key is left
              // out otherwise so the 101 is exactly Bun's default.
              ...(res.upgradeToWsHeaders
                ? { headers: res.upgradeToWsHeaders }
                : {}),
            });
            if (success) {
              return undefined;
            }

            let response = new Response(
              "An error occurred while upgrading websocket",
              {
                status: 400,
              },
            );
            try {
              response = await res.getNativeResponse(100);
            } catch {
              //
            }

            return response;
          }

          const nativeResponse = await res.getNativeResponse(
            createOpts?.responseTimeout ?? 0,
          );
          return nativeResponse;
        }

        return new Response(undefined, {
          status: 404,
          statusText: "Not Found",
        });
      },
      websocket: this._wsHandler,
      // Rethrowing here (as this once did) turns every handler error and
      // response timeout into an uncaught error; answer it instead, unless
      // the caller supplied their own.
      error: createOpts?.serverOptions?.error ?? this.handleServerError,
    });
  }

  /**
   * The dedicated server's default `error` callback: answers with the error's
   * own `status`/`statusCode` when it is a 4xx/5xx code, else `500`, and logs
   * the error through the router's logger. `serverOptions.error` replaces it.
   *
   * An arrow property so `Bun.serve` can call it unbound.
   */
  protected handleServerError = (error: ErrorLike): Response => {
    const status = errorStatus(error);
    const req =
      "req" in error && error.req instanceof BunRequest ? error.req : undefined;

    this.router.logger.error("Unhandled error on the WebSocket server", {
      error,
      status,
      method: req?.method,
      url: req?.originalUrl,
    });

    // Like Express: a client error's message is safe to show, a server
    // error's is not.
    return new Response(
      status >= 500 ? "Internal Server Error" : error.message,
      { status },
    );
  };

  /**
   * Force-stops `server` (`stop(true)`, closing keep-alive connections so the
   * port is really released) and forgets it. Never creates a server: killing
   * one that is not running is a no-op beyond the `stop` call.
   */
  public killServer(server: BunWebSocketServerType<TCustom> | undefined) {
    if (!server) {
      return this;
    }

    try {
      // A graceful `stop(false)` leaves keep-alive connections open, and with
      // `SO_REUSEPORT` a new server on the same port can then be answered by
      // the stale one.
      server.stop(true);
    } catch {
      //
    }

    const port = server.port;
    if (port !== undefined && this._wsServers.get(port) === server) {
      this._wsServers.delete(port);
    }

    return this;
  }

  /**
   * The port the server this instance serves on is bound to — the
   * OS-assigned one when `listen.port` was `0`. `undefined` while a shared
   * server has not started listening.
   */
  public get port(): number | undefined {
    return this.getServer()?.port;
  }

  public get wsHandler() {
    return this._wsHandler;
  }

  public getServer() {
    if (this._serverInstance) {
      return this._serverInstance;
    }

    if (this._getServerInstance && isFunction(this._getServerInstance)) {
      return this._getServerInstance();
    }

    return undefined;
  }

  /** The router upgrade routes register on; a private one if none was given. */
  public get router(): BunRouter {
    if (!this._routerInstance) {
      this.router = new BunRouterClass();
    }
    return this._routerInstance as BunRouter;
  }

  set router(router: BunRouter) {
    this._routerInstance = router;
    this._routerInstance.setBunWebSocket(this);
  }

  /**
   * Runs the handlers registered for the connection's route for one lifecycle
   * `event`, with the arguments Bun passed for it. Resolves how many handlers
   * the route has (`0` when none, `undefined` when there is no server).
   */
  private async processRegisteredRouteHandlerFor<
    E extends BunWebSocketRouteEvent,
  >(
    event: E,
    ws: WebSocketClient<TCustom>,
    ...rest: BunWebSocketRouteEventRest<TCustom, E>
  ): Promise<number | undefined> {
    // Handlers are stored under the registered pattern (`/rooms/:id`), so look
    // them up by the pattern the upgrade matched, not the concrete path
    // (`/rooms/42`) — which only coincides for static routes.
    const routeKey = ws.data?.route ?? ws.data?.path;
    if (!routeKey) {
      return 0;
    }

    const handlersArr = this._routeHandlers.get(routeKey);
    if (!isArray(handlersArr)) {
      return 0;
    }

    const bunServer = this.getServer();
    if (!bunServer) {
      return undefined;
    }

    await Promise.allSettled(
      handlersArr
        // Never re-invoke this instance's own aggregate handler: the Bun
        // server's `websocket` is already bound to `_wsHandler` (which both
        // emits events *and* calls this method), so a route registered with
        // `router.ws(path, this.wsHandler)` — as the NestJS adapter does —
        // would recurse infinitely once `path` matches the connection's
        // path (e.g. a gateway `namespace`). Per-route *user* handlers
        // (the normal `router.ws` use) are unaffected.
        .filter((handler) => handler !== this._wsHandler)
        .map((handler) => {
          const handlerToExecute = isObject(handler)
            ? handler[event]
            : undefined;
          if (!isFunction(handlerToExecute)) {
            return undefined;
          }

          // `handler[event]` for a generic `E` is a union of every lifecycle
          // signature, which TypeScript cannot call with `E`'s arguments even
          // though the signature for `E` is exactly `(ws, ...rest)`.
          return Reflect.apply(handlerToExecute, bunServer, [ws, ...rest]);
        }),
    );

    return handlersArr.length;
  }

  /**
   * Registers `handler` for WebSocket connections to `path`, and an upgrade
   * route for `path` on this instance's {@link router}. Resolves `false`
   * (registering nothing) when `handler` is not an object.
   *
   * An upgrade request that reaches the route is upgraded with:
   *
   * - **data** — built from the request (host, path, query, headers, `user`),
   *   then `defaultsFrom.webSocketUpgradeData` and `res.webSocketUpgradeData`
   *   merged over it shallowly (later wins per key), then the hook's
   *   `custom`. A hook's `data` replaces all of that instead. `route`,
   *   `params` and `port` come from the match either way — over the layers,
   *   and wherever a hook's `data` leaves them `undefined`.
   * - **headers** — `defaultsFrom.webSocketUpgradeHeaders`, then
   *   `res.webSocketUpgradeHeaders`, then the hook's `headers`, merged per
   *   header name (later wins). None at all sends Bun's default `101`.
   *
   * @param path Route pattern, e.g. `/rooms/:id`; also the key connections
   *   are dispatched by (`ws.data.route`).
   * @param handler The route's lifecycle handlers.
   * @param fnOrOptions The route's {@link WebSocketRouteOptions} — its
   *   `onUpgrade` hook replaces the instance-wide one for this route. A
   *   function here is the deprecated `customDataToWsClientFn` mapping: its
   *   result always becomes `custom`, whatever its shape. Omitted, the
   *   instance-wide hook applies.
   * @param defaultsFrom Whose router-wide `webSocketUpgradeHeaders` /
   *   `webSocketUpgradeData` apply, read at upgrade time. Defaults to this
   *   instance's {@link router}; `router.ws()` passes the router it was called
   *   on.
   */
  public async setRouteHandler(
    path: string,
    handler: BunWebSocketHandlerType<TCustom>,
    fnOrOptions?:
      | WebSocketRouteOptions<TCustom>
      | WebSocketCustomDataFn<TCustom>
      | undefined,
    defaultsFrom?: WebSocketUpgradeDefaults,
  ) {
    if (!isObject(handler)) {
      return false;
    }

    // Set the path and handler
    {
      let handlersArr = this._routeHandlers.get(path) || [];
      if (!isArray(handlersArr)) {
        handlersArr = [];
      }

      if (!handlersArr.includes(handler)) {
        handlersArr.push(handler);
      }

      this._routeHandlers.set(path, handlersArr);
    }

    const routeHook = routeUpgradeHook(fnOrOptions);

    // Register upgrade endpoint for route
    const wsRouteHandler = async (
      req: BunRequest,
      res: BunResponse,
      next: NextFunction,
    ) => {
      const connectionHeader = String(
        req.headersObj.get("connection")?.toLowerCase() || "",
      );
      const upgradeHeader = String(
        req.headersObj.get("upgrade")?.toLowerCase() || "",
      );
      const secWebsocketKey = String(
        req.headersObj.get("sec-websocket-key") || "",
      );

      if (
        req.method?.toLowerCase() === "get" &&
        connectionHeader.startsWith("upgrade") &&
        upgradeHeader === "websocket" &&
        secWebsocketKey
      ) {
        // The route's own hook, else the instance-wide one — read now, so a
        // hook is never captured before the instance finished configuring.
        const hook = routeHook ?? this._onUpgrade;
        const result: WebSocketUpgradeResult<TCustom> | undefined = hook
          ? ((await hook(req, res)) ?? undefined)
          : undefined;

        // An upgrade route is registered like `use()` middleware (no verb), so
        // the pipeline never binds `req.params` for it. Read them from this
        // callback's own matched layer instead — the same match the pipeline
        // ran, wildcard aliases included.
        const layer = this.router
          .getMatchedLayers({
            requestHost: req.host,
            requestMethod: req.method,
            requestUrl: req.originalUrl,
          })
          .find((entry) => entry.callback === wsRouteHandler);
        // Copied: matched layers are cached and shared across requests.
        const params = {
          ...((layer?.matched.params ?? {}) as Record<string, string>),
        };
        // Whichever server built `req` — shared, standalone or extra-port.
        const port = acceptingPort(req);

        const defaults = defaultsFrom ?? this.router;
        const responseData = res.webSocketUpgradeData as
          | Partial<WebSocketClientData<TCustom>>
          | undefined;

        let data: WebSocketClientData<TCustom>;
        if (result?.data) {
          // Replaces everything beneath it; only what dispatch needs, and it
          // left out, is filled in.
          data = {
            ...result.data,
            route: result.data.route ?? path,
            params: result.data.params ?? params,
            ...(result.data.port === undefined && port !== undefined
              ? { port }
              : {}),
          };
        } else {
          data = {
            host: req.host,
            path: req.path,
            search: req.search,
            hash: req.hash,
            originalUrl: req.originalUrl,
            headers: req.headersObj,
            user: get<Record<string, unknown> | undefined>(req, "user"),
            // `undefined` when nothing supplies one. `TCustom` is only
            // declared by a caller who supplies one, and defaults to `unknown`
            // (which admits `undefined`) otherwise.
            custom: undefined as TCustom,
            // The router-wide base carries no custom type of its own.
            ...(defaults.webSocketUpgradeData as
              | Partial<WebSocketClientData<TCustom>>
              | undefined),
            ...responseData,
            // Dispatch keys: always the match's, whatever a layer said.
            route: path,
            params,
            port,
          };
        }
        if (result && Object.hasOwn(result, "custom")) {
          data.custom = result.custom as TCustom;
        }

        const headers = mergeUpgradeHeaders(
          defaults.webSocketUpgradeHeaders,
          res.webSocketUpgradeHeaders,
          result?.headers,
        );

        // Every layer is already applied: `inherit: false` stops the response
        // from layering the serving router's defaults over them again.
        return res.upgradeToWebsocket(data as WebSocketClientData, {
          ...(headers ? { headers } : {}),
          inherit: false,
        });
      }

      next();
    };

    this.router.setRoute({
      path,
      method: undefined,
      callbacks: [wsRouteHandler],
    });

    return true;
  }
}
