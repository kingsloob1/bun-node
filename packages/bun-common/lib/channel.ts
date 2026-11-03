/**
 * `defineChannel` (bun-validate V8, plan `docs/plans/bun-validate/` §4.6.1,
 * §4.12 M7/m12; typed-client `websocket.md` §10, PR-W1): a WebSocket channel
 * on the contract core — a contract keyed by message `type` on both sides
 * (`./contract/channel.ts` has the pure half, browser-safe) plus the server
 * binding: the route's handler, the upgrade's request check, typed, checked
 * `send`/`publish`, and replies that echo the request's id.
 *
 * ```ts
 * const chat = defineChannel({
 *   path: "/rooms/:room",
 *   request: { params: z.object({ room: z.string().min(1) }) },
 *   receives: { say: Say, typing: null },        // client → server; null: no data
 *   sends: { said: Said, error: ChannelError },  // server → client; the implicit `error` frame joins when undeclared
 *   replies: { say: "said" },                    // `say` is answered with `said`, echoing its id
 *   messageValidation: { in: "error", out: "warn" },
 * });
 *
 * router.ws(
 *   chat.path,
 *   chat.checks(),                  // the upgrade's request side (only when `request` is declared)
 *   chat.handler({
 *     say(ws, msg) {
 *       void chat.publish(ws, ws.data.params.room, "said", { by: "…", text: msg.text });
 *       return { by: "me", text: msg.text };   // the reply: sent as `said`, with the request's id
 *     },
 *   }),
 *   chat.options(),
 * );
 * ```
 *
 * The contract can also live in a shared, browser-safe module, so a client
 * imports the same declaration: `export const chatContract =
 * channelContract({ … })` there, and `defineChannel(chatContract)` on the
 * server.
 *
 * (`chat.checks()` is middleware in the `ws()` chain — a route handler's
 * `req.params` are bound for the chain, a `use()` middleware's are not, and
 * the upgrade's `params` check reads them. The two-call form —
 * `router.get(chat.path, chat.checks())` registered before a plain
 * `router.ws(chat.path, …)` — is equivalent and stays valid.)
 *
 * - **Incoming**: a text frame is parsed as JSON and received through the
 *   contract's receiver guard; an invalid frame is answered with an error
 *   frame (`{ type: "error", id?, code: "VALIDATION", status: 400, issues }`,
 *   the issues value-free) and the socket stays open (`closeOnInvalid: true`
 *   closes with `1007` instead). An unknown `type` is answered with
 *   `code: "UNKNOWN_MESSAGE"`. A binary frame is refused with
 *   `UNSUPPORTED_DATA` unless the channel declares `binary: true`, which lets
 *   a client send the same JSON envelope as a binary frame (decoded as UTF-8
 *   and checked like a text frame). A socket's frames are handled one at a
 *   time, in order, so an async vendor never reorders them.
 * - **Replies**: a handler for a type that `replies` maps may return the
 *   reply's data; anything but `undefined` is sent as the reply type, carrying
 *   the request's id (the envelope's `idField`), checked under the `out`
 *   policy. Returning nothing answers later, with
 *   `send(ws, type, data, { id })` and the id from the handler's third
 *   argument. A reply that fails its contract is logged, and not sent.
 * - **Outgoing**: `send(ws, type, data, { id }?)` and
 *   `publish(ws | server, topic, type, data)` are typed by `sends` (each
 *   field's wire input) and checked under the `out` policy; under `"error"` a
 *   synchronous vendor's mismatch throws to the caller and an asynchronous
 *   one's is logged, and nothing is written either way. Sends and a socket's
 *   publishes ride the socket's own chain, so they keep their order against
 *   the frame handling too (a server's publishes ride the server's); those
 *   made while a frame is handled start at once, so a handler may `await`
 *   them, and the next frame waits until they are written. Each resolves to Bun's send status once the write
 *   ran (`-1` backpressure, `0` dropped or not written, else the bytes sent),
 *   and never rejects. A server's `publish` (a route handler's `req.server`)
 *   reaches every subscriber of the topic without a socket.
 * - A handler's `ws` is typed by the channel: `ws.data.params` from the path
 *   literal, `ws.data.valid` with what the declared `request` schemas parsed
 *   (filled by `checks()`), and `ws.data.custom` as `handler<TCustom>()`
 *   says.
 * - A `sends` entry declared with `variants()` throws a `TypeError` at the
 *   declaration for now: a frame has one part (`data`), and the variants
 *   declaration shape for it is an open design point (the plan's §4.4.6
 *   lists the intent).
 * - The handler carries the contract (`getContract`), so documents find it.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type {
  ChannelContract,
  ChannelErrorCode,
  ChannelRequestSchemas,
  ChannelSpec,
} from "./contract/channel";
import type { Logger } from "./logging";
import type { NextFunction } from "./types/general";
import type { EmptyShape, ResolveParams } from "./types/routeTyping";
import type {
  WebSocketClientData,
  WebSocketRouteOptions,
  WebSocketUpgradeHook,
} from "./BunWebSocket";
import type { ValidationIssue } from "./contract/model";
import type { ContractError } from "./contract/guard";
import type { StandardSchemaV1 } from "./types/standardSchema";
import { channelContract, channelErrorFrame } from "./contract/channel";
import { createReceiver, createSender } from "./contract/guard";
import { attachContract } from "./contract/transport";
import { noopLogger, resolveLogger } from "./logging";
import { validate } from "./BunValidate";

/* ------------------------------------------------------------------ *
 * The channel's types
 * ------------------------------------------------------------------ */

