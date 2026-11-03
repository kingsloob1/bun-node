/**
 * `@kingsleyweb/bun-client/channel`: the typed WebSocket channel client
 * (typed-client plan, `websocket.md`, PR-W2).
 *
 * ```ts
 * import { channel } from "@kingsleyweb/bun-client/channel";
 * import { chat } from "../shared/chat.contract"; // channelContract({ … }), browser-safe
 *
 * const room = channel(api, chat, { params: { room: "lobby" } });
 * room.send("say", { text: "hi" });                       // typed by chat.spec.receives.say
 * const said = await room.request("say", { text: "hi" }); // typed by sends[replies.say]
 * const off = room.on("said", (m) => console.log(m.by, m.text));
 * for await (const m of room.messages("someoneTyping")) …  // ends on close()
 * room.close();
 * ```
 *
 * - **Types** (W-D1, §3): a `channelContract()` result is inferred (the
 *   client sends each message's wire input, `WireInput`, and receives it
 *   after JSON, `Jsonify`); a generated descriptor (`bun-client generate
 *   --asyncapi`, `channels["/rooms/:room"]`) carries the generated
 *   `Channels` entry, the same shape.
 * - **One socket per URL** (§4.1): a second `channel()` on the same URL
 *   shares the first one's socket and its transport options (reconnection,
 *   heartbeat, ping, offline buffer, codec), refcounted; it closes when the
 *   last handle does.
 * - **Requests** (§4.2): `request(type, data)` stamps the envelope's id
 *   field with a counter per socket and resolves with the reply type's frame
 *   carrying the same id; an error frame with that id rejects with
 *   {@link ChannelError}. Default timeout: the client's `timeout` (30 s). A
 *   drop rejects every waiting request with {@link DisconnectedError},
 *   unless the call set `retry: true` (it is sent again after the reconnect).
 * - **Validation** (§5, TC §5.6): a send through the contract's sender guard
 *   (before anything is written; a failure throws `ValidationError`), a
 *   received frame through its receiver guard (a failure warns and delivers;
 *   `"drop"` discards it and fires `$invalid`; `"throw"` rejects a waiting
 *   request), on in development and off in production, BYO per message
 *   type. The checks load lazily (`./channelChecks`); a send made before they
 *   loaded (or checked by an asynchronous schema) is checked in order once
 *   they have, and its failure, which can no longer throw to the caller,
 *   reaches `on("$error")`. The error frame is always checked for its fixed
 *   shape.
 * - **Reconnection** (§7): 500 ms doubling to 30 s, half-jittered, the count
 *   reset once a socket stays open 60 s; never after a close code in
 *   `fatalCloseCodes` (1007, 1008, 4400–4499). A declared heartbeat arms a
 *   watchdog (2 × its interval + 5 s of silence closes with 4000 and
 *   reconnects); a declared ping is sent after `intervalMs` of silence.
 *   `resubscribe(room)` runs after every open, before the offline buffer
 *   (100 messages by default) is flushed in order.
 * - **Backpressure** (§8): `bufferedAmount`, and `sendWhenReady()`, which
 *   waits (an animation frame at a time, 16 ms outside a browser) until the
 *   socket's buffer is under `highWaterMark` (1 MiB).
 *
 * Browser-safe; it imports nothing of the `.` entry's client (it reads the
 * client's configuration through the client object, as `./sse` does), so an
 * HTTP-only bundle carries none of it.
 */
import type {
  ChannelContract,
  ChannelErrorCode,
  ChannelErrorFrame,
  ChannelMessage,
  ChannelSpec,
  StandardSchemaV1,
  WireInput,
} from "@kingsleyweb/bun-contract";
import type { ChannelChecks, Verdict } from "./channelChecks";
import type { Jsonify } from "./jsonify";
import type { ClientConfig, FailureMode, PartValidation } from "./types";
import {
  ChannelClosedError,
  ChannelError,
  ClientError,
  DisconnectedError,
  RequestTimeoutError,
  ValidationError,
} from "./errors";

export {
  ChannelClosedError,
  ChannelError,
  DisconnectedError,
  RequestTimeoutError,
} from "./errors";

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * One channel's types, the generated `Channels` map's entry shape (and what
 * a `channelContract()` spec is read as, {@link ChannelEntryOf}). The sides
 * keep the server's names: the client sends what the server `receives` and
 * receives what it `sends` (§3.3).
 */
export interface ChannelEntry {
  /** The path params, as the URL takes them. */
  params?: object;
  /** The upgrade's query, when the channel declares one. */
  query?: object;
  /** Client → server: each message type to its data's wire type; `undefined` for a message with no data. */
  receives: object;
  /** Server → client: each message type to its data's wire type (the client sees it after JSON). */
  sends: object;
  /** A received type to the sent type answering it, where one does. */
  replies?: object;
}

/** A message map's entry as the wire carries it: the schema's `WireInput`, `undefined` for `null`. */
type DataOf<D> = D extends StandardSchemaV1 ? WireInput<D> : undefined;

/** A message map's types. */
type MessagesOf<M> = { -readonly [T in keyof M]: DataOf<M[T]> };

/** A path param's name, up to the first character a name does not take. */
type NameOf<S extends string> =
  S extends `${infer N}${"." | "-" | "{" | "}" | "(" | "?"}${string}`
    ? NameOf<N>
    : S;

/** The params of a path literal (`/rooms/:room` gives `{ room: string }`; `*rest` a `string[]`). */
type PathParamsOf<P extends string> =
  P extends `${string}/${infer Segment}/${infer Rest}`
    ? PathParamsOf<`/${Segment}`> & PathParamsOf<`/${Rest}`>
    : P extends `${string}/:${infer Name}`
      ? { [K in NameOf<Name>]: string }
      : P extends `${string}/*${infer Name}`
        ? { [K in NameOf<Name>]: string[] }
        : Record<never, never>;

/** Flattens an intersection. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A declared upgrade part's wire input, else `F`. */
type RequestPart<S, P extends string, F> = S extends {
  readonly request: { readonly [K in P]: infer X extends StandardSchemaV1 };
}
  ? WireInput<X>
  : F;

