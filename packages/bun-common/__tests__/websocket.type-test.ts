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
  WebSocketRouteOptions,
  WebSocketUpgradeHook,
  WebSocketUpgradeResult,
} from "../lib/BunWebSocket";
import type { BunResponse } from "../lib/index";
import { BunRouter } from "../lib/BunRouter";
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

/* --- onUpgrade: the hook's `custom` types ws.data.custom ----------- */

type _hookReturn = Expect<
  Equal<
    ReturnType<WebSocketUpgradeHook<Session>>,
    | WebSocketUpgradeResult<Session>
    | void
    | Promise<WebSocketUpgradeResult<Session> | void>
  >
>;
type _resultCustom = Expect<
  Equal<WebSocketUpgradeResult<Session>["custom"], Session | undefined>
>;
type _routeOptions = Expect<
  Equal<
    WebSocketRouteOptions<Session>["onUpgrade"],
    WebSocketUpgradeHook<Session> | undefined
  >
>;
type _resultData = Expect<
  Equal<
    WebSocketUpgradeResult<Session>["data"],
    WebSocketClientData<Session> | undefined
  >
>;

declare const router: BunRouter;

// Options form: inferred from `onUpgrade`'s `custom`…
router.ws(
  "/hook",
  {
    open(_socket) {
      type _custom = Expect<
        Equal<typeof _socket.data.custom, { userId: string }>
      >;
    },
    message() {},
  },
  { onUpgrade: () => ({ custom: { userId: "1" } }) },
);

// …an async one too, alongside headers.
router.ws(
  "/hook",
  {
    open(_socket) {
      type _custom = Expect<Equal<typeof _socket.data.custom, { n: number }>>;
    },
    message() {},
  },
  { onUpgrade: async () => ({ custom: { n: 1 }, headers: { "X-A": "1" } }) },
);

// A hook returning nothing leaves it `unknown`, as does an empty options object.
router.ws(
  "/hook",
  {
    open(_socket) {
      type _custom = Expect<Equal<typeof _socket.data.custom, unknown>>;
    },
    message() {},
  },
  { onUpgrade: () => {} },
);
router.ws(
  "/hook",
  {
    open(_socket) {
      type _custom = Expect<Equal<typeof _socket.data.custom, unknown>>;
    },
    message() {},
  },
  {},
);

// Deprecated function form: `TCustom` is inferred from the return value,
// whatever its shape — `{ data, custom }` is custom here, not a hook result.
router.ws(
  "/legacy",
  {
    open(_socket) {
      type _custom = Expect<
        Equal<typeof _socket.data.custom, { data: string; custom: number }>
      >;
    },
    message() {},
  },
  () => ({ data: "x", custom: 1 }),
);
router.ws(
  "/legacy",
  {
    open(_socket) {
      type _custom = Expect<
        Equal<typeof _socket.data.custom, { room: string }>
      >;
    },
    message() {},
  },
  async () => ({ room: "lobby" }),
);

// Negative controls: TypeScript reports a failed overload set on the call.
const noop = { message() {} };
router.ws<Session>("/hook", noop, {
  // @ts-expect-error `custom` must be the declared type
  onUpgrade: () => ({ custom: { userId: 1 } }),
});
// @ts-expect-error `headers` must be a HeadersInit
router.ws<Session>("/hook", noop, { onUpgrade: () => ({ headers: 42 }) });
router.ws<Session>("/hook", noop, {
  // @ts-expect-error `data` must be a whole WebSocketClientData
  onUpgrade: () => ({ data: { path: "/x" } }),
});
// @ts-expect-error an unknown per-route option
router.ws<Session>("/hook", noop, { onUpgrde: () => ({}) });
// The deprecated function form still type-checks against TCustom…
router.ws<Session>("/hook", noop, () => ({ userId: "u", roles: [] }));
// @ts-expect-error …and still has to produce one
router.ws<Session>("/hook", noop, () => ({ userId: 1 }));
// @ts-expect-error …and a hook result from it is custom, so not a Session
router.ws<Session>("/hook", noop, () => ({
  custom: { userId: "u", roles: [] },
}));

void ws.setRouteHandler(
  "/rooms/:id",
  { message() {} },
  {
    onUpgrade: () => ({
      custom: { userId: "u", roles: [] },
      headers: [["X-A", "1"]],
    }),
  },
);

void ws.setRouteHandler(
  "/rooms/:id",
  { message() {} },
  // @ts-expect-error the hook's `custom` must be a Session
  { onUpgrade: () => ({ custom: { userId: 1 } }) },
);

void ws.setRouteHandler(
  "/rooms/:id",
  { message() {} },
  // @ts-expect-error a function is the deprecated mapping: its result is custom
  () => ({ custom: { userId: "u", roles: [] } }),
);

function _inferredFromOnUpgrade() {
  const inferred = new BunWebSocket({
    newInstance: false,
    getServer: () => undefined,
    onUpgrade: () => ({ custom: { tenant: "acme" } }),
  });
  inferred.on("open", (_socket) => {
    type _tenant = Expect<
      Equal<typeof _socket.data.custom, { tenant: string }>
    >;
  });

  return new BunWebSocket<Session>({
    newInstance: false,
    getServer: () => undefined,
    // @ts-expect-error the instance-wide hook's `custom` must be a Session
    onUpgrade: () => ({ custom: { tenant: "acme" } }),
  });
}

/* --- router- and response-level upgrade values -------------------- */

declare const res: BunResponse<Session>;
type _resHeaders = Expect<
  Equal<typeof res.webSocketUpgradeHeaders, Headers | undefined>
>;
type _resData = Expect<
  Equal<
    typeof res.webSocketUpgradeData,
    Partial<WebSocketClientData<Session>> | undefined
  >
>;
type _routerHeaders = Expect<
  Equal<typeof router.webSocketUpgradeHeaders, Headers | undefined>
>;
type _routerData = Expect<
  Equal<
    typeof router.webSocketUpgradeData,
    Partial<WebSocketClientData> | undefined
  >
>;
type _chain = Expect<
  Equal<ReturnType<typeof router.setWebSocketUpgradeHeaders>, BunRouter>
>;

// Setters take any HeadersInit.
res.webSocketUpgradeHeaders = { "X-A": "1" };
res.webSocketUpgradeHeaders = [["X-A", "1"]];
router.webSocketUpgradeHeaders = new Headers();
// @ts-expect-error a number is not a HeadersInit
router.webSocketUpgradeHeaders = 1;
// @ts-expect-error the response's data is typed by its custom type
res.webSocketUpgradeData = { custom: { userId: 1 } };
res.upgradeToWebsocket(undefined, { headers: { "X-A": "1" }, inherit: false });

new BunRouter()
  .setWebSocketUpgradeHeaders({ "X-A": "1" })
  .setWebSocketUpgradeData({ custom: 1 })
  .setLogger(console);

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
