import type {
  BunHttpAdapter,
  BunWebSocketCreateServerOptions,
  BunWebsocketHandlerFor,
  BunWebSocketNormalOptions,
  BunWebSocketOptions,
  BunWebSocketServerType,
  WebSocketClient,
} from "@kingsleyweb/bun-common";
import type { WebSocketAdapter, WsMessageHandler } from "@nestjs/common";
import type { Observable } from "rxjs";
import { Buffer } from "node:buffer";
import {
  BunWebSocket,
  isArray,
  isFunction,
  isNull,
  isObject,
  isString,
  isUndefined,
} from "@kingsleyweb/bun-common";

/**
 * The shape a NestJS gateway handler may return to push a message back to the
 * client (mirrors `@nestjs/websockets`' `WsResponse`). A handler can also
 * return a bare value, a `Promise`, or an `Observable` of these — all are
 * normalised through the `transform` supplied by NestJS.
 *
 * When `data` is binary (a `Buffer`, any typed array, a `DataView` or an
 * `ArrayBuffer`) the reply is sent as a `BINARY_EVENT` whose payload is the
 * bytes in base64; anything else is sent as an `EVENT`.
 *
 * Any other non-nullish emission is, as with `@nestjs/platform-socket.io`, an
 * automatic acknowledgement: when the packet carried an ack `id` and the
 * handler does **not** take `@Ack()` (`isAckHandledManually` is `false`), it
 * is sent as `ACK [value]`. With `@Ack()` only the handler's own call acks.
 */
export interface WsResponse<T = unknown> {
  /** The event name the client receives, `data[0]` of the packet. */
  event: string;
  /** The payload, `data[1]` of the packet. Binary payloads travel as base64. */
  data: T;
}

/**
 * NestJS hands `bindMessageHandlers` a `transform` that wraps a handler's
 * return value (value | Promise | Observable) into an `Observable`, so the
 * adapter can subscribe and stream every emission back to the client.
 */
// `data` is whatever a gateway handler returned (NestJS types it `any`), and
// the emissions are forwarded untouched, so neither side can be narrowed.
export type WsResponseTransform = (data: unknown) => Observable<unknown>;

/**
 * Event name → argument tuple, describing what may be emitted to (or
 * acknowledged to) a client. The default accepts any event with any
 * arguments; declare one to have `emit` check them:
 *
 * ```ts
 * type ChatEvents = { message: [text: string]; typing: [] };
 * const client = socket as BunNestWebSocketClient<Session, ChatEvents>;
 * client.emit("message", "hi");
 * ```
 */
export type WsEventMap = Record<string, unknown[]>;

/**
 * One argument as it travels in a binary packet: bytes (any typed array, a
 * `DataView` or an `ArrayBuffer`) become their base64 string; anything else is
 * JSON-encoded as it is.
 */
export type WsEncodedArg<T> = T extends ArrayBufferView | ArrayBuffer
  ? string
  : T;

/** An argument tuple as it travels in a binary packet (see {@link WsEncodedArg}). */
export type WsEncodedArgs<TArgs extends unknown[]> = {
  [K in keyof TArgs]: WsEncodedArg<TArgs[K]>;
};

/**
 * Acknowledgement callback handed to a gateway handler when an `EVENT` or
 * `BINARY_EVENT` packet carries an ack `id`. NestJS's `WsParamsFactory`
 * resolves `@Ack()` to the first function argument, so passing this satisfies
 * that convention.
 *
 * Calling it sends an `ACK` packet with the same `id` and the arguments as
 * `data`. When any argument is binary the packet is a `BINARY_ACK` instead, and
 * each binary argument is base64 — socket.io's rule: the ack type follows the
 * ack's payload, not the type of the event it answers.
 *
 * Like socket.io's, it sends at most once per packet: a second call (or an
 * automatic ack after a manual one) is ignored. A handler that takes it and
 * never calls it sends no ack at all — its return value is not used as one.
 *
 * `TArgs` is the tuple the handler answers with, `unknown[]` when undeclared
 * (the adapter itself sends whatever it is given).
 */
export type WsAckFunction<TArgs extends unknown[] = unknown[]> = (
  ...args: TArgs
) => void;

/**
 * Sends an event to one client, like a socket.io socket's `emit`. The adapter
 * installs it on every client it hands to a gateway (see
 * {@link BunNestWebSocketClient}); binary arguments make the packet a
 * `BINARY_EVENT`. With a {@link WsEventMap} declared, the event name and its
 * arguments are checked against it.
 */
export type WsEmitFunction<TEvents extends WsEventMap = WsEventMap> = <
  TEvent extends keyof TEvents & string,
>(
  event: TEvent,
  ...args: TEvents[TEvent]
) => boolean;

/**
 * A client as a gateway receives it: Bun's `ServerWebSocket` plus the
 * {@link WsEmitFunction} `emit` the adapter installs. NestJS's default
 * WebSocket exception handler reports errors through `client.emit`, so this is
 * what delivers a thrown `WsException` to the client as an `exception` event.
 *
 * `customWebsocketDataType` is `client.data.custom` (what
 * the `onUpgrade` hook returned as `custom`); `TEvents` optionally types `emit`.
 */
export type BunNestWebSocketClient<
  customWebsocketDataType = unknown,
  TEvents extends WsEventMap = WsEventMap,
> = WebSocketClient<customWebsocketDataType> & {
  /** Sends `[event, ...args]` to this client as an `EVENT`/`BINARY_EVENT` packet. */
  emit: WsEmitFunction<TEvents>;
};