/** A message map's entry's output (`null`: no data). */
type DataOut<D> = D extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<D>
  : never;

/** A message map's entry's wire input, for sending (the sender rule: each field's input, or its output where the input is `unknown`). */
type DataIn<D> = D extends StandardSchemaV1
  ? [StandardSchemaV1.InferInput<D>] extends [unknown]
    ? StandardSchemaV1.InferOutput<D>
    : StandardSchemaV1.InferInput<D>
  : never;

/**
 * `ws.data.valid` on a channel's socket: each declared `request` schema's
 * output, by part, when the channel declares a `request` side; otherwise
 * whatever another validator in the chain parsed, if any.
 */
type ChannelValid<S extends ChannelSpec> = S extends {
  readonly request: infer R extends ChannelRequestSchemas;
}
  ? { [P in keyof R]: DataOut<R[P]> }
  : Record<string, unknown> | undefined;

/** A channel socket's `ws.data`: the route's data, its params and parsed upgrade typed by the channel. */
type ChannelSocketData<S extends ChannelSpec, TCustom> = Omit<
  WebSocketClientData<TCustom>,
  "params" | "valid"
> & {
  /** The route params, from the channel's path literal (the raw match, as a verb's `req.params` without a validator). */
  params: ResolveParams<S["path"], EmptyShape>;
  /** What the upgrade's `request` schemas parsed (`checks()` fills it). */
  valid: ChannelValid<S>;
};

/**
 * A socket of channel `S` as its handlers see it: `ws.data.params` typed by
 * the path literal, `ws.data.valid` by the declared `request` schemas'
 * outputs, and `ws.data.custom` as `TCustom` (what the route's `onUpgrade`
 * hook returns as `custom`; the channel itself never reads it).
 */
export type ChannelSocket<
  S extends ChannelSpec = ChannelSpec,
  TCustom = unknown,
> = ServerWebSocket<ChannelSocketData<S, TCustom>>;

/** The frame a handler is given beside its data: the message type, and the correlation id it carried (the envelope's `idField`). */
interface HandledFrame<T> {
  /** The frame's message type. */
  readonly type: T;
  /** The frame's correlation id, when it carried a string one; a later reply passes it to `send(…, { id })`. */
  readonly id: string | undefined;
}

/** The outbound type answering `T` (its `replies` entry, when that is a declared send), else `never`. */
type ReplyType<S extends ChannelSpec, T> = S extends {
  readonly replies: infer R;
}
  ? T extends keyof R
    ? R[T] extends keyof S["sends"] & string
      ? R[T]
      : never
    : never
  : never;

/**
 * What a handler for `T` returns: for a replied type, the reply's wire input
 * (sent as the reply, with the request's id) or `void` to answer later — a
 * reply with no data (`null`) is sent on any return but `undefined`, so
 * `null`; for any other type, anything (ignored).
 */
type HandlerResult<S extends ChannelSpec, T> = [ReplyType<S, T>] extends [never]
  ? unknown
  : S["sends"][ReplyType<S, T>] extends StandardSchemaV1
    ? DataIn<S["sends"][ReplyType<S, T>]> | void
    : null | void;