/**
 * A `channelContract()` spec read as a {@link ChannelEntry}: each message's
 * `WireInput` (`undefined` for a `null` one), the params from the upgrade's
 * `params` schema or else the path literal, the query when one is declared,
 * and the replies.
 */
export type ChannelEntryOf<S extends ChannelSpec> = Simplify<
  {
    params: RequestPart<S, "params", Simplify<PathParamsOf<S["path"]>>>;
    receives: MessagesOf<S["receives"]>;
    sends: MessagesOf<S["sends"]>;
    replies: S extends { readonly replies: infer R }
      ? { -readonly [K in keyof R]: R[K] }
      : Record<never, never>;
  } & (S extends { readonly request: { readonly query: StandardSchemaV1 } }
    ? { query: RequestPart<S, "query", never> }
    : Record<never, never>)
>;

/**
 * A generated channel's runtime facts (`bun-client generate --asyncapi`
 * writes one per channel, `channels["/rooms/:room"]`), typed by its
 * `Channels` entry: what {@link channel} takes in place of a contract.
 */
export interface ChannelDescriptor<E extends ChannelEntry = ChannelEntry> {
  /** The route path the channel is served on. */
  readonly path: string;
  /** The envelope's correlation field. Default `"id"`. */
  readonly idField?: string;
  /** A received type to the sent type answering it. Default: none. */
  readonly replies?: Readonly<Record<string, string>>;
  /** The subprotocol the upgrade answers with, offered on connect. Default: none. */
  readonly subprotocol?: string;
  /** The entry's type, carried for inference only (never set). */
  readonly "~entry"?: E;
}

/** A generated `channels` object's type: a {@link ChannelDescriptor} per `Channels` entry. */
export type ChannelDescriptors<C> = {
  readonly [K in keyof C]: ChannelDescriptor<C[K] & ChannelEntry>;
};

/** The keys of `T` whose property is required. */
type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

/** `{ [K]: T }`: required when `T` has a required key, else optional (`Record<string, never>` for none). */
type Part<K extends string, T> = [keyof T] extends [never]
  ? { [P in K]?: Record<string, never> }
  : [RequiredKeys<T>] extends [never]
    ? { [P in K]?: T }
    : { [P in K]: T };

/** The URL's typed parts for entry `E`. */
type UrlParts<E> = Part<
  "params",
  E extends { params: infer P } ? P : Record<never, never>
> &
  (E extends { query: infer Q } ? Part<"query", Q> : { query?: object });

/** `channel()`'s options: the URL's parts and the channel's own. */
type ChannelOpenOptions<E extends ChannelEntry> = UrlParts<E> &
  ChannelOptions<E>;

/** `channel()`'s trailing argument: required when a URL part is. */
type OpenArgs<E extends ChannelEntry> = [RequiredKeys<UrlParts<E>>] extends [
  never,
]
  ? [options?: ChannelOpenOptions<E>]
  : [options: ChannelOpenOptions<E>];

/** What a channel's own validation level takes (§5, TC §5.6): per direction, per message type. */
export interface ChannelValidationConfig {
  /**
   * What the client sends: `true` runs the built-in schemas, `false` turns
   * every check off (BYO included), or one entry per message type. Default:
   * the client's `validate.request`, else on in development, off in
   * production.
   */
  send?: boolean | { readonly [type: string]: PartValidation };
  /**
   * What the client receives (pushes and replies), as `send` does. Default:
   * the client's `validate.response`, else on in development, off in
   * production.
   */
  receive?: boolean | { readonly [type: string]: PartValidation };
  /**
   * What a failure does: a send `"throw"`s (before anything is written),
   * `"warn"`s and sends, or calls a hook; a received frame `"warn"`s and is
   * delivered, is dropped (`"drop"`, firing `$invalid`), `"throw"`s (a
   * waiting request rejects; a push is dropped and reaches `$error`), or
   * calls a hook. Default: `{ send: "throw", receive: "warn" }`, or the
   * client's `onFailure.request` / `.response`.
   */
  onFailure?:
    | FailureMode
    | {
        /** For a message sent. Default: `"throw"`. */
        send?: FailureMode;
        /** For a frame received. Default: `"warn"`. */
        receive?: FailureMode | "drop";
      };
}

/**
 * A codec (W-D7): how a message is written and how a frame is read.
 * `"bun-common"` (the default) is `defineChannel`'s envelope, `{ type,
 * <idField>?, data }` as JSON, its error frame `{ type: "error", id?, code,
 * status, issues?, detail? }`.
 */
export interface ChannelCodec {
  /** Writes one message (its `id` set on a request) for `WebSocket.send`. */
  encode: (
    message: ChannelMessage,
    envelope: { readonly idField: string },
  ) => Payload;
  /**
   * Reads one frame: a message, an error frame (`type: "error"` with a
   * `code`), or `undefined` to ignore it. A throw is logged and the frame
   * ignored.
   */
  decode: (
    data: string | ArrayBuffer,
    envelope: { readonly idField: string },
  ) => ChannelMessage | ChannelErrorFrame | undefined;
}

/**
 * A generated channel's runtime schemas: the zod module's `channelSchemas`
 * entry for its path (`bun-client generate --asyncapi … --zod`), which the
 * channel reads through the client's `schemas` source. Each message type's
 * data schema; `null` for a message with no data.
 */
export interface ChannelSchemas {
  /** Client → server messages. */
  readonly receives?: { readonly [type: string]: StandardSchemaV1 | null };
  /** Server → client messages. */
  readonly sends?: { readonly [type: string]: StandardSchemaV1 | null };
}

/** What `WebSocket.send` takes: what a codec encodes a message to. */
type Payload = Parameters<WebSocket["send"]>[0];

/** A close code, or an inclusive range of them. */
type CloseCodes = readonly (number | readonly [from: number, to: number])[];

