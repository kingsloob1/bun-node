import type { WebSocketAdapter, WsMessageHandler } from "@nestjs/common";
import type { Observable } from "rxjs";
import {
  filter,
  first,
  fromEvent,
  map,
  mergeMap,
  share,
  takeUntil,
} from "rxjs";
import type { Server, ServerWebSocket } from "bun";
import { get, isArray, isFunction, isNil } from "lodash-es";
import { DISCONNECT_EVENT } from "@nestjs/websockets/constants";
import {
  BunWebSocket,
  type BunWebSocketOptions,
} from "@kingsleyweb/bun-common";
import type { BunHttpAdapter } from "./BunHttpAdapter";

export interface WebSocketClientData {
  path: string;
  headers: Headers;
  user?: Record<string, unknown>;
  [string: string]: unknown;
}

export type WebSocketClient = ServerWebSocket<WebSocketClientData>;

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
    private localOptions?: BunWebSocketOptions | undefined,
  ) {
    const newInstance = localOptions?.newInstance || false;
    const getServer = async () => {
      if (localOptions?.newInstance) {
        return await this.getServer();
      }

      return await httpAdapter.getBunServer();
    };

    const superOptions = {
      ...(localOptions || {}),
      newInstance,
      getServer,
    } as unknown as BunWebSocketOptions;

    super(superOptions);
  }

  // eslint-disable-next-line ts/ban-ts-comment
  // @ts-expect-error
  async create(
    port: number,
    options?: {
      namespace?: string;
      transport: string[];
      [key: string]: unknown;
    },
  ): Promise<Server | undefined> {
    console.log("called websocket create with the following ====> ", {
      port,
      options,
    });

    const server = await this.getServer();
    if (server) {
      return server;
    }

    return undefined;
  }

  bindClientConnect(
    server: Server | undefined,
    callback: (client: ServerWebSocket) => unknown,
  ) {
    this.on("connect", (client: ServerWebSocket) => {
      callback(client);
    });
  }

  bindClientDisconnect(client: ServerWebSocket, callback: () => unknown) {
    this.on("disconnect", callback);
  }

  bindMessageHandlers(
    client: ServerWebSocket,
    handlers: WsMessageHandler<string>[],
    transform: (
      data: unknown | Promise<unknown> | Observable<unknown>,
    ) => Observable<unknown>,
  ) {
    const disconnect$ = fromEvent(this, DISCONNECT_EVENT).pipe(
      share(),
      first(),
    );

    handlers.forEach((handler) => {
      const source$ = fromEvent(this, handler.message).pipe(
        mergeMap((payload: any) => {
          const { data, ack } = this.mapPayload(payload);
          return transform(handler.callback(data, ack)).pipe(
            filter((response: unknown) => !isNil(response)),
            map((response: unknown) => [response, ack]),
          );
        }),
        takeUntil(disconnect$),
      );

      source$.subscribe(([response, ack]) => {
        const event = get(response, "event");
        if (response && event) {
          return this.emit(event, get(response, "data", undefined));
        }
        isFunction(ack) && ack(response);
      });
    });
  }

  close(server: Server | undefined) {
    if (server) {
      server.stop(false);
    }
  }

  protected mapPayload(payload: unknown): {
    data: any;
    ack?: Function;
  } {
    if (!isArray(payload)) {
      if (isFunction(payload)) {
        return { data: undefined, ack: payload as Function };
      }
      return { data: payload };
    }

    const lastElement = payload[payload.length - 1];
    const isAck = isFunction(lastElement);
    if (isAck) {
      const size = payload.length - 1;
      return {
        data: size === 1 ? payload[0] : payload.slice(0, size),
        ack: lastElement,
      };
    }
    return { data: payload };
  }
}
