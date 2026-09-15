/**
 * Compile-time assertions for the Nest adapters' generics and overloads: the
 * custom client data a `BunHttpAdapter<Session>` declares reaching gateway
 * callbacks, `listen()`'s two forms, packet types keyed by `MessageEventTypes`,
 * and compatibility with NestJS's own adapter interfaces. Checked by `tsc`,
 * not `bun test`.
 */
import type {
  BunWebSocketServerType,
  WebSocketClient,
} from "@kingsleyweb/bun-common";
import type { WebSocketAdapter, WsMessageHandler } from "@nestjs/common";
import type { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter";
import type { Observable } from "rxjs";
import type {
  MiddlewareFactoryRespType,
  RenderOptions,
} from "../lib/BunHttpAdapter";
import type {
  BunNestWebSocketClient,
  BunWebSocketGatewayOptions,
  MessageAckType,
  MessageBinaryAckType,
  MessageFormat,
  MessagePacket,
  WsAckFunction,
  WsEncodedArgs,
} from "../lib/BunWebSocketAdapter";
import { Buffer } from "node:buffer";
import { RequestMethod } from "@nestjs/common";
import { BunHttpAdapter, BunNestHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunNestWebsocketAdapter,
  MessageEventTypes,
} from "../lib/BunWebSocketAdapter";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/** What `customDataToWsClientFn` puts on `client.data.custom`. */
interface Session {
  /** The room the client joined. */
  room: string;
}

type Server = BunWebSocketServerType<Session>;

const http = new BunHttpAdapter<Session>(0, {
  websocket: {
    newInstance: false,
    customDataToWsClientFn: (): Session => ({ room: "lobby" }),
  },
});
const ws = http.webSocketAdapter;

// --- NestJS interface compatibility ----------------------------------------

const _abstract: AbstractHttpAdapter<Server> = http;
const _wsAdapter: WebSocketAdapter<
  Server | undefined,
  WebSocketClient<Session>,
  BunWebSocketGatewayOptions<Session>
> = ws;

// --- listen(): both overloads, callback typed with the server ---------------

const _listened = http.listen(0, (_server) => {
  type _ = Expect<Equal<typeof _server, Server>>;
});
// `undefined` when binding failed and an `error` listener received the error
// (as NestJS's `app.listen()` attaches one).
type _listenResult = Expect<
  Equal<typeof _listened, Promise<Server | undefined>>
>;

// --- BunNestHttpAdapter passes both generics on ----------------------------

type _nestCtor = Expect<
  Equal<
    ConstructorParameters<typeof BunNestHttpAdapter<Session, "/health">>,
    ConstructorParameters<typeof BunHttpAdapter<Session, "/health">>
  >
>;
const _nestHttp: BunHttpAdapter<Session, "/health"> = new BunNestHttpAdapter<
  Session,
  "/health"
>();

// --- render(): the handler's result, typed ----------------------------------

type _renderOptions = Expect<
  Equal<Parameters<typeof http.render>[2], RenderOptions | null | undefined>
>;
http.render({} as Parameters<typeof http.render>[0], "view.html", {
  // @ts-expect-error a status is a number
  status: "200",
});

void http.listen("3000", "127.0.0.1", (_server) => {
  type _ = Expect<Equal<typeof _server, Server>>;
});

// NestJS's `app.listen()` passes a no-argument callback.
void http.listen(0, () => undefined);

// @ts-expect-error the hostname is a string, not a number
void http.listen(0, 42);

void http.setTimeout(1000, (_server) => {
  type _ = Expect<Equal<typeof _server, Server>>;
});

// --- createMiddlewareFactory(): returns the adapter itself ------------------

const _factory = http.createMiddlewareFactory(RequestMethod.GET);
type _factoryType = Expect<
  Equal<typeof _factory, MiddlewareFactoryRespType<BunHttpAdapter<Session>>>
>;
type _factoryReturn = Expect<
  Equal<ReturnType<typeof _factory>, BunHttpAdapter<Session>>
>;

// --- gateway callbacks carry the custom client data ------------------------

ws.bindClientConnect(undefined, (client, _server) => {
  type _client = Expect<Equal<typeof client, WebSocketClient<Session>>>;
  type _custom = Expect<Equal<typeof client.data.custom, Session>>;
  type _serverType = Expect<Equal<typeof _server, Server | undefined>>;

  ws.bindClientDisconnect(client, (gone, code, _reason) => {
    type _gone = Expect<Equal<typeof gone.data.custom, Session>>;
    type _code = Expect<Equal<typeof code, number>>;
    type _reasonType = Expect<Equal<typeof _reason, string>>;
  });

  const handlers: WsMessageHandler<string>[] = [];
  const transform = (data: unknown): Observable<unknown> =>
    data as Observable<unknown>;
  ws.bindMessageHandlers(client, handlers, transform);
});

// A subclass may still declare the wider `WebSocketClient` in its override
// (as examples/bun-nest/04-websockets/custom-adapter.ts does).
class _AuditedAdapter extends BunNestWebsocketAdapter {
  override bindClientConnect(
    server: BunWebSocketServerType | undefined,
    callback: (
      client: WebSocketClient,
      server?: BunWebSocketServerType,
    ) => unknown,
  ): void {
    super.bindClientConnect(server, (client, liveServer) => {
      type _ = Expect<Equal<typeof client, WebSocketClient>>;
      return callback(client, liveServer);
    });
  }
}

declare const stranger: WebSocketClient<{ other: true }>;
// @ts-expect-error a client of another data shape is not this adapter's
ws.bindMessageHandlers(stranger, []);

// --- create(): gateway options ---------------------------------------------

const created = ws.create(0, {
  namespace: "/chat",
  path: "/ws",
  cors: { origin: "*" },
});
type _created = Expect<Equal<typeof created, Server | undefined>>;
ws.create(0, { namespace: "/rooms", server: created });

// @ts-expect-error a gateway path is a string
ws.create(0, { path: 42 });

// --- emit() and ack with declared events ------------------------------------

/** The events this app emits to a client. */
interface ChatEvents {
  [event: string]: unknown[];
  /** A chat line. */
  message: [text: string];
  /** Someone is typing. */
  typing: [];
}

declare const chatClient: BunNestWebSocketClient<Session, ChatEvents>;
chatClient.emit("message", "hi");
chatClient.emit("typing");
// @ts-expect-error `message` carries a string
chatClient.emit("message", 1);

declare const ack: WsAckFunction<[status: "saved", id: number]>;
ack("saved", 1);
// @ts-expect-error the ack's tuple has two elements
ack("saved");

// --- packets keyed by MessageEventTypes ------------------------------------

type _ackPacket = Expect<
  Equal<MessagePacket<MessageEventTypes.ACK>, MessageAckType>
>;
type _eventData = Expect<
  Equal<
    MessagePacket<MessageEventTypes.EVENT, "chat", [{ text: string }]>["data"],
    [eventName: "chat", { text: string }]
  >
>;
type _binaryEventData = Expect<
  Equal<
    MessagePacket<
      MessageEventTypes.BINARY_EVENT,
      "upload",
      [Buffer, number]
    >["data"],
    [eventName: "upload", string, number]
  >
>;
type _binaryAckData = Expect<
  Equal<
    MessagePacket<MessageEventTypes.BINARY_ACK, string, [Uint8Array]>["data"],
    [string]
  >
>;
type _encodedUnknown = Expect<Equal<WsEncodedArgs<unknown[]>, unknown[]>>;
type _binaryPositions = Expect<
  Equal<
    MessagePacket<MessageEventTypes.BINARY_EVENT>["binary"],
    number[] | undefined
  >
>;

declare const incoming: MessageFormat;
if (incoming.type === MessageEventTypes.ACK) {
  type _ = Expect<Equal<typeof incoming, MessageAckType>>;
}

// @ts-expect-error an ACK needs the id of the event it answers
const _noId: MessagePacket<MessageEventTypes.ACK> = {
  type: MessageEventTypes.ACK,
  namespace: "/",
  data: [],
};

const _binaryAck: MessageBinaryAckType<[Buffer]> = {
  type: MessageEventTypes.BINARY_ACK,
  namespace: "/",
  id: 1,
  // @ts-expect-error binary arguments travel as base64 strings, not bytes
  data: [Buffer.from("x")],
};

export {};