/** {@link channel}'s own options (§7, §13.3). */
export interface ChannelOptions<E extends ChannelEntry = ChannelEntry> {
  /**
   * Reconnection after a drop, exponential and half-jittered; `false` never
   * reconnects (any close then ends the channel). Default: `{ initialMs:
   * 500, maxMs: 30_000, stableAfterMs: 60_000 }`.
   */
  reconnect?:
    | {
        /** The first delay's ceiling, ms. Default `500`. */
        initialMs?: number;
        /** The largest delay, ms. Default `30_000`. */
        maxMs?: number;
        /** How long a socket stays open before the count starts over, ms. Default `60_000`. */
        stableAfterMs?: number;
      }
    | false;
  /**
   * Close codes the client never reconnects after (each a code or an
   * inclusive `[from, to]` range): the channel ends with
   * {@link ChannelClosedError}. Default: `1007` (bun-common's
   * `closeOnInvalid`), `1008` (policy) and `4400`–`4499`.
   */
  fatalCloseCodes?: CloseCodes;
  /**
   * The server's heartbeat: a message it sends every `intervalMs`. Silence
   * of `2 × intervalMs + slackMs` (any frame counts) closes the socket with
   * `4000` and reconnects. Default: none (a bun-common channel sends none).
   */
  heartbeat?: {
    /** The heartbeat's message type. */
    type: keyof E["sends"] & string;
    /** The server's interval, ms. */
    intervalMs: number;
    /** Extra silence allowed, ms. Default `5_000`. */
    slackMs?: number;
  };
  /**
   * A ping the client sends after `intervalMs` without a frame (a message
   * with no data). Default: none.
   */
  ping?: {
    /** The ping's message type. */
    type: keyof E["receives"] & string;
    /** Silence before a ping, ms. */
    intervalMs: number;
  };
  /**
   * Messages sent while disconnected: buffered (at most `buffer`) and
   * flushed in order on open, a send over the limit throwing
   * {@link ChannelClosedError}; `"fail"` throws at once. Default:
   * `{ buffer: 100 }`.
   */
  offline?: { buffer: number } | "fail";
  /**
   * Runs after every open (the first included), before the offline buffer
   * flushes: where the app re-sends its own `subscribe` messages and resume
   * cursor (§4.3, §7). Messages it sends go out at once. A throw is logged.
   * Default: none.
   */
  resubscribe?: (room: ChannelClient<E>) => void | Promise<void>;
  /** The envelope: `"bun-common"` or a custom {@link ChannelCodec}. Default `"bun-common"`. */
  codec?: "bun-common" | ChannelCodec;
  /**
   * This channel's validation, over the client's (`createClient`'s
   * `validate`: `request` for sends, `response` for what arrives); `false`
   * turns it all off. Default: the client's.
   */
  validate?: ChannelValidationConfig | false;
}

/** A message's arguments after its type: its data (none for a message without), then the call's options. */
type DataArgs<D, O> = [D] extends [undefined]
  ? [data?: undefined, options?: O]
  : undefined extends D
    ? [data?: D, options?: O]
    : [data: D, options?: O];

/** The types the client sends. */
type SendType<E extends ChannelEntry> = keyof E["receives"] & string;

/** The types the client receives. */
type PushType<E extends ChannelEntry> = keyof E["sends"] & string;

/** The type answering `T`, `never` when none does. */
type ReplyOf<E extends ChannelEntry, T> = E extends { replies: infer R }
  ? T extends keyof R
    ? R[T] & PushType<E>
    : never
  : never;

/** The types `request()` takes: those `replies` maps. */
type RequestType<E extends ChannelEntry> = {
  [T in SendType<E>]: [ReplyOf<E, T>] extends [never] ? never : T;
}[SendType<E>];

/** A received message's data, after JSON. */
type Data<E extends ChannelEntry, T> = Jsonify<
  E["sends"][T & keyof E["sends"]]
>;

/** A push as `messages()` yields it with no type. */
type PushOf<E extends ChannelEntry> = {
  [T in PushType<E>]: { type: T; data: Data<E, T> };
}[PushType<E>];

/** The channel's state. */
type ChannelState = "connecting" | "open" | "reconnecting" | "closed";

/** What `on` takes: a received type, or a client event. */
type EventName<E extends ChannelEntry> =
  PushType<E> | "$state" | "$error" | "$invalid";

/** The listener for `N`. */
type Listener<E extends ChannelEntry, N> = N extends "$state"
  ? (state: ChannelState) => void
  : N extends "$error"
    ? (error: ChannelError | ValidationError | ChannelClosedError) => void
    : N extends "$invalid"
      ? (error: ValidationError) => void
      : (data: Data<E, N>, frame: { type: N; id?: string }) => void;

/** `send`'s options. */
interface SendOptions {
  /** This message's validation, over the channel's and the client's; `false` skips it. Default: the channel's. */
  validate?: PartValidation;
}

/** `request`'s options. */
interface RequestOptions extends SendOptions {
  /** Milliseconds before the request rejects with {@link RequestTimeoutError}; `false` for none. Default: the client's `timeout` (30 s). */
  timeout?: number | false;
  /** Send it again after a reconnect instead of rejecting with {@link DisconnectedError} (for an idempotent request). Default `false`. */
  retry?: boolean;
}

/** `sendWhenReady`'s options. */
interface ReadyOptions extends SendOptions {
  /** The socket's `bufferedAmount` to wait under, bytes. Default `1_048_576` (1 MiB). */
  highWaterMark?: number;
}

