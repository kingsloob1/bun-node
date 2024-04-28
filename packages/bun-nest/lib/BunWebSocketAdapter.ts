import type { WebSocketAdapter, WsMessageHandler } from '@nestjs/common';
import {
  Observable,
  filter,
  first,
  fromEvent,
  map,
  mergeMap,
  share,
  takeUntil,
} from 'rxjs';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { BunHttpAdapter } from './BunHttpAdapter';
import { EventEmitter } from 'stream';
import { get, isArray, isFunction, isNil } from 'lodash-es';
import { DISCONNECT_EVENT } from '@nestjs/websockets/constants';

export class BunWebSocketAdapter
  extends EventEmitter
  implements
    WebSocketAdapter<
      Server | undefined,
      ServerWebSocket,
      {
        attachUpgrade?: boolean;
      }
    >
{
  public handlers!: WebSocketHandler;

  constructor(
    private httpAdapter: BunHttpAdapter,
    private options?: {
      host?: string;
      port?: number;
      attachUpgrade?: boolean;
    },
  ) {
    super();
    this.handlers = {
      open: (ws) => {
        this.emit('connect', ws);
      },
      message: (ws, message) => {
        this.emit('message', ws, message);
      },
      close: (ws) => {
        this.emit(DISCONNECT_EVENT, ws);
      },
    } as WebSocketHandler;
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  create(
    port: number,
    options?: {
      namespace?: string;
      transport: string[];
      [key: string]: unknown;
    },
  ): Server | undefined {
    const server = this.httpAdapter.getBunServer();
    if (server) {
      return server;
    }

    const host = (this.options?.host || options?.host) as unknown as string;
    const portToUse = this.options?.port || port;

    if (!this.httpAdapter.isListening) {
      this.httpAdapter.setListenOptions({
        hostname: host,
        port: portToUse as number,
      });

      return server;
    }

    return undefined;
  }

  bindClientConnect(
    server: Server | undefined,
    callback: (client: ServerWebSocket) => unknown,
  ) {
    this.on('connect', (client: ServerWebSocket) => {
      callback(client);
    });
  }

  bindClientDisconnect(client: ServerWebSocket, callback: () => unknown) {
    this.on('disconnect', callback);
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
        const event = get(response, 'event');
        if (response && event) {
          return this.emit(event, get(response, 'data', undefined));
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