/**
 * A channel's message handlers: one per `receives` type, each given the
 * socket (typed by the channel `S`), the parsed data (`undefined` for a
 * `null` entry) and the frame's `{ type, id }`. A handler for a type that
 * `replies` maps returns the reply's data, or nothing to answer later.
 * `S` defaults to any channel (untyped params, any return).
 */
export type ChannelHandlers<
  M extends Readonly<Record<string, unknown>> = Record<string, never>,
  S extends ChannelSpec = ChannelSpec,
  TCustom = unknown,
> = {
  [T in keyof M]?: M[T] extends StandardSchemaV1
    ? (
        ws: ChannelSocket<S, TCustom>,
        data: DataOut<M[T]>,
        frame: HandledFrame<T>,
      ) => HandlerResult<S, T> | Promise<HandlerResult<S, T>>
    : (
        ws: ChannelSocket<S, TCustom>,
        data: undefined,
        frame: HandledFrame<T>,
      ) => HandlerResult<S, T> | Promise<HandlerResult<S, T>>;
};

/** The message types a channel sends (its `sends` keys, minus the implicit `error`). */
export type ChannelSendTypes<M = Record<string, never>> = Exclude<
  keyof M,
  "error"
> &
  string;

/** `send`'s options (its trailing argument). */
interface SendOptions {
  /** The correlation id to carry (under the envelope's `idField`): a reply sent later passes the request's id here. Default: none. */
  readonly id?: string;
}

/** `send`'s arguments after the type: the data (none for a `null` entry), then its options. */
type SendArgs<D> = D extends StandardSchemaV1
  ? [data: DataIn<D>, options?: SendOptions]
  : [options?: SendOptions];

/** `publish`'s arguments after the type: the data (none for a `null` entry). */
type PublishArgs<D> = D extends StandardSchemaV1 ? [data: DataIn<D>] : [];

/** A channel: its contract, its route pieces, and its typed sends. */
export interface Channel<S extends ChannelSpec = ChannelSpec> {
  /** The route path the channel is served on. */
  readonly path: S["path"];
  /** The channel's contract (the `websocket` transport's; `describeContract` reads it). */
  readonly contract: ChannelContract<S>;
  /**
   * The upgrade request's route handler, for the `ws()` chain —
   * `router.ws(chat.path, chat.checks(), chat.handler(…), chat.options())` —
   * or registered with `router.get(chat.path, chat.checks())` **before** a
   * plain `ws()` route (a route handler's `req.params` are bound, a `use()`
   * middleware's are not): checks the channel's `request` schemas (filling
   * `req.valid`, which the socket carries as `ws.data.valid`) before the
   * upgrade answers 101, answering 400 itself on a failure. Plain requests to
   * the path pass through untouched. A passthrough when no `request` is
   * declared.
   */
  checks: () => (req: BunRequest, res: BunResponse, next: NextFunction) => void;
  /**
   * The route options for `router.ws()` (its trailing argument): the channel's
   * upgrade hook — composing `hook`, the app's own — carrying the channel's
   * subprotocol, when one is declared. `TCustom` is the hook's `custom` type;
   * the channel itself does not read it.
   */
  options: <TCustom = never>(
    hook?: WebSocketUpgradeHook<TCustom>,
  ) => WebSocketRouteOptions<TCustom>;
  /**
   * The WebSocket handler for `router.ws(chat.path, …)`: the channel's frame
   * handling around the given per-type handlers. Carries the contract.
   * `TCustom` types the handlers' `ws.data.custom` (the route's `onUpgrade`
   * hook's `custom`); default `unknown`.
   */
  handler: <TCustom = unknown>(
    handlers: ChannelHandlers<S["receives"], S, TCustom>,
  ) => WebSocketHandler<never>;
  /**
   * Sends `type` with `data` to one socket, checked under the `out` policy:
   * under `"error"` a synchronous vendor's mismatch throws to the caller (an
   * asynchronous one's is logged), and nothing is written either way.
   * `{ id }` carries a correlation id: a reply sent later passes the
   * request's. Resolves to Bun's send status once the queued write ran
   * (`-1` backpressure, `0` dropped — or not written: a refused asynchronous
   * check, a failed write — else the bytes sent); never rejects.
   */
  send: <T extends ChannelSendTypes<S["sends"]>>(
    ws: ServerWebSocket<unknown>,
    type: T,
    ...args: SendArgs<S["sends"][T]>
  ) => Promise<number>;
  /**
   * Publishes `type` with `data` to a topic, checked under the `out` policy
   * as {@link send} is. On a socket, Bun's `ws.publish`: every subscriber
   * but the sender, in the socket's chain. On a server (`req.server` in a
   * route handler, the adapter's `server`), Bun's `server.publish`: every
   * subscriber, with no socket needed, in the server's own chain (so an
   * asynchronous vendor never reorders two publishes). Resolves to Bun's
   * status as `send` does (`0` also when the topic has no subscriber);
   * never rejects.
   */
  publish: <T extends ChannelSendTypes<S["sends"]>>(
    target: ServerWebSocket<unknown> | Server<unknown>,
    topic: string,
    type: T,
    ...args: PublishArgs<S["sends"][T]>
  ) => Promise<number>;
}