/** A typed channel (§4): what {@link channel} returns. */
export interface ChannelClient<E extends ChannelEntry = ChannelEntry> {
  /**
   * Sends a message the server receives, checked first (a failure throws
   * `ValidationError` and writes nothing); buffered while disconnected.
   * Never waits. Throws {@link ChannelClosedError} once the channel is
   * closed, with `offline: "fail"` while disconnected, or when the offline
   * buffer is full.
   */
  send: <T extends SendType<E>>(
    type: T,
    ...args: DataArgs<E["receives"][T], SendOptions>
  ) => void;
  /** Sends a request and resolves with its reply's data (a type `replies` maps). */
  request: <T extends RequestType<E>>(
    type: T,
    ...args: DataArgs<E["receives"][T], RequestOptions>
  ) => Promise<Data<E, ReplyOf<E, T>>>;
  /** Waits until {@link bufferedAmount} is under `highWaterMark`, then sends; rejects where `send` throws. */
  sendWhenReady: <T extends SendType<E>>(
    type: T,
    ...args: DataArgs<E["receives"][T], ReadyOptions>
  ) => Promise<void>;
  /**
   * Listens for a pushed message type (a frame without an id, or with one no
   * request of this client sent), or a client event: `$state` (every state
   * change), `$error` (an error frame no request waits for, a deferred
   * send's failure, a push refused under `"throw"`, the close that ended the
   * channel), `$invalid` (a frame `"drop"` discarded). Returns the
   * function that removes it. A listener that throws is logged.
   */
  on: <N extends EventName<E>>(name: N, listener: Listener<E, N>) => () => void;
  /**
   * The pushes, as an async iterator (every type as `{ type, data }`, or one
   * type's data); it ends when the channel closes. It buffers what it has
   * not taken yet.
   */
  messages: {
    (): AsyncIterableIterator<PushOf<E>>;
    <T extends PushType<E>>(type: T): AsyncIterableIterator<Data<E, T>>;
  };
  /** Closes this handle: its requests reject with {@link ChannelClosedError}, its iterators end; the socket closes with the last handle. */
  close: () => void;
  /** `"connecting"` until the first open, `"open"`, `"reconnecting"` after a drop, `"closed"`. */
  readonly state: ChannelState;
  /** The socket's `bufferedAmount`: bytes queued, not yet sent (`0` while disconnected). */
  readonly bufferedAmount: number;
}

/* ------------------------------------------------------------------------ */
/* Runtime                                                                   */
/* ------------------------------------------------------------------------ */

/** The symbol the client keeps its configuration under (`client.ts`). */
const CONFIG = Symbol.for("@kingsleyweb/bun-client");

/** The error codes an error frame may carry. */
const CODES: readonly ChannelErrorCode[] = [
  "VALIDATION",
  "UNKNOWN_MESSAGE",
  "UNSUPPORTED_DATA",
];

/** The default fatal close codes (§7). */
const FATAL: CloseCodes = [1007, 1008, [4400, 4499]];

/** The `"bun-common"` codec: `defineChannel`'s envelope. */
const BUN_COMMON: ChannelCodec = {
  encode: ({ type, id, data }, { idField }) =>
    JSON.stringify(
      id === undefined ? { type, data } : { type, [idField]: id, data },
    ),
  decode(raw, { idField }) {
    const frame = JSON.parse(
      typeof raw === "string" ? raw : new TextDecoder().decode(raw),
    ) as Record<string, unknown> | null;
    if (typeof frame?.type !== "string") return undefined;
    // bun-common's error frame carries the echoed id as `id` whatever the
    // channel's idField (`channelErrorFrame`); a message under the idField.
    const id =
      frame[idField] ?? (frame.type === "error" ? frame.id : undefined);
    if (frame.type === "error" && "code" in frame)
      return {
        ...frame,
        id: typeof id === "string" ? id : undefined,
      } as ChannelErrorFrame;
    return typeof id === "string"
      ? { type: frame.type, id, data: frame.data }
      : { type: frame.type, data: frame.data };
  },
};

/** The checks module, imported on first use and shared by every channel. */
let checksModule: Promise<typeof import("./channelChecks")> | undefined;

/** The sockets, by URL and subprotocol. */
const SOCKETS = new Map<string, Connection>();

/**
 * The one `process` read here, `process.env.NODE_ENV`, as `client.ts`
 * reads it (a type, erased; a bundler's define replaces it).
 */
