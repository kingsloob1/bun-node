/**
 * `defineChannel` (bun-validate V8, plan `docs/plans/bun-validate/` §4.6.1,
 * §4.12 M7/m12): a WebSocket channel on the contract core — a contract keyed
 * by message `type` on both sides (`./contract/channel.ts` has the pure
 * half, browser-safe) plus the server binding: the route's handler, the
 * upgrade's request check, and typed, checked `send`/`publish`.
 *
 * ```ts
 * const chat = defineChannel({
 *   path: "/rooms/:room",
 *   request: { params: z.object({ room: z.string().min(1) }) },
 *   receives: { say: Say, typing: null },        // client → server; null: no data
 *   sends: { said: Said, error: ChannelError },  // server → client; the implicit `error` frame joins when undeclared
 *   messageValidation: { in: "error", out: "warn" },
 * });
 *
 * router.get(chat.path, chat.checks());   // the upgrade's request side (only when `request` is declared)
 * router.ws(chat.path, chat.handler({
 *   say(ws, msg) { chat.publish(ws, ws.data.params.room, "said", { by: "…", text: msg.text }); },
 * }));
 * ```
 *
 * (`chat.checks()` is a GET route handler, not a `use()` middleware: a
 * middleware never sees the path's params, and this one must — the upgrade's
 * `params` check reads them. Register it before the `ws()` route.)
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
 * - **Outgoing**: `send(ws, type, data)` and `publish(ws, topic, type, data)`
 *   are typed by `sends` (each field's wire input) and checked under the
 *   `out` policy; under `"error"` a synchronous vendor's mismatch throws to
 *   the caller and an asynchronous one's is logged, and nothing is written
 *   either way. Sends and publishes ride the socket's own chain, so they
 *   keep their order against the frame handling too.
 * - A `sends` entry declared with `variants()` throws a `TypeError` at the
 *   declaration for now: a frame has one part (`data`), and the variants
 *   declaration shape for it is an open design point (the plan's §4.4.6
 *   lists the intent).
 * - The handler carries the contract (`getContract`), so documents find it.
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type {
  ChannelContract,
  ChannelErrorCode,
  ChannelSpec,
} from "./contract/channel";
import type { Logger } from "./logging";
import type { NextFunction } from "./types/general";
import type {
  WebSocketRouteOptions,
  WebSocketUpgradeHook,
} from "./BunWebSocket";
import type { AnyContract, ValidationIssue } from "./contract/model";
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

/** A channel's message handlers: one per `receives` type, each given the parsed data (`undefined` for a `null` entry). */
export type ChannelHandlers<M> = {
  [T in keyof M]?: M[T] extends StandardSchemaV1
    ? (
        ws: ServerWebSocket<never>,
        data: DataOut<M[T]>,
      ) => unknown | Promise<unknown>
    : (ws: ServerWebSocket<never>) => unknown | Promise<unknown>;
};

/** The message types a channel sends (its `sends` keys, minus the implicit `error`). */
export type ChannelSendTypes<M> = Exclude<keyof M, "error"> & string;

/** A channel: its contract, its route pieces, and its typed sends. */
export interface Channel<S extends ChannelSpec> {
  /** The route path the channel is served on. */
  readonly path: S["path"];
  /** The channel's contract (the `websocket` transport's; `describeContract` reads it). */
  readonly contract: ChannelContract<S>;
  /**
   * The upgrade request's route handler (register it with
   * `router.get(chat.path, chat.checks())` **before** the `ws()` route — a
   * route handler's `req.params` are bound, a `use()` middleware's are not):
   * checks the channel's `request` schemas (filling `req.valid`) before the
   * upgrade answers 101, answering 400 itself on a failure. Plain requests
   * to the path pass through untouched. A passthrough when no `request` is
   * declared.
   */
  checks: () => (req: BunRequest, res: BunResponse, next: NextFunction) => void;
  /**
   * The route options for `router.ws()` (its third argument): the channel's
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
   */
  handler: (
    handlers: ChannelHandlers<S["receives"]>,
  ) => WebSocketHandler<never>;
  /**
   * Sends `type` with `data` to one socket, checked under the `out` policy:
   * under `"error"` a synchronous vendor's mismatch throws to the caller (an
   * asynchronous one's is logged), and nothing is written either way.
   */
  send: <T extends ChannelSendTypes<S["sends"]>>(
    ws: ServerWebSocket<never>,
    type: T,
    ...args: S["sends"][T] extends StandardSchemaV1
      ? [data: DataIn<S["sends"][T]>]
      : []
  ) => void;
  /**
   * Publishes `type` with `data` to a topic, excluding the sender (Bun's
   * `ws.publish`), checked under the `out` policy as {@link send} is.
   */
  publish: <T extends ChannelSendTypes<S["sends"]>>(
    ws: ServerWebSocket<never>,
    topic: string,
    type: T,
    ...args: S["sends"][T] extends StandardSchemaV1
      ? [data: DataIn<S["sends"][T]>]
      : []
  ) => void;
}

