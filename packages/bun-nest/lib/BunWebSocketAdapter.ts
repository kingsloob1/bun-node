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
import { Buffer } from "node:buffer";
import { BunWebSocket, isArray, isUndefined } from "@kingsleyweb/bun-common";

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

  // eslint-disable-next-line ts/ban-ts-comment
  // @ts-expect-error
  create(
    port: number,
    options?: {
      namespace?: string;
      transport: string[];
      [key: string]: unknown;
    },
  ): BunWebSocketServerType<customWebsocketDataType> | undefined {
    this.router.ws(
      options?.namespace ? options.namespace : "/*",
      this.wsHandler,
    );
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
    this.on("connect", (client: WebSocketClient<customWebsocketDataType>) => {
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
    this.on(
      "disconnect",
      (
        sentWsClient: WebSocketClient<customWebsocketDataType>,
        code,
        reason,
      ) => {
        callback(sentWsClient || client, code, reason);
      },
    );
  }

  private buildMessage(obj: MessageFormat): string {
    if (obj.type === MessageEventTypes.BINARY_EVENT) {
      obj.data[1] = btoa(Buffer.from(String(obj.data[1])).toString("utf-8"));
    }

    return JSON.stringify(obj);
  }

  bindMessageHandlers(
    client: WebSocketClient<customWebsocketDataType>,
    handlers: WsMessageHandler<string>[],
  ) {
    const messageHandler: BunWebsocketHandlerFor<"message"> = (
      wsClient,
      data,
    ) => {
      wsClient = wsClient || client;

      try {
        const parsedData = JSON.parse(
          (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("utf-8"),
        ) as MessageFormat;
        const type = parsedData.type;
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
            const handlersForEvent = handlers.filter(
              (handler) => handler.message === eventName,
            );
            handlersForEvent.forEach((handler) => {
              handler.callback(eventData);
            });
            break;
          }

          case MessageEventTypes.CONNECT:
          case MessageEventTypes.DISCONNECT:
          case MessageEventTypes.ERROR: {
            // To-Do Add handlers for other event types
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
        console.error(
          "An error occurred in bun-nest websocket message adapter ====> ",
          e,
        );
      }

      const handlersForEvent = handlers.filter(
        (handler) => !handler.message || handler.message === "events",
      );
      handlersForEvent.forEach((handler) => {
        handler.callback(wsClient, data);
      });
    };

    this.on("message", messageHandler);
    this.on("disconnect", () => {
      this.off("message", messageHandler);
    });
  }

  close(server: BunWebSocketServerType<customWebsocketDataType> | undefined) {
    return this.killServer(server || this.getServer());
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
