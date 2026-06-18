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
  isUndefined,
} from "@kingsleyweb/bun-common";

/**
 * The shape a NestJS gateway handler may return to push a message back to the
 * client (mirrors `@nestjs/websockets`' `WsResponse`). A handler can also
 * return a bare value, a `Promise`, or an `Observable` of these — all are
 * normalised through the `transform` supplied by NestJS.
 */
export interface WsResponse<T = unknown> {
  event: string;
  data: T;
}

/**
 * NestJS hands `bindMessageHandlers` a `transform` that wraps a handler's
 * return value (value | Promise | Observable) into an `Observable`, so the
 * adapter can subscribe and stream every emission back to the client.
 */
export type WsResponseTransform = (data: unknown) => Observable<unknown>;

/**
 * Acknowledgement callback handed to a gateway handler when an `EVENT` packet
 * carries an ack `id`. NestJS's `WsParamsFactory` resolves `@Ack()` to the
 * first function argument, so passing this satisfies that convention; calling
 * it sends an `ACK` packet (same `id`) back to the client.
 */
export type WsAckFunction = (...args: unknown[]) => void;

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
  type: MessageEventTypes.CONNECT;
  namespace: string;
}

export interface MessageDisConnectType {
  type: MessageEventTypes.DISCONNECT;
  namespace: string;
}

export interface MessageEventType {
  type: MessageEventTypes.EVENT;
  namespace: string;
  data: [eventName: string, eventData: string];
}

export interface MessageBinaryEventType {
  type: MessageEventTypes.BINARY_EVENT;
  namespace: string;
  data: [
    eventName: string,
    eventData: Buffer | string | Record<string, unknown> | unknown[] | unknown,
  ];
}

export interface MessageAckType {
  type: MessageEventTypes.ACK;
  namespace: string;
  id: string | number;
  data: [eventName: string];
}

export interface MessageErrorType {
  type: MessageEventTypes.ERROR;
  namespace: string;
  data: string;
}

export interface MessageBinaryAckType {
  type: MessageEventTypes.BINARY_ACK;
  namespace: string;
  id: string | number;
  data: [eventName: string];
}

export type MessageFormat =
  | MessageConnectType
  | MessageDisConnectType
  | MessageEventType
  | MessageBinaryEventType
  | MessageAckType
  | MessageErrorType
  | MessageBinaryAckType;

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
  httpAdapter: BunWebsocketHttpAdapter<customWebsocketDataType, routesType>;
  localOptions?: BunWebSocketOptions<customWebsocketDataType, routesType>;
}

export type BunWebSocketAdapterNormalOptions<
  customWebsocketDataType = unknown,
  routesType extends string = never,