/* ------------------------------------------------------------------ *
 * The binding
 * ------------------------------------------------------------------ */

/** The per-socket state: the frame chain, so an async vendor never reorders a socket's messages (its sends included). */
interface SocketState {
  /** The chain every frame and every send is handled through, one at a time. */
  chain: Promise<void>;
  /**
   * While a frame is being handled, the chain the sends made meanwhile run
   * through instead (the handler's own, its reply, a timer's): they start at
   * once, in call order, and the next frame waits until they are written. So
   * a handler may `await` its own send — on the frame chain it would wait
   * for the very frame that is waiting on it. `undefined` between frames.
   */
  inner?: Promise<void>;
}

/**
 * The state of a socket — or of a server a channel publishes on, whose
 * publishes keep their call order the same way — kept in a map so nothing on
 * it is enumerable.
 */
const SOCKETS = new WeakMap<object, SocketState>();

/** The name a `data`-carrying part has in a channel's contract. */
const DATA = "data";

/** Whether `value` is a `channelContract()` result (its `contract`, `meta` and `spec`), not a spec. */
function isChannelContract(value: unknown): value is ChannelContract {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof ChannelContract, unknown>>;
  return (
    typeof candidate.contract === "object" &&
    candidate.contract !== null &&
    typeof candidate.meta === "object" &&
    candidate.meta !== null &&
    typeof candidate.spec === "object" &&
    candidate.spec !== null &&
    !("receives" in value)
  );
}

/**
 * Builds the channel: the contract (the pure half), the guards, and the
 * route pieces. A `receives`/`sends` entry that is not a Standard Schema or
 * `null` — and any `variants()` entry — throws a `TypeError` here, at the
 * declaration.
 *
 * @param contract A `channelContract()` result — the declaration kept in a
 *   shared, browser-safe module, so a client imports the same one. Its
 *   contract is used as it is (documents see the same object).
 */
export function defineChannel<const S extends ChannelSpec>(
  contract: ChannelContract<S>,
): Channel<S>;
/**
 * Builds the channel from its declaration, inline (the contract is built
 * here, as `channelContract(spec)` would).
 *
 * @param spec The channel's declaration (see {@link ChannelSpec}).
 */