export enum MessageEventTypes {
  CONNECT = 0,
  DISCONNECT = 1,
  EVENT = 2,
  ACK = 3,
  ERROR = 4,
  BINARY_EVENT = 5,
  BINARY_ACK = 6,
}

export interface MessageConnectType {
  /** Packet discriminant. */
  type: MessageEventTypes.CONNECT;
  /** The namespace the packet names; echoed, not routed. */
  namespace: string;
}

export interface MessageDisConnectType {
  /** Packet discriminant. */
  type: MessageEventTypes.DISCONNECT;
  /** The namespace the packet names; echoed, not routed. */
  namespace: string;
}

/**
 * An `EVENT` packet. `TEvent` is the event name and `TArgs` its arguments;
 * both default to "any", which is what an undecoded incoming packet is.
 */
export interface MessageEventType<
  TEvent extends string = string,
  TArgs extends unknown[] = unknown[],
> {
  /** Packet discriminant. */
  type: MessageEventTypes.EVENT;
  /** The namespace the packet names; echoed in replies, not routed. */
  namespace: string;
  /**
   * Asks for an acknowledgement: the handler receives an ack callback
   * (`@Ack()`), which answers with an `ACK`/`BINARY_ACK` of this id.
   */
  id?: string | number;
  /**
   * `[eventName, ...args]`. As socket.io's adapter maps them, a handler's
   * payload (`@MessageBody()`) is the one argument, an array of them when
   * there are several, and `undefined` when there are none.
   */
  data: [eventName: TEvent, ...eventData: TArgs];
}

/**
 * A `BINARY_EVENT` packet: an {@link MessageEventType} whose `TArgs` travel
 * encoded, each binary argument as base64 ({@link WsEncodedArgs}).
 */
export interface MessageBinaryEventType<
  TEvent extends string = string,
  TArgs extends unknown[] = unknown[],
> {
  /** Packet discriminant. */
  type: MessageEventTypes.BINARY_EVENT;
  /** The namespace the packet names; echoed in replies, not routed. */
  namespace: string;
  /** Asks for an acknowledgement, as on {@link MessageEventType.id}. */
  id?: string | number;
  /**
   * `[eventName, ...args]`, each binary argument as a base64 string. On
   * receipt those named by {@link binary} are decoded into `Buffer`s, then
   * the arguments become the payload as on {@link MessageEventType.data}.
   */
  data: [eventName: TEvent, ...eventData: WsEncodedArgs<TArgs>];
  /**
   * Which arguments are base64: their positions after the event name (`0` is
   * the first argument). The adapter always sends it. A packet received
   * without it is read as carrying only binary arguments, so every string
   * argument is decoded.
   */
  binary?: number[];
}

/** An `ACK` packet answering an event; `TArgs` is what the ack was called with. */
export interface MessageAckType<TArgs extends unknown[] = unknown[]> {
  /** Packet discriminant. */
  type: MessageEventTypes.ACK;
  /** The namespace the packet names. */
  namespace: string;
  /** The id of the event this acknowledges. */
  id: string | number;
  /** Whatever the handler passed to its ack callback, in order. */
  data: TArgs;
}

export interface MessageErrorType {
  /** Packet discriminant. */
  type: MessageEventTypes.ERROR;
  /** The namespace the packet names. */
  namespace: string;
  /** The error message. */
  data: string;
}

/** A `BINARY_ACK` packet: an {@link MessageAckType} with `TArgs` encoded. */
export interface MessageBinaryAckType<TArgs extends unknown[] = unknown[]> {
  /** Packet discriminant. */
  type: MessageEventTypes.BINARY_ACK;
  /** The namespace the packet names. */
  namespace: string;
  /** The id of the event this acknowledges. */
  id: string | number;
  /** The ack callback's arguments, each binary one as a base64 string. */
  data: WsEncodedArgs<TArgs>;
  /** Positions in {@link data} of the base64 arguments; the adapter always sends it. */
  binary?: number[];
}

/**
 * Every packet shape, keyed by its {@link MessageEventTypes} discriminant.
 * `TEvent`/`TArgs` flow into the event and ack packets.
 */
export interface MessagePacketMap<
  TEvent extends string = string,
  TArgs extends unknown[] = unknown[],
> {
  /** `CONNECT` (0). */
  [MessageEventTypes.CONNECT]: MessageConnectType;
  /** `DISCONNECT` (1). */
  [MessageEventTypes.DISCONNECT]: MessageDisConnectType;
  /** `EVENT` (2). */
  [MessageEventTypes.EVENT]: MessageEventType<TEvent, TArgs>;
  /** `ACK` (3). */
  [MessageEventTypes.ACK]: MessageAckType<TArgs>;
  /** `ERROR` (4). */
  [MessageEventTypes.ERROR]: MessageErrorType;
  /** `BINARY_EVENT` (5). */
  [MessageEventTypes.BINARY_EVENT]: MessageBinaryEventType<TEvent, TArgs>;
  /** `BINARY_ACK` (6). */
  [MessageEventTypes.BINARY_ACK]: MessageBinaryAckType<TArgs>;
}

/**
 * The packet for one (or a union of) {@link MessageEventTypes}:
 * `MessagePacket<MessageEventTypes.ACK, never, [string]>` is an `ACK` whose
 * `data` is `[string]`.
 */
export type MessagePacket<
  TType extends MessageEventTypes,
  TEvent extends string = string,
  TArgs extends unknown[] = unknown[],
> = MessagePacketMap<TEvent, TArgs>[TType];

/** Any packet, as it arrives before its `type` is inspected. */
export type MessageFormat = MessagePacket<MessageEventTypes>;