declare const process: {
  /** The environment; only `NODE_ENV` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
};

/** Development unless the configuration or `NODE_ENV` says production (TC §5.5). */
function isDevelopment(config: ClientConfig): boolean {
  if (config.mode !== undefined) return config.mode === "development";
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
}

/** Whether a validation level could turn a check on: an object with a key but `onFailure` that is not `false`. */
function mayCheck(level: object | false | undefined): boolean {
  return (
    typeof level === "object" &&
    Object.entries(level).some(
      ([name, value]) =>
        name !== "onFailure" && value !== false && value !== undefined,
    )
  );
}

/** The page's `requestAnimationFrame`, when there is one (`lib/` is checked without the DOM's). */
const RAF = (
  globalThis as { requestAnimationFrame?: (callback: () => void) => number }
).requestAnimationFrame;

/** Waits one animation frame, or 16 ms outside a browser. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) =>
    typeof RAF === "function" ? RAF(() => resolve()) : setTimeout(resolve, 16),
  );
}

/** What a channel is, as a contract or a descriptor gives it. */
interface Facts {
  /** The route path. */
  readonly path: string;
  /** The envelope's correlation field. */
  readonly idField: string;
  /** The replies map. */
  readonly replies: Readonly<Record<string, string>>;
  /** The subprotocol to offer. */
  readonly subprotocol: string | undefined;
  /** The shared contract, when one was given. */
  readonly contract: ChannelContract | undefined;
}

/** A request waiting for its reply. */
interface Pending {
  /** Its correlation id. */
  readonly id: string;
  /** The handle that sent it. */
  readonly handle: Handle;
  /** Its message type. */
  readonly type: string;
  /** The reply's type. */
  readonly reply: string;
  /** The encoded frame, for a resend. */
  readonly payload: Payload;
  /** Send it again after a reconnect. */
  readonly retry: boolean;
  /** Settles it with the reply's data. */
  resolve: (value: unknown) => void;
  /** Settles it with an error. */
  reject: (error: unknown) => void;
}

/** One socket, shared by every handle on its URL. */
class Connection {
  /** The socket, while one is open or opening. */
  ws: WebSocket | undefined;
  /** The socket's state. */
  state: ChannelState = "connecting";
  /** The handles on it. */
  readonly handles = new Set<Handle>();
  /** The requests waiting, by id. */
  readonly pending = new Map<string, Pending>();
  /** Requests to send again on the next open (`retry: true`). */
  readonly resend: Pending[] = [];
  /** Messages written while disconnected. */
  readonly buffer: Payload[] = [];
  /** The id counter. */
  #next = 0;
  /** Reconnect attempts since the last stable socket. */
  #attempt = 0;
  /** The reconnect, stable, watchdog and ping timers. */
  readonly #timers: Record<
    "reconnect" | "stable" | "watchdog" | "ping",
    ReturnType<typeof setTimeout> | undefined
  > = {
    reconnect: undefined,
    stable: undefined,
    watchdog: undefined,
    ping: undefined,
  };
  /** The codec. */
  readonly codec: ChannelCodec;
  /** The envelope, for the codec. */
  readonly envelope: { readonly idField: string };

  /**
   * @param key     Its key in {@link SOCKETS}.
   * @param url     The socket URL.
   * @param facts   The channel's facts.
   * @param options The first handle's options (the transport's).
   * @param logger  Where problems are logged.
   */
  constructor(
    readonly key: string,
    readonly url: string,
    readonly facts: Facts,
    readonly options: ChannelOptions,
    readonly logger: Pick<Console, "warn" | "error">,
  ) {
    this.codec =
      options.codec === undefined || options.codec === "bun-common"
        ? BUN_COMMON
        : options.codec;
    this.envelope = { idField: facts.idField };
    this.#open();
  }

  /** Opens a socket. */
  #open(): void {
    const ws = new WebSocket(
      this.url,
      this.facts.subprotocol === undefined ? [] : [this.facts.subprotocol],
    );
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => void this.#opened(ws);
    ws.onmessage = (event) =>
      this.#frame(ws, event.data as string | ArrayBuffer);
    ws.onclose = (event) => this.#dropped(ws, event.code, event.reason);
  }

  /** Moves to `state`, telling every handle. */
  #state(state: ChannelState): void {
    if (this.state === state) return;
    this.state = state;
    for (const handle of this.handles) handle.emit("$state", state);
  }

  /** The socket opened: resubscribe, resend, flush. */
  async #opened(ws: WebSocket): Promise<void> {
    if (ws !== this.ws) return;
    this.#state("open");
    this.#arm();
    const stableAfter =
      this.options.reconnect === false
        ? 0
        : (this.options.reconnect?.stableAfterMs ?? 60_000);
    this.#timers.stable = setTimeout(() => {
      this.#attempt = 0;
    }, stableAfter);
    for (const handle of [...this.handles]) {
      try {
        await handle.options.resubscribe?.(handle.client as never);
      } catch (error) {
        handle.logger.error(`${this.facts.path}: resubscribe threw`, error);
      }
    }
    if (ws !== this.ws || ws.readyState !== 1) return;
    for (const pending of this.resend.splice(0)) {
      this.pending.set(pending.id, pending);
      ws.send(pending.payload);
    }
    for (const payload of this.buffer.splice(0)) ws.send(payload);
  }

  /** (Re)arms the heartbeat watchdog and the ping timer: any frame counts. */
  #arm(): void {
    const { heartbeat, ping } = this.options;
    clearTimeout(this.#timers.watchdog);
    clearTimeout(this.#timers.ping);
    if (heartbeat !== undefined) {
      this.#timers.watchdog = setTimeout(
        () => this.#lost(),
        heartbeat.intervalMs * 2 + (heartbeat.slackMs ?? 5_000),
      );
    }
    if (ping !== undefined) {
      const send = (): void => {
        if (this.ws?.readyState === 1)
          this.ws.send(this.codec.encode({ type: ping.type }, this.envelope));
        this.#timers.ping = setTimeout(send, ping.intervalMs);
      };
      this.#timers.ping = setTimeout(send, ping.intervalMs);
    }
  }

  /** The heartbeat went quiet: close with 4000 and reconnect. */
  #lost(): void {
    const ws = this.ws;
    if (ws === undefined) return;
    ws.onclose = null;
    ws.close(4000, "heartbeat lost");
    this.#dropped(ws, 4000, "heartbeat lost");
  }

  /** Handles one frame. */
  #frame(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (ws !== this.ws) return;
    this.#arm();
    let message: ChannelMessage | ChannelErrorFrame | undefined;
    try {
      message = this.codec.decode(raw, this.envelope);
    } catch (error) {
      this.logger.warn(
        `${this.facts.path}: a frame could not be decoded`,
        error,
      );
      return;
    }
    if (message === undefined) return;
    const id = typeof message.id === "string" ? message.id : undefined;
    const pending = id === undefined ? undefined : this.pending.get(id);
    if (message.type === "error" && "code" in message) {
      // The error frame is always checked, with its fixed shape (§5).
      const { code, status, issues, detail } = message;
      if (
        !CODES.includes(code) ||
        typeof status !== "number" ||
        (issues !== undefined && !Array.isArray(issues)) ||
        (detail !== undefined && typeof detail !== "string")
      ) {
        this.logger.warn(
          `${this.facts.path}: an error frame does not have the error frame's shape; ignored`,
        );
        return;
      }
      if (pending !== undefined) {
        this.pending.delete(id!);
        pending.reject(
          new ChannelError(this.facts.path, message, pending.type),
        );
        return;
      }
      const error = new ChannelError(this.facts.path, message);
      // Each handle's `$error`, or its own logger when it has none.
      for (const handle of this.handles)
        if (!handle.emit("$error", error)) handle.logger.warn(error.message);
      return;
    }
    if (pending !== undefined && pending.reply === message.type) {
      this.pending.delete(id!);
      pending.handle.reply(pending, (message as ChannelMessage).data);
      return;
    }
    for (const handle of this.handles) handle.push(message);
  }

  /** The socket closed: reject or keep the requests, then reconnect or end. */
  #dropped(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = undefined;
    for (const timer of Object.values(this.#timers)) clearTimeout(timer);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.retry) this.resend.push(pending);
      else pending.reject(new DisconnectedError(this.facts.path, code, reason));
    }
    if (this.state === "closed") return;
    const fatal = (this.options.fatalCloseCodes ?? FATAL).some((entry) =>
      typeof entry === "number"
        ? entry === code
        : code >= entry[0] && code <= entry[1],
    );
    if (this.options.reconnect === false || fatal) {
      this.end(
        new ChannelClosedError(
          this.facts.path,
          reason || "the server closed the channel",
          code,
        ),
      );
      return;
    }
    const { initialMs = 500, maxMs = 30_000 } = this.options.reconnect ?? {};
    const ceiling = Math.min(maxMs, initialMs * 2 ** this.#attempt++);
    this.#state(this.state === "connecting" ? "connecting" : "reconnecting");
    this.#timers.reconnect = setTimeout(
      () => this.#open(),
      ceiling / 2 + (ceiling / 2) * Math.random(),
    );
  }

  /** Ends the socket for good: every handle closed with `error` (none for the last `close()`). */
  end(error?: ChannelClosedError): void {
    SOCKETS.delete(this.key);
    for (const timer of Object.values(this.#timers)) clearTimeout(timer);
    const closed =
      error ?? new ChannelClosedError(this.facts.path, "the channel is closed");
    for (const pending of [...this.pending.values(), ...this.resend])
      pending.reject(closed);
    this.buffer.length = 0;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
    for (const handle of [...this.handles])
      handle.ended(closed, error !== undefined);
    this.state = "closed";
  }

  /** Writes `payload`, or buffers it while disconnected; throws when it can do neither. */
  write(payload: Payload): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(payload);
      return;
    }
    const offline = this.options.offline ?? { buffer: 100 };
    if (offline === "fail" || this.buffer.length >= offline.buffer)
      throw new ChannelClosedError(
        this.facts.path,
        offline === "fail"
          ? 'disconnected (offline: "fail")'
          : `the offline buffer is full (${offline.buffer} messages)`,
      );
    this.buffer.push(payload);
  }

  /** Registers a request and writes it. */
  request(
    handle: Handle,
    type: string,
    data: unknown,
    options: RequestOptions,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  ): void {
    const reply = this.facts.replies[type];
    if (reply === undefined)
      throw new ClientError(
        `${this.facts.path}: "${type}" has no reply declared (replies)`,
        { key: this.facts.path },
      );
    const id = String(++this.#next);
    const timeout = options.timeout ?? handle.timeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending: Pending = {
      id,
      handle,
      type,
      reply,
      payload: this.codec.encode({ type, id, data }, this.envelope),
      retry: options.retry === true,
      resolve,
      reject,
    };
    // Settling (once) clears the timer and the request's every entry.
    const settle =
      <T>(fn: (value: T) => void) =>
      (value: T): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        const at = this.resend.indexOf(pending);
        if (at !== -1) this.resend.splice(at, 1);
        handle.requests.delete(pending);
        fn(value);
      };
    pending.resolve = settle(resolve);
    pending.reject = settle(reject);
    this.write(pending.payload);
    this.pending.set(id, pending);
    handle.requests.add(pending);
    if (timeout !== false)
      timer = setTimeout(
        () =>
          pending.reject(
            new RequestTimeoutError(this.facts.path, type, id, timeout),
          ),
        timeout,
      );
  }
}

