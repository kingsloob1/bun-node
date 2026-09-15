/**
 * Compile-time assertions for `BunWebSocket`'s types.
 *
 * A caller's per-connection custom data type must reach `ws.data.custom` in
 * every handler and every emitter event, and each event must type its own
 * arguments. Checked by `bun scripts/typecheck.ts`, not by `bun test`; every
 * `@ts-expect-error` is a negative control that fails the build if the error
 * it expects ever disappears.
 */
import type {
  BunWebsocketHandlerFor,
  BunWebSocketHandlerType,
  BunWebSocketRouteEventRest,
  BunWebSocketServerType,
  WebSocketClient,
  WebSocketClientData,
} from "../lib/BunWebSocket";
import { BunWebSocket } from "../lib/BunWebSocket";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface Session {
  userId: string;
  roles: string[];
}

declare const ws: BunWebSocket<Session>;
declare const client: WebSocketClient<Session>;

/* --- custom data flows into the client types ----------------------- */

type _clientData = Expect<
  Equal<WebSocketClient<Session>["data"], WebSocketClientData<Session>>
>;
type _custom = Expect<Equal<WebSocketClientData<Session>["custom"], Session>>;
type _defaultCustom = Expect<Equal<WebSocketClientData["custom"], unknown>>;
// Optional: data built without a real server (a socket-free `fetch()`) has none.
type _port = Expect<
  Equal<WebSocketClientData<Session>["port"], number | undefined>
>;
type _server = Expect<
  Equal<
    ReturnType<BunWebSocket<Session>["getServer"]>,
    BunWebSocketServerType<Session> | undefined
  >
>;

/* --- emitter events type their arguments --------------------------- */

type MessagePayload = Parameters<BunWebsocketHandlerFor<"message", Session>>[1];

ws.on("message", (_socket, _message) => {
  type _socketType = Expect<Equal<typeof _socket, WebSocketClient<Session>>>;
  type _session = Expect<Equal<typeof _socket.data.custom, Session>>;
  type _messageType = Expect<Equal<typeof _message, MessagePayload>>;
});

ws.once("close", (_socket, _code, _reason) => {
  type _session = Expect<Equal<typeof _socket.data.custom, Session>>;
  type _codeType = Expect<Equal<typeof _code, number>>;
  type _reasonType = Expect<Equal<typeof _reason, string>>;
});

ws.on("connect", (_socket) => {
  type _session = Expect<Equal<typeof _socket.data.custom, Session>>;
});

type _listeners = Expect<
  Equal<
    ReturnType<typeof ws.listeners<"drain">>,
    NonNullable<BunWebSocketHandlerType<Session>["drain"]>[]
  >
>;

ws.emit("close", client, 1000, "bye");
ws.emit("message", client, "hello");

// @ts-expect-error a close code is a number
ws.emit("close", client, "1000", "bye");

// @ts-expect-error `open` carries only the client
ws.emit("open", client, "extra");

// @ts-expect-error not an event this emitter has
ws.on("upgrade", () => {});

declare const stranger: WebSocketClient<{ other: true }>;
// @ts-expect-error a client with a different custom data type
ws.emit("open", stranger);

ws.on("close", (_socket, _code) => {});
// @ts-expect-error `close` listeners receive `(ws, code, reason)`, no more
ws.on("close", (_socket, _code, _reason, _extra: boolean) => {});

/* --- route handlers ---------------------------------------------- */

type _restOpen = Expect<Equal<BunWebSocketRouteEventRest<Session, "open">, []>>;
type _restClose = Expect<
  Equal<BunWebSocketRouteEventRest<Session, "close">, [number, string]>
>;
type _restMessage = Expect<
  Equal<BunWebSocketRouteEventRest<Session, "message">, [MessagePayload]>
>;

void ws.setRouteHandler(
  "/rooms/:id",
  {
    open(_socket) {
      type _session = Expect<Equal<typeof _socket.data.custom, Session>>;
      type _params = Expect<
        Equal<typeof _socket.data.params, Record<string, string> | undefined>
      >;
    },
    message(_socket, _message) {
      type _session = Expect<Equal<typeof _socket.data.custom, Session>>;
      type _messageType = Expect<Equal<typeof _message, MessagePayload>>;
    },
  },
  (req) => ({ userId: req.path, roles: [] }),
);

void ws.setRouteHandler(
  "/rooms/:id",
  { message() {} },
  // @ts-expect-error the mapping function must produce a Session
  () => ({ userId: 1 }),
);

/* --- the custom data type is inferred from the options ------------- */

function _inferred() {
  const inferred = new BunWebSocket({
    newInstance: false,
    getServer: () => undefined,
    customDataToWsClientFn: () => ({ tenant: "acme" }),
  });
  inferred.on("open", (_socket) => {
    type _tenant = Expect<
      Equal<typeof _socket.data.custom, { tenant: string }>
    >;
  });

  const untyped = new BunWebSocket({
    newInstance: false,
    getServer: () => undefined,
  });
  untyped.on("open", (_socket) => {
    type _unknown = Expect<Equal<typeof _socket.data.custom, unknown>>;
  });
}

/* --- serverOptions.error may replace the default error answer ------ */

function _errorOverride() {
  return new BunWebSocket<Session>({
    newInstance: true,
    listen: { port: 0 },
    serverOptions: {
      error(error) {
        type _error = Expect<Equal<typeof error, Bun.ErrorLike>>;
        return new Response(error.message, { status: 503 });
      },
    },
  });
}

export {};
