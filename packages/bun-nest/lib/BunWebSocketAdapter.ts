import { Buffer } from "node:buffer";
import type { WebSocketAdapter, WsMessageHandler } from "@nestjs/common";
import type { Server, ServerWebSocket } from "bun";
import { isArray, isUndefined } from "lodash-es";
import {
  BunWebSocket,
  type BunWebSocketOptions,
  type BunWebsocketHandlerFor,
} from "@kingsleyweb/bun-common";
import type { BunHttpAdapter } from "./BunHttpAdapter";

export interface WebSocketClientData {
  path: string;
  headers: Headers;
  user?: Record<string, unknown>;
  [string: string]: unknown;
}

export type WebSocketClient = ServerWebSocket<WebSocketClientData>;

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

export class BunWebSocketAdapter
  extends BunWebSocket
  implements
    WebSocketAdapter<
      Server | undefined,
      ServerWebSocket,
      {
        attachUpgrade?: boolean;
      }
    >
{
  constructor(
    private httpAdapter: BunHttpAdapter,
    localOptions?: BunWebSocketOptions | undefined,
  ) {
    const newInstance = localOptions?.newInstance || false;
    const getServer = () => {
      const newInstance = localOptions?.newInstance || false;
      if (newInstance) {
        return this.getServer();
      }

      return httpAdapter.getBunServer();
    };

    const superOptions = {
      ...(localOptions || {}),
      newInstance,
      getServer,
      router: httpAdapter.instance,
    } as unknown as BunWebSocketOptions;

    super(superOptions);
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
  ): Server | undefined {
    if (Bun.env.NODE_ENV !== "production") {
      console.log("called websocket create adapter with the following ====> ", {
        port,
        options,
      });
    }

    this.httpAdapter.instance.ws(
      options?.namespace ? options.namespace : "/*",
      this.wsHandler,
    );
    const server = this.getOrCreateWebsocketServer(port);
    return server;
  }

  bindClientConnect(
    server: Server | undefined,
    callback: (client: ServerWebSocket, server?: Server) => unknown,
  ) {
    this.on("connect", (client: ServerWebSocket) => {
      callback(client, server || this.getServer());
    });
  }

  bindClientDisconnect(
    client: ServerWebSocket,
    callback: (client: ServerWebSocket) => unknown,
  ) {
    this.on("disconnect", (sentWsClient: ServerWebSocket) => {
      callback(sentWsClient || client);
    });
  }

  private buildMessage(obj: MessageFormat): string {
    if (obj.type === MessageEventTypes.BINARY_EVENT) {
      obj.data[1] = btoa(Buffer.from(String(obj.data[1])).toString("utf-8"));
    }

    return JSON.stringify(obj);
  }

  bindMessageHandlers(
    client: ServerWebSocket,
    handlers: WsMessageHandler<string>[],
  ) {
    const messageHandler: BunWebsocketHandlerFor<"message"> = (
      wsClient,
      data,
    ) => {
      wsClient = wsClient || client;

      try {
        const parsedData = JSON.parse(
          Buffer.from(data).toString("utf-8"),
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

            const eventData = MessageEventTypes.EVENT
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
        //
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

  close(server: Server | undefined) {
    return this.killServer(server || this.getServer());
  }
}