/** A drop of a frame `"drop"` asked for (or a refused push). */
const DROPPED = Symbol("dropped");

/** One iterator of `messages()`. */
interface Iteration {
  /** The type it yields, or every type. */
  readonly type: string | undefined;
  /** Takes a value. */
  readonly push: (value: unknown) => void;
  /** Ends it. */
  readonly end: () => void;
}

/** A handle's client as the runtime calls it (untyped; {@link ChannelClient} types it). */
interface RuntimeClient {
  /** `ChannelClient.send`. */
  send: (type: string, data?: unknown, options?: SendOptions) => void;
  /** `ChannelClient.request`. */
  request: (
    type: string,
    data?: unknown,
    options?: RequestOptions,
  ) => Promise<unknown>;
  /** `ChannelClient.sendWhenReady`. */
  sendWhenReady: (
    type: string,
    data?: unknown,
    options?: ReadyOptions,
  ) => Promise<void>;
  /** `ChannelClient.on`. */
  on: (name: string, listener: (...args: never[]) => void) => () => void;
  /** `ChannelClient.messages`. */
  messages: (type?: string) => AsyncIterableIterator<unknown>;
  /** `ChannelClient.close`. */
  close: () => void;
  /** `ChannelClient.state`. */
  readonly state: ChannelState;
  /** `ChannelClient.bufferedAmount`. */
  readonly bufferedAmount: number;
}

/** One `channel()` handle. */
class Handle {
  /** The client this handle is. */
  readonly client: RuntimeClient;
  /** The listeners, by name. */
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>();
  /** The `messages()` iterators. */
  readonly #iterations = new Set<Iteration>();
  /** Its requests waiting. */
  readonly requests = new Set<Pending>();
  /** The checks, once loaded; `undefined` while loading, or when nothing checks. */
  #checks: ChannelChecks | undefined;
  /** The checks loading; `undefined` when nothing checks. */
  readonly #loading: Promise<ChannelChecks | undefined> | undefined;
  /** Sends waiting for a check, in order. */
  #tail: Promise<void> = Promise.resolve();
  /** How many sends wait for a check. */
  #deferred = 0;
  /** Received frames, handled in order. */
  #rx: Promise<void> = Promise.resolve();
  /** Why this handle closed, once it has. */
  #closed: ChannelClosedError | undefined;
  /** The default request timeout. */
  readonly timeout: number | false;
  /**
   * Where this handle's warnings go: its own client's `logger` (a shared
   * socket logs connection problems through the first handle's).
   */
  readonly logger: Pick<Console, "warn" | "error">;