export type BunWebsocketHttpAdapter<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> = Pick<
  InstanceType<typeof BunHttpAdapter<customWebsocketDataType, routesType>>,
  "instance" | "getBunServer"
>;

export interface BunWebSocketAdapterOptionsFromHttpAdapter<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> {
  /**
   * The HTTP adapter to ride on. The adapter sources its router and shared
   * `Bun.serve` server from it, so gateway upgrades flow through the app's
   * existing server.
   */
  httpAdapter: BunWebsocketHttpAdapter<customWebsocketDataType, routesType>;
  /**
   * Extra {@link BunWebSocket} options layered on top of the ones derived from
   * `httpAdapter`; every field given wins. `router` and `getServer` default to
   * the HTTP adapter's, and `{ newInstance: true, listen }` binds a dedicated
   * server instead of riding the HTTP adapter's.
   */
  localOptions?: BunWebSocketOptions<customWebsocketDataType, routesType>;
}

export type BunWebSocketAdapterNormalOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> = BunWebSocketOptions<customWebsocketDataType, routesType> & {
  /**
   * Optional HTTP adapter to source the router from. With `newInstance: true`
   * the adapter still binds its own server on `listen.port`, but defaults its
   * router to `httpAdapter.instance` when no explicit `router` is given. With
   * `newInstance: false` it defaults `router` likewise, while `getServer` still
   * decides the server.
   */
  httpAdapter?: BunWebsocketHttpAdapter<customWebsocketDataType, routesType>;
};

export type BunWebSocketAdapterOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> =
  | BunWebSocketAdapterOptionsFromHttpAdapter<
      customWebsocketDataType,
      routesType
    >
  | BunWebSocketAdapterNormalOptions<customWebsocketDataType, routesType>;

/**
 * The options NestJS passes to {@link BunWebSocketAdapter.create}: a gateway's
 * `@WebSocketGateway()` metadata, plus the `server` it adds when creating a
 * namespace on an existing one.
 */
export interface BunWebSocketGatewayOptions<customWebsocketDataType = unknown> {
  /** Gateway namespace, served as a URL path below {@link path}. */
  namespace?: string;
  /** Gateway URL path (default `"/"`). */
  path?: string;
  /** socket.io transports; accepted for compatibility, unused. */
  transport?: string[];
  /** The server a namespaced `create()` call reuses, when NestJS passes one. */
  server?: BunWebSocketServerType<customWebsocketDataType> | undefined;
  // Any other `@WebSocketGateway()` option (`cors`, custom keys, ...): NestJS
  // forwards the metadata as it was written, so its values are not knowable.
  [key: string]: unknown;
}

/** One `bindClientConnect` registration, kept so `close()` can detach it. */
interface ConnectBinding<customWebsocketDataType> {
  /** The server NestJS passed (what `create()` returned for the gateway). */
  server: BunWebSocketServerType<customWebsocketDataType> | undefined;
  /** The `connect` listener registered for the gateway. */
  listener: (client: WebSocketClient<customWebsocketDataType>) => void;
}

/** The route a server-creating `create()` call registered, per server. */
interface ServerRoute<customWebsocketDataType> {
  /** What `create()` returned. */
  server: BunWebSocketServerType<customWebsocketDataType> | undefined;
  /** The URL path the gateway serves, from its `path` option (default `"/"`). */
  route: string;
}