export function defineChannel<const S extends ChannelSpec>(spec: S): Channel<S>;
export function defineChannel(
  input: ChannelSpec | ChannelContract,
): Channel<ChannelSpec> {
  const built = isChannelContract(input) ? input : channelContract(input);
  const { spec: declared, meta } = built;
  const contract = built.contract;
  const logger: Logger = resolveLogger(undefined, noopLogger);
  const inbound = createReceiver(contract, "inbound", {
    policy: declared.messageValidation?.in ?? "error",
    logger,
  });
  const outbound = createSender(contract, "outbound", {
    policy: declared.messageValidation?.out ?? "error",
    logger,
  }) as unknown as (message: unknown) => unknown;
  const idField = meta.envelope.idField;

  /** The frame's correlation id, under the envelope's field. */
  const idOf = (frame: Record<string, unknown>): string | undefined =>
    typeof frame[idField] === "string" ? (frame[idField] as string) : undefined;

  /** A message's wire text: `{ type, <idField>?, data }`. */
  const wire = (type: string, data: unknown, id: string | undefined): string =>
    JSON.stringify(
      id === undefined
        ? { type, [DATA]: data }
        : { type, [idField]: id, [DATA]: data },
    );

  /** Sends an error frame on `ws`, and closes with 1007 when the channel says so. */
  const refuse = (
    ws: ServerWebSocket<never>,
    code: ChannelErrorCode,
    body: { issues?: readonly ValidationIssue[]; detail?: string },
    id?: string,
  ): void => {
    ws.send(JSON.stringify(channelErrorFrame(code, body, id)));
    if (declared.closeOnInvalid === true) {
      ws.close(1007, code);
    }
  };

  /** The per-type handlers, captured by `handler()`. */
  let routeHandlers: Readonly<
    Record<
      string,
      | ((
          ws: ServerWebSocket<never>,
          data: unknown,
          frame: HandledFrame<string>,
        ) => unknown)
      | undefined
    >
  > = {};

  /**
   * Runs `run` in `on`'s chain (a socket's: behind its frame handling and
   * earlier sends, or in the send chain of the frame being handled; a
   * server's: behind its earlier publishes; `frame`: a frame, always on the
   * socket's chain), resolving to
   * its result — or to `fallback` when it fails, which is logged: the promise
   * never rejects, and the chain never ends on an unobserved rejection.
   */
  const queued = <R>(
    on: object,
    run: () => Promise<R>,
    fallback: R,
    frame = false,
  ): Promise<R> => {
    let state = SOCKETS.get(on);
    if (state === undefined) {
      state = { chain: Promise.resolve() };
      SOCKETS.set(on, state);
    }
    // A send while a frame is handled joins that frame's send chain; a
    // frame, or a send between frames, the socket's chain.
    const inner = frame ? undefined : state.inner;
    const task = (inner ?? state.chain).then(run, run);
    const tail = task.then(
      () => undefined,
      (error: unknown) => {
        logger.error("a channel task failed", { error });
      },
    );
    if (inner === undefined) state.chain = tail;
    else state.inner = tail;
    return task.then(
      (value) => value,
      () => fallback,
    );
  };

  /**
   * Checks `{ type, data }` under the `out` policy and queues the write behind
   * `on`'s chain (a socket's frames, a server's publishes), resolving to the
   * write's status. A synchronous vendor's mismatch throws to the caller
   * (nothing is queued); an asynchronous one's is logged when it settles —
   * the caller has returned by then — and nothing is written either (the
   * status is `0`).
   */
  const writeChecked = (
    on: object,
    write: (text: string) => number,
    type: string,
    data: unknown,
    id?: string,
  ): Promise<number> => {
    const verdict = outbound({ type, [DATA]: data });
    if (verdict instanceof Error) {
      // A ContractError from a synchronous vendor: refused to the caller.
      throw verdict;
    }
    return queued(
      on,
      async () => {
        const settled = await verdict;
        if (settled instanceof Error) {
          logger.error("a channel send failed its contract", {
            type,
            error: settled,
          });
          return 0;
        }
        return write(wire(type, data, id));
      },
      0,
    );
  };

  /** Handles one frame on `ws` (called through the socket's chain). */
  const handle = async (
    ws: ServerWebSocket<never>,
    message: string | Buffer,
  ): Promise<void> => {
    if (typeof message !== "string") {
      if (declared.binary !== true) {
        refuse(ws, "UNSUPPORTED_DATA", {
          detail: "Binary frames are not declared on this channel",
        });
        return;
      }
      message = new TextDecoder().decode(message);
    }
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(message);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        refuse(ws, "VALIDATION", {
          issues: [
            {
              target: DATA,
              message: "A frame is an object with a `type` and its data",
              path: "",
            },
          ],
        });
        return;
      }
      frame = parsed as Record<string, unknown>;
    } catch {
      refuse(ws, "VALIDATION", {
        issues: [
          { target: DATA, message: "The message is not valid JSON", path: "" },
        ],
      });
      return;
    }
    const type = frame.type;
    if (typeof type !== "string" || !(type in declared.receives)) {
      refuse(
        ws,
        "UNKNOWN_MESSAGE",
        {
          detail: `Unknown message type (declared: ${Object.keys(declared.receives).join(", ")})`,
        },
        idOf(frame),
      );
      return;
    }
    const id = idOf(frame);
    const verdict = await inbound({ type, [DATA]: frame[DATA] });
    if (verdict instanceof Error) {
      // A ContractError: the issues are already value-free.
      refuse(
        ws,
        "VALIDATION",
        { issues: (verdict as ContractError).issues },
        id,
      );
      return;
    }
    const handler = routeHandlers[type];
    if (handler === undefined) return;
    let result: unknown;
    try {
      const parsed = verdict as Record<string, unknown>;
      result = await handler(ws, parsed[DATA], { type, id });
    } catch (error) {
      logger.error("a channel handler threw", { type, error });
      return;
    }
    // A replied type's return is its reply, echoing the request's id;
    // `undefined` means the handler answers later (or not at all).
    const reply = meta.replies[type];
    if (
      result === undefined ||
      reply === undefined ||
      !Object.hasOwn(declared.sends, reply)
    ) {
      return;
    }
    try {
      void writeChecked(
        ws,
        (text) => ws.send(text),
        reply,
        declared.sends[reply] === null ? undefined : result,
        id,
      );
    } catch (error) {
      // A synchronous vendor's refusal under "error": the reply is the
      // handler's bug, not the client's, so it is logged and not sent.
      logger.error("a channel reply failed its contract", {
        type: reply,
        error,
      });
    }
  };

  /**
   * Handles one frame with the socket's send chain open (see
   * {@link SocketState.inner}), then waits until every send made meanwhile —
   * the reply included — is written, before the next frame.
   */
  const handleFrame = async (
    ws: ServerWebSocket<never>,
    message: string | Buffer,
  ): Promise<void> => {
    let state = SOCKETS.get(ws);
    if (state === undefined) {
      state = { chain: Promise.resolve() };
      SOCKETS.set(ws, state);
    }
    state.inner = Promise.resolve();
    try {
      await handle(ws, message);
    } finally {
      // A send written last may have queued another (a reply after an
      // awaited send): drain until the tail stops moving.
      let tail: Promise<void> | undefined;
      while (tail !== state.inner) {
        tail = state.inner;
        await tail;
      }
      state.inner = undefined;
    }
  };

  const channel: Channel<ChannelSpec> = {
    path: declared.path,
    contract: built,
    checks() {
      if (declared.request === undefined) {
        // Attached either way: the contract on this layer is what a route
        // listing (`listRoutes`) finds the channel by.
        return attachContract(
          (_req: BunRequest, _res: BunResponse, next: NextFunction): void => {
            next();
          },
          contract,
        );
      }
      // The upgrade's request side, checked only for upgrade-shaped requests
      // (a plain GET to the path is not the channel's business). On a
      // failure the validator answers 400 with `{ error, issues }` and the
      // upgrade never happens.
      const middleware = validate(declared.request, {
        onFailure: "respond",
      });
      return attachContract(
        (req: BunRequest, res: BunResponse, next: NextFunction): void => {
          const upgrade = req.headersObj.get("upgrade");
          if (
            typeof upgrade === "string" &&
            upgrade.toLowerCase() === "websocket"
          ) {
            middleware(req, res, next);
            return;
          }
          next();
        },
        contract,
      );
    },
    options<TCustom = never>(hook?: WebSocketUpgradeHook<TCustom>) {
      const headers =
        meta.subprotocol === undefined
          ? undefined
          : { "Sec-WebSocket-Protocol": meta.subprotocol };
      return {
        onUpgrade: async (req, res) => {
          const result = await hook?.(req, res);
          if (headers === undefined) return result;
          return {
            ...(result ?? {}),
            headers: { ...headers, ...(result?.headers ?? {}) },
          };
        },
      } as WebSocketRouteOptions<TCustom>;
    },
    handler(handlers) {
      routeHandlers = handlers as typeof routeHandlers;
      const handler: WebSocketHandler<never> = {
        open(ws) {
          SOCKETS.set(ws, { chain: Promise.resolve() });
        },
        message(ws, message) {
          void queued(ws, () => handleFrame(ws, message), undefined, true);
        },
        close(ws) {
          SOCKETS.delete(ws);
        },
      };
      attachContract(handler, contract);
      return handler;
    },
    send(ws, type, ...args: unknown[]) {
      // A `null` entry takes no data: its one argument is the options.
      const noData = declared.sends[type] === null;
      const data = noData ? undefined : args[0];
      const options = (noData ? args[0] : args[1]) as SendOptions | undefined;
      const socket = ws as ServerWebSocket<never>;
      return writeChecked(
        socket,
        (text) => socket.send(text),
        type,
        data,
        options?.id,
      );
    },
    publish(target, topic, type, ...args: unknown[]) {
      const [data] = args as [unknown];
      // A socket and a server publish alike (Bun's `ws.publish` skips the
      // sender, `server.publish` reaches everyone); each in its own chain.
      return writeChecked(
        target,
        (text) => target.publish(topic, text),
        type,
        data,
      );
    },
  };
  return channel;
}