  /**
   * @param conn    Its socket.
   * @param facts   The channel's facts.
   * @param options Its options.
   * @param config  The client's configuration.
   */
  constructor(
    readonly conn: Connection,
    readonly facts: Facts,
    readonly options: ChannelOptions,
    readonly config: ClientConfig,
  ) {
    this.timeout = config.timeout ?? 30_000;
    this.logger = config.logger ?? console;
    const development = isDevelopment(config);
    const hasSource =
      facts.contract !== undefined || config.schemas !== undefined;
    if (
      config.validate !== false &&
      options.validate !== false &&
      ((hasSource && (development || mayCheck(config.validate))) ||
        mayCheck(options.validate))
    ) {
      const source = config.schemas;
      this.#loading = (checksModule ??= import("./channelChecks"))
        .then((module) =>
          module.createChannelChecks({
            key: facts.path,
            development,
            levels: [config.validate, options.validate],
            contract: facts.contract?.contract,
            meta: facts,
            schemas:
              facts.contract !== undefined || source === undefined
                ? undefined
                : async () =>
                    (
                      (typeof source === "function"
                        ? await source()
                        : source) as { channelSchemas?: object }
                    ).channelSchemas?.[facts.path as never],
            ValidationError,
          }),
        )
        .then(
          (checks) => (this.#checks = checks),
          (error: unknown) => {
            this.logger.error(
              `${facts.path}: the channel's checks failed to load; nothing is checked`,
              error,
            );
            return undefined;
          },
        );
    }
    const state = (): ChannelState =>
      this.#closed === undefined ? conn.state : "closed";
    this.client = {
      send: (type, data, options) => {
        this.#alive();
        this.#outgoing(type, data, options?.validate, (value) =>
          conn.write(conn.codec.encode({ type, data: value }, conn.envelope)),
        )?.catch((error: unknown) => this.#report(error));
      },
      request: (type, data, options = {}) =>
        new Promise((resolve, reject) => {
          this.#alive();
          this.#outgoing(type, data, options.validate, (value) =>
            conn.request(this, type, value, options, resolve, reject),
          )?.catch(reject);
        }),
      sendWhenReady: async (type, data, options = {}) => {
        while (
          this.#alive() &&
          (conn.ws?.bufferedAmount ?? 0) >= (options.highWaterMark ?? 1 << 20)
        )
          await nextFrame();
        await this.#outgoing(type, data, options.validate, (value) =>
          conn.write(conn.codec.encode({ type, data: value }, conn.envelope)),
        );
      },
      on: (name, listener) => {
        let set = this.#listeners.get(name);
        if (set === undefined) this.#listeners.set(name, (set = new Set()));
        set.add(listener);
        return () => void set.delete(listener);
      },
      messages: (type) => this.#messages(type),
      close: () => this.#close(),
      get state() {
        return state();
      },
      get bufferedAmount() {
        return conn.ws?.bufferedAmount ?? 0;
      },
    };
  }

  /** Throws when this handle is closed; `true` otherwise. */
  #alive(): true {
    if (this.#closed !== undefined) throw this.#closed;
    return true;
  }

  /**
   * Checks one outgoing message and writes it with `write`: at once when the
   * check is synchronous and nothing waits before it (a failure under
   * `"throw"` throws here), else in order once its check settled (a promise
   * that rejects with the failure).
   */
  #outgoing(
    type: string,
    data: unknown,
    validate: PartValidation | undefined,
    write: (value: unknown) => void,
  ): Promise<void> | undefined {
    if (this.#loading === undefined) {
      write(data);
      return undefined;
    }
    const checks = this.#checks;
    if (checks !== undefined && this.#deferred === 0) {
      const verdict = checks.send(type, data, validate);
      if (!(verdict instanceof Promise)) {
        write(this.#sent(checks, verdict));
        return undefined;
      }
    }
    this.#deferred++;
    const run = this.#tail.then(async () => {
      const loaded = await this.#loading;
      this.#alive();
      if (loaded === undefined) return write(data);
      write(this.#sent(loaded, await loaded.send(type, data, validate)));
    });
    this.#tail = run.then(
      () => void this.#deferred--,
      () => void this.#deferred--,
    );
    return run;
  }

  /** A send's verdict under the failure mode: the value to write, or a throw. */
  #sent(checks: ChannelChecks, verdict: Verdict): unknown {
    if (verdict.error !== undefined) {
      const mode = checks.onSend;
      if (mode === "throw") throw verdict.error;
      if (mode === "warn") this.logger.warn(verdict.error.message);
      else mode(verdict.error);
    }
    return verdict.value;
  }

  /**
   * A received frame's verdict under the failure mode: the value to deliver,
   * or {@link DROPPED}; `reject` takes a `"throw"` (a request's), else it
   * reaches `$error`.
   */
  async #received(
    type: string,
    data: unknown,
    reject?: (error: unknown) => void,
  ): Promise<unknown> {
    const checks = this.#checks ?? (await this.#loading);
    if (checks === undefined) return data;
    const verdict = await checks.receive(type, data);
    const error = verdict.error;
    if (error === undefined) return verdict.value;
    const mode = checks.onReceive;
    if (mode === "warn") {
      this.logger.warn(error.message);
      return verdict.value;
    }
    if (mode === "drop") {
      this.emit("$invalid", error);
      reject?.(error);
      return DROPPED;
    }
    try {
      if (mode === "throw") throw error;
      mode(error);
      return verdict.value;
    } catch (thrown) {
      if (reject === undefined) this.#report(thrown);
      else reject(thrown);
      return DROPPED;
    }
  }

  /** Hands a reply to its request, after the receive check (in order with the pushes). */
  reply(pending: Pending, data: unknown): void {
    this.#rx = this.#rx.then(async () => {
      const value = await this.#received(pending.reply, data, pending.reject);
      if (value !== DROPPED) pending.resolve(value);
    });
  }

  /** Hands a push to the listeners and iterators, after the receive check, in order. */
  push(message: ChannelMessage): void {
    if (this.#closed !== undefined) return;
    this.#rx = this.#rx.then(async () => {
      const value = await this.#received(message.type, message.data);
      if (value === DROPPED || this.#closed !== undefined) return;
      const frame =
        message.id === undefined
          ? { type: message.type }
          : { type: message.type, id: message.id };
      this.emit(message.type, value, frame);
      for (const iteration of this.#iterations) {
        if (iteration.type === undefined)
          iteration.push({ type: message.type, data: value });
        else if (iteration.type === message.type) iteration.push(value);
      }
    });
  }

  /** Calls the listeners of `name`; `true` when there was one. A listener that throws is logged. */
  emit(name: string, ...args: unknown[]): boolean {
    const set = this.#listeners.get(name);
    for (const listener of set ?? []) {
      try {
        (listener as (...values: unknown[]) => void)(...args);
      } catch (error) {
        this.logger.error(
          `${this.facts.path}: a "${name}" listener threw`,
          error,
        );
      }
    }
    return set !== undefined && set.size > 0;
  }

  /** A failure no caller can see: to `$error`, or the log. */
  #report(error: unknown): void {
    if (!this.emit("$error", error))
      this.logger.warn((error as Error).message ?? error);
  }

  /** `messages()`: an iterator over the pushes. */
  #messages(type: string | undefined): AsyncIterableIterator<unknown> {
    const queue: unknown[] = [];
    let done = this.#closed !== undefined;
    let wake: (() => void) | undefined;
    const iteration: Iteration = {
      type,
      push: (value) => {
        queue.push(value);
        wake?.();
      },
      end: () => {
        done = true;
        wake?.();
      },
    };
    if (!done) this.#iterations.add(iteration);
    const iterator: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        for (;;) {
          if (queue.length > 0) return { value: queue.shift(), done: false };
          if (done) return { value: undefined, done: true };
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
      },
      return: () => {
        this.#iterations.delete(iteration);
        iteration.end();
        queue.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return iterator;
  }

  /** This handle's `close()`. */
  #close(): void {
    if (this.#closed !== undefined) return;
    this.ended(
      new ChannelClosedError(this.facts.path, "the channel is closed"),
      false,
    );
    if (this.conn.handles.size === 0) this.conn.end();
  }

  /** Ends this handle: its requests rejected, its iterators ended, `$state` "closed" (and `$error` for a close the client will not retry). */
  ended(error: ChannelClosedError, report: boolean): void {
    if (this.#closed !== undefined) return;
    this.#closed = error;
    this.conn.handles.delete(this);
    for (const pending of [...this.requests]) pending.reject(error);
    for (const iteration of this.#iterations) iteration.end();
    this.#iterations.clear();
    if (report) this.#report(error);
    this.emit("$state", "closed");
  }
}

/**
 * Opens a typed channel (§4.1) from a shared `channelContract()` result:
 * typed by its spec, checked by its own schemas.
 *
 * @param api      The client (`createClient`): its `baseUrl` (`http` → `ws`),
 *   `mode`, `validate`, `timeout` and `logger` apply.
 * @param contract The channel's contract, from a browser-safe module.
 * @param options  The URL's `params` and `query`, and {@link ChannelOptions}.
 * @throws TypeError when a message type starts with `$` (the client's
 *   events' prefix).
 */
export function channel<const S extends ChannelSpec>(
  api: { readonly url: (...args: never[]) => string },
  contract: ChannelContract<S>,
  ...options: OpenArgs<ChannelEntryOf<S>>
): ChannelClient<ChannelEntryOf<S>>;
/**
 * Opens a typed channel (§4.1) from a generated descriptor
 * (`channels["/rooms/:room"]` of `bun-client generate --asyncapi`): typed by
 * its `Channels` entry, checked by the generated zod module's
 * `channelSchemas` when the client's `schemas` source has them.
 *
 * @param api        The client (`createClient`).
 * @param descriptor The channel's generated descriptor.
 * @param options    The URL's `params` and `query`, and {@link ChannelOptions}.
 */
export function channel<E extends ChannelEntry>(
  api: { readonly url: (...args: never[]) => string },
  descriptor: ChannelDescriptor<E>,
  ...options: OpenArgs<E>
): ChannelClient<E>;
export function channel(
  api: { readonly url: (...args: never[]) => string },
  source: ChannelContract | ChannelDescriptor,
  options?: object,
): ChannelClient {
  const opened = (options ?? {}) as ChannelOpenOptions<ChannelEntry>;
  const config =
    ((api as unknown as Record<symbol, unknown>)[CONFIG] as
      ClientConfig | undefined) ?? {};
  let facts: Facts;
  if ("spec" in source) {
    const { meta, spec } = source;
    for (const type of [
      ...Object.keys(spec.receives),
      ...Object.keys(spec.sends),
    ])
      if (type.startsWith("$"))
        throw new TypeError(
          `channel(): the message type "${type}" starts with "$", which the client's events use`,
        );
    facts = {
      path: meta.path,
      idField: meta.envelope.idField,
      replies: meta.replies,
      subprotocol: meta.subprotocol,
      contract: source,
    };
  } else {
    facts = {
      path: source.path,
      idField: source.idField ?? "id",
      replies: source.replies ?? {},
      subprotocol: source.subprotocol,
      contract: undefined,
    };
  }
  let url = (api.url as (path: string, options: object) => string)(facts.path, {
    params: opened.params,
    query: opened.query,
  });
  if (!/^[a-z][a-z\d+.-]*:/i.test(url)) {
    const base = (globalThis as { location?: { href?: string } }).location
      ?.href;
    if (!base)
      throw new ClientError(
        `${facts.path}: "${url}" is relative, and there is no page to resolve it against; give the client an absolute baseUrl`,
        { key: facts.path },
      );
    url = new URL(url, base).href;
  }
  url = url.replace(/^http(s?):/i, "ws$1:");
  const key = `${url} ${facts.subprotocol ?? ""}`;
  let conn = SOCKETS.get(key);
  if (conn === undefined) {
    conn = new Connection(key, url, facts, opened, config.logger ?? console);
    SOCKETS.set(key, conn);
  }
  const handle = new Handle(conn, facts, opened, config);
  conn.handles.add(handle);
  // A handle joining an open socket resubscribes at once (the socket's
  // next open runs it with the others).
  if (conn.state === "open")
    void (async () => opened.resubscribe?.(handle.client as never))().catch(
      (error: unknown) =>
        handle.logger.error(`${facts.path}: resubscribe threw`, error),
    );
  return handle.client as unknown as ChannelClient;
}