/** Whether `value` is bytes: any typed array, a `DataView` or an `ArrayBuffer`. */
function isBinary(value: unknown): value is ArrayBufferView | ArrayBuffer {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/** Encodes bytes as base64. */
function toBase64(value: ArrayBufferView | ArrayBuffer): string {
  return (
    value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  ).toString("base64");
}

/**
 * The arguments with binary ones as base64, and the positions of those
 * (empty when none is binary) — the `binary` list of a binary packet.
 */
function encodeArgs<TArgs extends unknown[]>(
  args: TArgs,
): { binary: number[]; encoded: WsEncodedArgs<TArgs> } {
  const binary: number[] = [];
  const encoded = args.map((arg, index) => {
    if (!isBinary(arg)) {
      return arg;
    }
    binary.push(index);
    return toBase64(arg);
  });
  // `map` cannot carry a tuple's element types; this is the mapping it did.
  return { binary, encoded: encoded as WsEncodedArgs<TArgs> };
}

/**
 * The inverse of {@link encodeArgs}: decodes the base64 arguments of a binary
 * packet into `Buffer`s. `positions` is the packet's `binary` list; a packet
 * without one is taken to carry only binary arguments, so every string is
 * decoded. Anything else is left as it is.
 */
function decodeArgs(args: unknown[], positions: unknown): unknown[] {
  const marked = Array.isArray(positions)
    ? new Set(positions.filter((position) => Number.isInteger(position)))
    : undefined;
  return args.map((arg, index) =>
    isString(arg) && (marked === undefined || marked.has(index))
      ? Buffer.from(arg, "base64")
      : arg,
  );
}

/**
 * A handler's payload from an event's arguments, as socket.io's `IoAdapter`
 * maps them: the one argument, an array when there are several, `undefined`
 * when there are none.
 */
function argsToPayload(args: unknown[]): unknown {
  return args.length <= 1 ? args[0] : args;
}

/**
 * NestJS WebSocket adapter over Bun's native WebSockets, speaking a
 * socket.io-shaped JSON packet protocol ({@link MessageEventTypes}).
 *
 * How it maps NestJS's gateway options, compared with `@nestjs/platform-ws`:
 *
 * - **`path` and `namespace` are URL paths.** A gateway serves connections
 *   whose URL path is `path` followed by `namespace` (`{ path: "/ws" }` →
 *   `/ws`, `{ namespace: "/chat" }` → `/chat`, both → `/ws/chat`; neither →
 *   `/`), and a path no gateway serves refuses the upgrade. platform-ws has
 *   `path` but no namespaces. One caveat: when one port serves several
 *   `path`s, a gateway declaring the same `path` as an earlier one and no
 *   `namespace` gets no `create()` call from NestJS and cannot be told apart,
 *   so it is bound to `/` if that is among them; give it a `namespace`.
 * - **A port is a boundary.** `@WebSocketGateway(port)` binds a dedicated
 *   server on that port, and the gateway handles only clients that server
 *   accepted (`client.data.port === port`); a gateway on port `0` (or none)
 *   handles only clients of the server it rides on — the HTTP adapter's —
 *   read when the client connects. Two gateways on the same path but
 *   different ports never see each other's clients, as with socket.io, where
 *   each port is its own server. A mismatched client runs none of the
 *   gateway's connection, message or disconnect hooks. A client with no
 *   recorded port is refused by a gateway on an explicit port and accepted by
 *   one on port `0`.
 * - **Exceptions reach the client.** Every client a gateway receives gets an
 *   `emit(event, ...args)` ({@link BunNestWebSocketClient}), which NestJS's
 *   default exception handler calls: a thrown `WsException("nope")` arrives as
 *   an `EVENT` packet `["exception", { status: "error", message: "nope",
 *   cause }]`, as with socket.io. An exception filter can replace that.
 * - **Acks follow `@nestjs/platform-socket.io`.** For a packet with an ack
 *   `id`, a handler declaring `@Ack()` (`isAckHandledManually`) acks only by
 *   calling it; any other handler's non-`WsResponse`, non-nullish return (each
 *   emission of a Promise or Observable) is sent as the ack. Either way an ack
 *   is sent at most once per packet, and a `WsResponse` is always emitted.
 * - **`close(server)` never stops a server it does not own.** On the HTTP
 *   adapter's shared server it closes the adapter's WebSocket connections and
 *   detaches the gateways bound there, leaving the HTTP server to the HTTP
 *   adapter; a dedicated server (a gateway port, or `newInstance`) is stopped.
 */
export class BunWebSocketAdapter<
  customWebsocketDataType = unknown,
  routesType extends string = never,
>
  extends BunWebSocket<customWebsocketDataType>
  implements
    WebSocketAdapter<
      BunWebSocketServerType<customWebsocketDataType> | undefined,
      WebSocketClient<customWebsocketDataType>,
      BunWebSocketGatewayOptions<customWebsocketDataType>
    >
{
  /** Whether this adapter owns the server `getServer()` returns (`newInstance: true`). */
  private readonly _ownsServer: boolean;

  /**
   * The route of the gateway currently being wired. NestJS calls `create()`
   * immediately before `bindClientConnect()` (synchronously, per gateway), so
   * this carries the route from one to the other; `bindClientConnect` consumes
   * it. `undefined` means NestJS reused an existing server without calling
   * `create()`, and the route is looked up in {@link _serverRoutes}.
   */
  private _pendingConnectRoute: string | undefined = undefined;

  /**
   * The port of the gateway currently being wired, carried from `create()` to
   * `bindClientConnect()` like {@link _pendingConnectRoute}: the explicit port,
   * or `0` for one riding the shared server. `undefined` when NestJS skipped
   * `create()`; the port is then read from the server handle.
   */
  private _pendingConnectPort: number | undefined = undefined;

  /** Routes registered by server-creating `create()` calls, oldest first. */
  private readonly _serverRoutes: ServerRoute<customWebsocketDataType>[] = [];

  /** Every `bindClientConnect` registration still attached. */
  private _bindings: ConnectBinding<customWebsocketDataType>[] = [];

  /** Servers `create()` bound on a port of their own (gateway ports). */
  private readonly _dedicatedServers = new Set<
    BunWebSocketServerType<customWebsocketDataType>
  >();

  /** Open connections this adapter has accepted, for `close()`. */
  private readonly _clients = new Set<
    WebSocketClient<customWebsocketDataType>
  >();

  constructor(
    /**
     * Adapter configuration. Two shapes are accepted:
     * {@link BunWebSocketAdapterOptionsFromHttpAdapter} (`{ httpAdapter,
     * localOptions? }`) rides on the HTTP adapter's shared server, while
     * {@link BunWebSocketAdapterNormalOptions} either binds a dedicated server
     * on its own `listen.port` (`newInstance: true`) or rides on the server
     * `getServer` returns (`newInstance: false`). There is no default port:
     * a shape that names no server throws.
     */
    options: BunWebSocketAdapterOptions<customWebsocketDataType, routesType>,
  ) {
    const resolved = resolveAdapterOptions(options);
    super(resolved);
    this._ownsServer = resolved.newInstance;

    this.on("connect", (client) => {
      this._clients.add(client);
    });
    this.on("disconnect", (client) => {
      this._clients.delete(client);
    });
  }

  /** Normalises a leading slash and drops a trailing one (`"ws/"` → `"/ws"`). */
  private normalizeSegment(segment: string | undefined): string {
    if (!isString(segment) || segment.length === 0 || segment === "/") {
      return "";
    }
    const leading = segment.startsWith("/") ? segment : `/${segment}`;
    return leading.length > 1 && leading.endsWith("/")
      ? leading.slice(0, -1)
      : leading;
  }

  /**
   * The URL path a gateway serves: its `path` option followed by its
   * `namespace`, `"/"` when both are absent. A trailing `"/*"` (or a `"*"`
   * namespace) is a wildcard matching every path below.
   */
  private resolveRoute(path?: string, namespace?: string): string {
    const route = `${this.normalizeSegment(path)}${this.normalizeSegment(namespace)}`;
    return route.length > 0 ? route : "/";
  }

  /** Whether `client` (by its connect path) belongs to `route`. */
  private connectionMatchesRoute(
    client: WebSocketClient<customWebsocketDataType>,
    route: string,
  ): boolean {
    if (route === "/*") {
      return true;
    }
    const path = client?.data?.path ?? "/";
    if (route.endsWith("/*")) {
      const base = route.slice(0, -2);
      return path === base || path.startsWith(`${base}/`);
    }
    return path === route;
  }

  /**
   * Whether `client` arrived on the server of a gateway on `port`: for an
   * explicit port, `client.data.port === port` (a client with no port is
   * refused); for port `0`, the port {@link getServer} is bound to now (a
   * client with no port is accepted).
   */
  private connectionMatchesPort(
    client: WebSocketClient<customWebsocketDataType>,
    port: number,
  ): boolean {
    const clientPort = client?.data?.port;
    if (port > 0) {
      return clientPort === port;
    }
    // Read at connection time: the shared server may not have been listening
    // when the gateway was created.
    return clientPort === undefined || clientPort === this.getServer()?.port;
  }

  /**
   * The port of a gateway NestJS bound to `server` without a `create()` call:
   * a dedicated server's own port, or `0` for the shared server.
   */
  private portForServer(
    server: BunWebSocketServerType<customWebsocketDataType> | undefined,
  ): number {
    return server && this._dedicatedServers.has(server)
      ? Number(server.port)
      : 0;
  }

  /** Whether `server` is the shared server this adapter rides on but does not own. */
  private isSharedServer(
    server: BunWebSocketServerType<customWebsocketDataType> | undefined,
  ): boolean {
    return (
      !this._ownsServer &&
      (isUndefined(server) || server === this.getServer()) &&
      !(server && this._dedicatedServers.has(server))
    );
  }

  /** Whether two server handles name the same server (`undefined` is the shared one). */
  private isSameServer(
    a: BunWebSocketServerType<customWebsocketDataType> | undefined,
    b: BunWebSocketServerType<customWebsocketDataType> | undefined,
  ): boolean {
    return a === b || (this.isSharedServer(a) && this.isSharedServer(b));
  }

  /**
   * Installs {@link WsEmitFunction} as `client.emit` (once). NestJS's exception
   * handler only reports an error when the client has an `emit`.
   */
  private installEmit(
    client: WebSocketClient<customWebsocketDataType>,
  ): BunNestWebSocketClient<customWebsocketDataType> {
    const target = client as BunNestWebSocketClient<customWebsocketDataType>;
    if (isFunction(target.emit)) {
      return target;
    }
    target.emit = (event, ...args) => {
      target.send(
        JSON.stringify(
          this.eventPacket(client?.data?.path ?? "/", String(event), args),
        ),
      );
      return true;
    };
    return target;
  }

  create(
    port: number,
    options?: BunWebSocketGatewayOptions<customWebsocketDataType>,
  ): BunWebSocketServerType<customWebsocketDataType> | undefined {
    // Register the upgrade route at the gateway's path + namespace (default
    // "/"). A connection whose path matches no gateway matches no ws route, so
    // the upgrade is refused with a 404 — handled cleanly at the HTTP layer
    // rather than by opening then closing the socket. Pass `"/*"` to accept
    // every path.
    const route = this.resolveRoute(options?.path, options?.namespace);
    this.router.ws(route, this.wsHandler);
    const server = this.getOrCreateWebsocketServer(port);

    if (server && server !== this.getServer()) {
      this._dedicatedServers.add(server);
    }

    // NestJS creates a server with the gateway's options minus `namespace`,
    // then calls `create()` again with the namespace. Only the first names the
    // server's own route, which a later gateway reusing that server (NestJS
    // skips `create()` for it) must be bound to.
    const namespace = options?.namespace;
    if (!(isString(namespace) && namespace.length > 0)) {
      this._serverRoutes.push({ server, route });
    }

    this._pendingConnectRoute = route;
    this._pendingConnectPort = Number(port) > 0 ? Number(port) : 0;
    return server;
  }

  bindClientConnect(
    server: BunWebSocketServerType<customWebsocketDataType> | undefined,
    /**
     * Called for each connection to this gateway's route and port, with the client and
     * the server it arrived on (`undefined` only when the adapter has no server
     * at all). The client's `emit` is installed by then, so it may be treated
     * as a {@link BunNestWebSocketClient}; the parameter is declared as the
     * wider `WebSocketClient` because TypeScript checks a callback parameter
     * strictly, so a narrower one would reject every subclass override that
     * declares `WebSocketClient` (as NestJS custom adapters commonly do).
     */
    callback: (
      client: WebSocketClient<customWebsocketDataType>,
      server: BunWebSocketServerType<customWebsocketDataType> | undefined,
    ) => void,
  ) {
    // The route of *this* gateway: the one its `create()` call just named, or
    // — when NestJS reused an existing server and skipped `create()` — the
    // route that server was created for. Never a previous gateway's namespace.
    const route =
      this._pendingConnectRoute ?? this.routeForServer(server) ?? "/";
    this._pendingConnectRoute = undefined;
    // Likewise its port: the one `create()` was given, else the server's.
    const port = this._pendingConnectPort ?? this.portForServer(server);
    this._pendingConnectPort = undefined;

    const listener = (client: WebSocketClient<customWebsocketDataType>) => {
      // A client of another path or another server is not this gateway's:
      // NestJS binds its message and disconnect hooks from this callback, so
      // skipping it skips them all.
      if (
        !this.connectionMatchesRoute(client, route) ||
        !this.connectionMatchesPort(client, port)
      ) {
        return;
      }
      callback(this.installEmit(client), server || this.getServer());
    };
    this.on("connect", listener);
    this._bindings.push({ server, listener });
  }

  /** The route the most recent server-creating `create()` registered for `server`. */
  private routeForServer(
    server: BunWebSocketServerType<customWebsocketDataType> | undefined,
  ): string | undefined {
    const routes = this._serverRoutes
      .filter((entry) => this.isSameServer(entry.server, server))
      .map((entry) => entry.route);
    if (routes.length === 0) {
      return undefined;
    }
    // One port serving several `path`s hands every gateway the same server
    // handle, so a reusing gateway cannot say which path it shares. The
    // default path is the common case; otherwise the latest wins.
    return new Set(routes).size > 1 && routes.includes("/")
      ? "/"
      : routes.at(-1);
  }

  bindClientDisconnect(
    client: WebSocketClient<customWebsocketDataType>,
    /** Called once, when `client` disconnects, with the close code and reason. */
    callback: (
      client: WebSocketClient<customWebsocketDataType>,
      code: number,
      reason: string,
    ) => void,
  ) {
    // `disconnect` is a shared event; only react to *this* client's disconnect
    // (NestJS binds the hook per connection), then detach to avoid leaking a
    // listener per connection.
    const onDisconnect = (
      sentWsClient: WebSocketClient<customWebsocketDataType>,
      code: number,
      reason: string,
    ) => {
      if (sentWsClient && sentWsClient !== client) {
        return;
      }
      callback(sentWsClient || client, code, reason);
      this.off("disconnect", onDisconnect);
    };
    this.on("disconnect", onDisconnect);
  }

  /** An `EVENT` packet, or a `BINARY_EVENT` when any argument is binary. */
  private eventPacket<TEvent extends string, TArgs extends unknown[]>(
    namespace: string,
    event: TEvent,
    args: TArgs,
  ): MessageEventType<TEvent, TArgs> | MessageBinaryEventType<TEvent, TArgs> {
    const { binary, encoded } = encodeArgs(args);
    // Which of the two depends on the values, not their types: a binary
    // argument's slot holds its base64 string either way.
    return binary.length > 0
      ? {
          type: MessageEventTypes.BINARY_EVENT,
          namespace,
          data: [event, ...encoded],
          binary,
        }
      : {
          type: MessageEventTypes.EVENT,
          namespace,
          data: [event, ...(encoded as unknown[] as TArgs)],
        };
  }

  /** An `ACK` packet, or a `BINARY_ACK` when any argument is binary. */
  private ackPacket<TArgs extends unknown[]>(
    namespace: string,
    id: string | number,
    args: TArgs,
  ): MessageAckType<TArgs> | MessageBinaryAckType<TArgs> {
    const { binary, encoded } = encodeArgs(args);
    return binary.length > 0
      ? {
          type: MessageEventTypes.BINARY_ACK,
          id,
          namespace,
          data: encoded,
          binary,
        }
      : {
          type: MessageEventTypes.ACK,
          id,
          namespace,
          data: encoded as unknown[] as TArgs,
        };
  }

  /**
   * Sends whatever a gateway handler emitted back to the client, as
   * `@nestjs/platform-socket.io`'s `IoAdapter` does: `undefined`/`null` is
   * dropped; a {@link WsResponse} (a truthy `event`) is re-encoded as an
   * `EVENT` packet (a `BINARY_EVENT` when `data` is binary); any other value
   * is passed to `autoAck` — which the caller supplies only when the packet
   * asked for an ack and the handler does not handle it manually — and
   * otherwise ignored.
   */
  private sendHandlerResponse(
    client: WebSocketClient<customWebsocketDataType>,
    namespace: string,
    response: unknown,
    autoAck?: WsAckFunction,
  ) {
    if (isUndefined(response) || isNull(response)) {
      return;
    }

    // `IoAdapter` tests `response.event` for truthiness, so `{ event: "" }`
    // is an ack value rather than an event.
    if (isObject(response) && (response as Partial<WsResponse>).event) {
      const { event, data } = response as WsResponse;
      client.send(
        JSON.stringify(this.eventPacket(namespace, String(event), [data])),
      );
      return;
    }

    autoAck?.(response);
  }

  /** Encodes and sends an `ERROR` packet for a failed handler/parse. */
  private sendError(
    client: WebSocketClient<customWebsocketDataType>,
    namespace: string,
    error: unknown,
  ) {
    const packet: MessageErrorType = {
      type: MessageEventTypes.ERROR,
      namespace,
      data: error instanceof Error ? error.message : String(error),
    };
    client.send(JSON.stringify(packet));
  }

  /**
   * Invokes one handler and streams its result back to the client. NestJS's
   * `WebSocketsController` pre-binds the connected socket as the handler's
   * first argument, so we pass the payload as the sole call argument. The
   * `transform` (supplied by NestJS) normalises any value/Promise/Observable
   * into an `Observable`; without it (the adapter used standalone) we still
   * handle Promises and Observables ourselves.
   *
   * `ack` is always passed to the handler (so `@Ack()` resolves to it), but
   * emissions auto-ack through it only when `handler.isAckHandledManually` is
   * falsy — NestJS sets it for a handler declaring `@Ack()`.
   */
  private invokeHandler(
    handler: WsMessageHandler<string>,
    payload: unknown,
    client: WebSocketClient<customWebsocketDataType>,
    namespace: string,
    transform?: WsResponseTransform,
    ack?: WsAckFunction,
  ) {
    const autoAck = handler.isAckHandledManually ? undefined : ack;
    const onNext = (response: unknown) =>
      this.sendHandlerResponse(client, namespace, response, autoAck);
    const onError = (error: unknown) =>
      this.sendError(client, namespace, error);

    try {
      // Pass the payload as the call argument (NestJS pre-binds the socket as
      // arg 0 → `@ConnectedSocket`, so payload lands at arg 1 → `@MessageBody`);
      // an `ack` becomes the first function arg → `@Ack`.
      const result = ack
        ? handler.callback(payload, ack)
        : handler.callback(payload);

      if (transform) {
        transform(result).subscribe({ next: onNext, error: onError });
        return;
      }

      if (isObject(result) && isFunction((result as { then?: unknown }).then)) {
        (result as Promise<unknown>).then(onNext, onError);
        return;
      }

      if (
        isObject(result) &&
        isFunction((result as { subscribe?: unknown }).subscribe)
      ) {
        (result as Observable<unknown>).subscribe({
          next: onNext,
          error: onError,
        });
        return;
      }

      onNext(result);
    } catch (error) {
      onError(error);
    }
  }

  /**
   * Dispatches a decoded packet to every handler subscribed to `eventName`
   * (an `@SubscribeMessage(eventName)` method). Returns whether any handler
   * matched, so the caller can fall through to catch-all handlers otherwise.
   */
  private dispatchToHandlers(
    handlers: WsMessageHandler<string>[],
    eventName: string,
    payload: unknown,
    client: WebSocketClient<customWebsocketDataType>,
    namespace: string,
    transform?: WsResponseTransform,
    ack?: WsAckFunction,
  ): boolean {
    const matched = handlers.filter((handler) => handler.message === eventName);
    matched.forEach((handler) => {
      this.invokeHandler(handler, payload, client, namespace, transform, ack);
    });
    return matched.length > 0;
  }

  bindMessageHandlers(
    client: WebSocketClient<customWebsocketDataType>,
    handlers: WsMessageHandler<string>[],
    transform?: WsResponseTransform,
  ) {
    this.installEmit(client);

    const messageHandler: BunWebsocketHandlerFor<
      "message",
      customWebsocketDataType
    > = (sender, data) => {
      // `message` is a shared event across all connections; only handle frames
      // from the exact client these handlers were bound to (NestJS binds
      // handlers per connection), so one client never runs another's handlers.
      if (sender && sender !== client) {
        return;
      }
      const wsClient = sender || client;
      let namespace = "/";

      try {
        const parsedData = JSON.parse(
          (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("utf-8"),
        ) as MessageFormat;
        const type = parsedData.type;
        namespace = parsedData.namespace || "/";
        let handled = true;

        switch (type) {
          case MessageEventTypes.ACK:
          case MessageEventTypes.BINARY_ACK: {
            wsClient.send(JSON.stringify(parsedData));
            break;
          }

          case MessageEventTypes.EVENT:
          case MessageEventTypes.BINARY_EVENT: {
            const eventName = isArray(parsedData.data)
              ? parsedData.data[0]
              : undefined;
            if (isUndefined(eventName)) {
              handled = false;
              break;
            }

            // A BINARY_EVENT's binary arguments are base64: decode each one
            // it marks back to the exact bytes, then map the arguments to a
            // payload as socket.io does.
            const args = parsedData.data.slice(1);
            const eventData = argsToPayload(
              type === MessageEventTypes.EVENT
                ? args
                : decodeArgs(
                    args,
                    "binary" in parsedData ? parsedData.binary : undefined,
                  ),
            );

            // socket.io-style event packets may carry an ack `id`; when present
            // expose an ack callback that replies with an ACK of the same id.
            // One callback per packet, shared by every matching handler and
            // the automatic ack, and — like socket.io's `Socket.ack(id)` —
            // it sends only on its first call.
            const ackId = parsedData.id;
            let ackSent = false;
            const ack: WsAckFunction | undefined = isUndefined(ackId)
              ? undefined
              : (...ackData) => {
                  if (ackSent) {
                    return;
                  }
                  wsClient.send(
                    JSON.stringify(this.ackPacket(namespace, ackId, ackData)),
                  );
                  ackSent = true;
                };

            this.dispatchToHandlers(
              handlers,
              String(eventName),
              eventData,
              wsClient,
              namespace,
              transform,
              ack,
            );
            break;
          }

          case MessageEventTypes.CONNECT: {
            // A namespace-level connect packet — route to a gateway's
            // `@SubscribeMessage("connect")` handler if present.
            this.dispatchToHandlers(
              handlers,
              "connect",
              undefined,
              wsClient,
              namespace,
              transform,
            );
            break;
          }

          case MessageEventTypes.DISCONNECT: {
            this.dispatchToHandlers(
              handlers,
              "disconnect",
              undefined,
              wsClient,
              namespace,
              transform,
            );
            break;
          }

          case MessageEventTypes.ERROR: {
            this.dispatchToHandlers(
              handlers,
              "error",
              parsedData.data,
              wsClient,
              namespace,
              transform,
            );
            break;
          }

          default: {
            handled = false;
          }
        }

        if (handled) {
          return;
        }
      } catch (e) {
        // A malformed/unparseable packet — notify any "error" handler and the
        // client, then fall through to the catch-all handlers below.
        this.dispatchToHandlers(
          handlers,
          "error",
          e,
          wsClient,
          namespace,
          transform,
        );
        this.sendError(wsClient, namespace, e);
      }

      const handlersForEvent = handlers.filter(
        (handler) => !handler.message || handler.message === "events",
      );
      handlersForEvent.forEach((handler) => {
        this.invokeHandler(handler, data, wsClient, namespace, transform);
      });
    };

    this.on("message", messageHandler);
    // Detach this client's message handler when (and only when) it disconnects,
    // and remove the disconnect listener itself so nothing leaks per connection.
    const onDisconnect = (
      disconnectedClient?: WebSocketClient<customWebsocketDataType>,
    ) => {
      if (disconnectedClient && disconnectedClient !== client) {
        return;
      }
      this.off("message", messageHandler);
      this.off("disconnect", onDisconnect);
    };
    this.on("disconnect", onDisconnect);
  }

  /**
   * Closes the WebSocket side of `server` (default: {@link getServer}), as
   * `@nestjs/platform-ws` closes its `ws` server:
   *
   * - gateways bound to that server stop receiving connections;
   * - a server this adapter owns — a gateway port's, or its own under
   *   `newInstance: true` — is stopped, force-closing its connections;
   * - the HTTP adapter's shared server is **not** stopped (that is the HTTP
   *   adapter's job, e.g. on `app.close()`); instead the adapter closes the
   *   WebSocket connections it holds, with code `1001`.
   */
  close(server: BunWebSocketServerType<customWebsocketDataType> | undefined) {
    const target = server ?? this.getServer();

    this._bindings = this._bindings.filter((binding) => {
      if (!this.isSameServer(binding.server, target)) {
        return true;
      }
      this.off("connect", binding.listener);
      return false;
    });

    if (this.isSharedServer(target)) {
      for (const client of [...this._clients]) {
        this._clients.delete(client);
        client.close(1001, "Server closing");
      }
      return this;
    }

    if (!target) {
      return this;
    }

    try {
      target.stop(true);
    } catch {
      // Already stopped.
    }

    if (
      this._dedicatedServers.has(target) ||
      (this._ownsServer && target === this.getServer())
    ) {
      this._dedicatedServers.delete(target);
      // Drops it from the base class's port cache (it is known to be cached,
      // so this never binds a new server).
      this.killServer(target);
    }

    return this;
  }

  /**
   * Lifecycle hook invoked by NestJS's `SocketModule` during shutdown (after
   * `close()`), mirroring `AbstractWsAdapter.dispose()`. A no-op here: server
   * teardown is handled by `close()` / the owning HTTP adapter, but the method
   * must exist or `SocketModule.close()` throws.
   */
  dispose() {
    // Intentionally empty — see method doc.
  }
}

/**
 * Turns the adapter's accepted option shapes into {@link BunWebSocket}'s.
 * Fields in `localOptions` (or the normal shape) win; `router` defaults to
 * `httpAdapter.instance`, and the server comes from — in order — `newInstance:
 * true` + `listen`, `newInstance: false` + `getServer`, or `httpAdapter`.
 */
function resolveAdapterOptions<
  customWebsocketDataType,
  routesType extends string,
>(
  options: BunWebSocketAdapterOptions<customWebsocketDataType, routesType>,
): BunWebSocketOptions<customWebsocketDataType> {
  const httpAdapter = options.httpAdapter;
  const local = "newInstance" in options ? options : options.localOptions;
  const router = local?.router ?? httpAdapter?.instance;
  const wsOptions = local?.wsOptions;
  // Both forwarded as given: `BunWebSocket` resolves them (`onUpgrade` wins,
  // with a warning, when both are set).
  const onUpgrade = local?.onUpgrade;
  const customDataToWsClientFn = local?.customDataToWsClientFn;

  if (local?.newInstance === true) {
    return {
      newInstance: true,
      listen: local.listen,
      // Every other `BunWebSocketCreateServerOptions` field is forwarded by
      // name: one left out here is silently ignored.
      responseTimeout: local.responseTimeout,
      serverOptions: local.serverOptions,
      request: local.request,
      response: local.response,
      bunRequestOpts: local.bunRequestOpts,
      wsOptions,
      // When no router is supplied, fall back to the HTTP adapter's router so
      // a NestJS-driven `newInstance` adapter can still register its upgrade
      // routes (and reach the app's middleware).
      router,
      onUpgrade,
      customDataToWsClientFn,
    } satisfies BunWebSocketCreateServerOptions<
      customWebsocketDataType,
      routesType
    > as BunWebSocketOptions<customWebsocketDataType>;
  }

  if (local?.newInstance === false && isFunction(local.getServer)) {
    return {
      newInstance: false,
      getServer: local.getServer,
      wsOptions,
      router,
      onUpgrade,
      customDataToWsClientFn,
    } satisfies BunWebSocketNormalOptions<customWebsocketDataType>;
  }

  if (httpAdapter) {
    return {
      newInstance: false,
      getServer: () => httpAdapter.getBunServer(),
      wsOptions,
      router,
      onUpgrade,
      customDataToWsClientFn,
    } satisfies BunWebSocketNormalOptions<customWebsocketDataType>;
  }

  throw new Error(
    "BunWebSocketAdapter needs a server: pass `httpAdapter`, `{ newInstance: false, getServer }`, or `{ newInstance: true, listen: { port } }`.",
  );
}

export class BunNestWebsocketAdapter<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> extends BunWebSocketAdapter<customWebsocketDataType, routesType> {}

export type {
  BunWebsocketHandlerFor,
  BunWebSocketOptions,
  BunWebSocketServerType,
  WebSocketClient,
  WebSocketClientData,
} from "@kingsleyweb/bun-common";