/* ------------------------------------------------------------------ *
 * The binding
 * ------------------------------------------------------------------ */

/** The per-socket state: the frame chain, so an async vendor never reorders a socket's messages (its sends included). */
interface SocketState {
  /** The chain every frame and every send is handled through, one at a time. */
  chain: Promise<void>;
}

/** The state of a socket, kept in a map so nothing on it is enumerable. */
const SOCKETS = new WeakMap<ServerWebSocket<never>, SocketState>();

/** The name a `data`-carrying part has in a channel's contract. */
const DATA = "data";

/**
 * Builds the channel: the contract (the pure half), the guards, and the
 * route pieces. A `receives`/`sends` entry that is not a Standard Schema or
 * `null` — and any `variants()` entry — throws a `TypeError` here, at the
 * declaration.
 *
 * @param spec The channel's declaration (see {@link ChannelSpec}).
 */
export function defineChannel<const S extends ChannelSpec>(
  spec: S,
): Channel<S> {
  const built = channelContract(spec);
  const { spec: declared, meta } = built;
  const contract = built.contract as AnyContract;
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
  let routeHandlers: ChannelHandlers<S["receives"]> = {};

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
    const verdict = await inbound({ type, [DATA]: frame[DATA] });
    if (verdict instanceof Error) {
      // A ContractError: the issues are already value-free.
      refuse(
        ws,
        "VALIDATION",
        { issues: (verdict as ContractError).issues },
        idOf(frame),
      );
      return;
    }
    const handler = routeHandlers[type as keyof typeof routeHandlers];
    if (handler !== undefined) {
      try {
        const parsed = verdict as Record<string, unknown>;
        await (
          handler as (ws: ServerWebSocket<never>, data: unknown) => unknown
        )(ws, parsed[DATA]);
      } catch (error) {
        logger.error("a channel handler threw", { type, error });
      }
    }
  };

  /** Writes `frame` on `ws`, in the socket's chain (behind its frame handling). */
  const queued = (
    ws: ServerWebSocket<never>,
    run: () => Promise<void>,
  ): void => {
    let state = SOCKETS.get(ws);
    if (state === undefined) {
      state = { chain: Promise.resolve() };
      SOCKETS.set(ws, state);
    }
    state.chain = state.chain
      .then(run, run)
      // The chain must not end on an unobserved rejection: a failing task is
      // logged and the socket's next frame still runs.
      .catch((error: unknown) => {
        logger.error("a channel task failed", { error });
      });
  };

  /**
   * Checks `{ type, data }` under the `out` policy and queues the write behind
   * the socket's frames. A synchronous vendor's mismatch throws to the caller
   * (nothing is queued); an asynchronous one's is logged when it settles — the
   * caller has returned by then — and nothing is written either.
   */
  const writeChecked = (
    ws: ServerWebSocket<never>,
    write: (frame: string) => unknown,
    type: string,
    data: unknown,
  ): void => {
    const message = { type, [DATA]: data };
    const verdict = outbound(message);
    if (verdict instanceof Error) {
      // A ContractError from a synchronous vendor: refused to the caller.
      throw verdict;
    }
    queued(ws, async () => {
      const settled = await verdict;
      if (settled instanceof Error) {
        logger.error("a channel send failed its contract", {
          type,
          error: settled,
        });
        return;
      }
      write(JSON.stringify(message));
    });
  };

  const channel: Channel<S> = {
    path: declared.path,
    contract: built,
    checks() {
      if (declared.request === undefined) {
        return (
          _req: BunRequest,
          _res: BunResponse,
          next: NextFunction,
        ): void => {
          next();
        };
      }
      // The upgrade's request side, checked only for upgrade-shaped requests
      // (a plain GET to the path is not the channel's business). On a
      // failure the validator answers 400 with `{ error, issues }` and the
      // upgrade never happens.
      const middleware = validate(declared.request, {
        onFailure: "respond",
      });
      return (req: BunRequest, res: BunResponse, next: NextFunction): void => {
        const upgrade = req.headersObj.get("upgrade");
        if (
          typeof upgrade === "string" &&
          upgrade.toLowerCase() === "websocket"
        ) {
          middleware(req, res, next);
          return;
        }
        next();
      };
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
    handler(handlers: ChannelHandlers<S["receives"]>) {
      routeHandlers = handlers;
      const handler: WebSocketHandler<never> = {
        open(ws) {
          SOCKETS.set(ws, { chain: Promise.resolve() });
        },
        message(ws, message) {
          queued(ws, () => handle(ws, message));
        },
        close(ws) {
          SOCKETS.delete(ws);
        },
      };
      attachContract(handler, contract);
      return handler;
    },
    send(ws, type, ...args: unknown[]) {
      const [data] = args as [unknown];
      writeChecked(ws, (frame) => ws.send(frame), type, data);
    },
    publish(ws, topic, type, ...args: unknown[]) {
      const [data] = args as [unknown];
      writeChecked(ws, (frame) => ws.publish(topic, frame), type, data);
    },
  };
  return channel;
}