> = BunWebSocketOptions<customWebsocketDataType, routesType> & {
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

export class BunWebSocketAdapter<
    customWebsocketDataType = unknown,
    routesType extends string = never,
  >
  extends BunWebSocket<customWebsocketDataType>
  implements
    WebSocketAdapter<
      BunWebSocketServerType<customWebsocketDataType> | undefined,
      WebSocketClient,
      {
        attachUpgrade?: boolean;
      }
    >
{
  constructor(
    options: BunWebSocketAdapterOptions<customWebsocketDataType, routesType>,
  ) {
    const localOptions =
      "localOptions" in options
        ? options.localOptions
        : "newInstance" in options
          ? options
          : undefined;

    if (options.httpAdapter) {
      super({
        newInstance: false,
        wsOptions: localOptions?.wsOptions,
        router: options.httpAdapter.instance,
        customDataToWsClientFn: localOptions?.customDataToWsClientFn,
        getServer() {
          return options.httpAdapter?.getBunServer();
        },
      } satisfies BunWebSocketNormalOptions<customWebsocketDataType>);
    } else {
      const createOptions =
        "newInstance" in options && options.newInstance ? options : undefined;
      super({
        newInstance: true,
        listen: createOptions?.listen ?? {
          port: 7817,
        },
        serverOptions: createOptions?.serverOptions,
        request: createOptions?.request,
        response: createOptions?.response,
        bunRequestOpts: createOptions?.bunRequestOpts,
        wsOptions: localOptions?.wsOptions,
        router: localOptions?.router,
        customDataToWsClientFn: localOptions?.customDataToWsClientFn,
      } satisfies BunWebSocketCreateServerOptions<
        customWebsocketDataType,
        routesType
      >);
    }
  }

  /**
   * The namespace of the gateway currently being wired. NestJS calls
   * `create()` immediately before `bindClientConnect()` (synchronously, per
   * gateway), so this carries the namespace from one to the other. A gateway's
   * connect/message handlers fire only for clients connected to this namespace
   * — matching socket.io / NestJS per-namespace isolation. `"/*"` is a wildcard
   * (used by the dependency-free adapter usage) that matches every path.
   */
  private _pendingConnectNamespace = "/";

  /** Normalises a `@WebSocketGateway` namespace; absent → the default `"/"`. */
  private resolveNamespace(namespace?: string): string {
    return namespace && namespace.length > 0 ? namespace : "/";
  }

  /** Whether `client` (by its connect path) belongs to `namespace`. */
  private connectionMatchesNamespace(
    client: WebSocketClient<customWebsocketDataType>,
    namespace: string,
  ): boolean {
    if (namespace === "/*" || namespace === "*") {
      return true;
    }
    return (client?.data?.path ?? "/") === namespace;
  }

  // @ts-expect-error - NestJS's `create` options type is narrower than ours
  create(
    port: number,
    options?: {
      namespace?: string;
      transport: string[];
      [key: string]: unknown;
    },
  ): BunWebSocketServerType<customWebsocketDataType> | undefined {
    // Register the upgrade route at the gateway's namespace path (default "/").
    // A connection whose path matches no gateway's namespace therefore matches
    // no ws route and the upgrade is refused with a 404 — socket.io's "invalid
    // namespace" rejection, handled cleanly at the HTTP layer rather than by
    // opening then closing the socket. Pass `"/*"` to accept every path.
    const namespace = this.resolveNamespace(options?.namespace);
    this.router.ws(namespace, this.wsHandler);
    // Remember the namespace for the `bindClientConnect` call that follows.
    this._pendingConnectNamespace = namespace;
    const server = this.getOrCreateWebsocketServer(port);
    return server;
  }

  bindClientConnect(
    server: BunWebSocketServerType<customWebsocketDataType> | undefined,
    callback: (
      client: WebSocketClient<customWebsocketDataType>,
      server?: BunWebSocketServerType<customWebsocketDataType>,
    ) => unknown,
  ) {
    // Capture the namespace this gateway was created for; only clients that
    // connected to that namespace (path) trigger its connection handler.
    const namespace = this._pendingConnectNamespace;
    this.on("connect", (client: WebSocketClient<customWebsocketDataType>) => {
      if (!this.connectionMatchesNamespace(client, namespace)) {
        return;
      }
      callback(client, server || this.getServer());
    });
  }

  bindClientDisconnect(
    client: WebSocketClient<customWebsocketDataType>,
    callback: (
      client: WebSocketClient<customWebsocketDataType>,
      code: number,
      reason: string,
    ) => unknown,
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

  private buildMessage(obj: MessageFormat): string {
    if (obj.type === MessageEventTypes.BINARY_EVENT) {
      obj.data[1] = btoa(Buffer.from(String(obj.data[1])).toString("utf-8"));
    }

    return JSON.stringify(obj);
  }

  /**
   * Sends whatever a gateway handler emitted back to the client. A
   * {@link WsResponse} (`{ event, data }`) is re-encoded as an `EVENT` packet;
   * `undefined`/`null` (a handler that returns nothing) is ignored.
   */
  private sendHandlerResponse(
    client: WebSocketClient,
    namespace: string,
    response: unknown,
  ) {
    if (isUndefined(response) || isNull(response)) {
      return;
    }

    if (isObject(response) && "event" in response) {
      const { event, data } = response as WsResponse;
      client.send(
        this.buildMessage({
          type: MessageEventTypes.EVENT,
          namespace,
          data: [String(event), data as string],
        }),
      );
    }
  }

  /** Encodes and sends an `ERROR` packet for a failed handler/parse. */
  private sendError(
    client: WebSocketClient,
    namespace: string,
    error: unknown,
  ) {
    client.send(
      this.buildMessage({
        type: MessageEventTypes.ERROR,
        namespace,
        data: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * Invokes one handler and streams its result back to the client. NestJS's
   * `WebSocketsController` pre-binds the connected socket as the handler's
   * first argument, so we pass the payload as the sole call argument. The
   * `transform` (supplied by NestJS) normalises any value/Promise/Observable
   * into an `Observable`; without it (the adapter used standalone) we still
   * handle Promises and Observables ourselves.
   */
  private invokeHandler(
    handler: WsMessageHandler<string>,
    payload: unknown,
    client: WebSocketClient,
    namespace: string,
    transform?: WsResponseTransform,
    ack?: WsAckFunction,
  ) {
    const onNext = (response: unknown) =>
      this.sendHandlerResponse(client, namespace, response);
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
    client: WebSocketClient,
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
    const messageHandler: BunWebsocketHandlerFor<"message"> = (
      sender,
      data,
    ) => {
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
            wsClient.send(
              this.buildMessage({
                type,
                id: parsedData.id,
                namespace: parsedData.namespace,
                data: parsedData.data,
              }),
            );

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

            const eventData =
              type === MessageEventTypes.EVENT
                ? parsedData.data[1]
                : Buffer.from(atob(String(parsedData.data[1])));

            // socket.io-style EVENT packets may carry an ack `id`; when present
            // expose an ack callback that replies with an `ACK` of the same id.
            const ackId = (parsedData as { id?: string | number }).id;
            const ack: WsAckFunction | undefined = isUndefined(ackId)
              ? undefined
              : (...ackData) =>
                  wsClient.send(
                    this.buildMessage({
                      type: MessageEventTypes.ACK,
                      id: ackId,
                      namespace,
                      data: ackData as [string],
                    }),
                  );

            this.dispatchToHandlers(
              handlers,
              eventName,
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

  close(server: BunWebSocketServerType<customWebsocketDataType> | undefined) {
    return this.killServer(server || this.getServer());
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
