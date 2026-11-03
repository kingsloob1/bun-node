/**
 * `@kingsleyweb/bun-client/webrtc`: WebRTC over a typed signalling channel,
 * and typed data channels (typed-client plan, `webrtc.md`, PR-R1 and PR-R2).
 *
 * ```ts
 * import { channel } from "@kingsleyweb/bun-client/channel";
 * import { connectPeer, typedDataChannel } from "@kingsleyweb/bun-client/webrtc";
 * import { signalling } from "../shared/signalling"; // bun-common's signallingContract(), browser-safe
 * import { chat } from "../shared/chat"; // channelContract({ … }), browser-safe
 *
 * const sig = channel(api, signalling, { params: { room } });
 * await sig.request("join", { peer: "alice" });
 *
 * // alice calls bob: she offers, once she has a data channel to offer
 * const peer = connectPeer(sig, { to: "bob", iceServers });
 * const dc = typedDataChannel(peer.createDataChannel("chat"), chat, { side: "client" });
 * dc.send("say", { text: "hi" });              // checked, typed
 * dc.on("said", (m) => …);
 * await dc.sendWhenReady("say", big);           // waits on bufferedamountlow
 *
 * // bob answers whoever calls, and plays the contract's other side
 * sig.on("offer", (offer) => {
 *   const peer = connectPeer(sig, { to: offer.from, offer, iceServers });
 *   peer.connection.addEventListener("datachannel", (event) => {
 *     const dc = typedDataChannel(event.channel, chat, { side: "server" });
 *   });
 * });
 * ```
 *
 * `connectPeer` (PR-R1):
 *
 * - **The exchange**: the offering side makes an offer on its first data
 *   channel made through `peer.createDataChannel` and on every
 *   `negotiationneeded` the connection fires while no offer is in flight
 *   (node-datachannel's polyfill fires none), and applies the answer; the
 *   answering side (`offer` given) answers it, and any later offer from the
 *   same peer. Glare (both offering at once) and perfect negotiation are the
 *   app's: an offer arriving while this side's own waits for its answer is
 *   reported to `onError` and ignored.
 * - **Trickle ICE**: each local candidate is sent as it is gathered (queued
 *   until this side's description has gone out); each remote one is queued
 *   until `setRemoteDescription` resolves, then added. libdatachannel throws
 *   on a candidate that arrives before its description (`webrtc.md` §2).
 * - **Refused candidates** (`addIceCandidate` rejecting: stacks parse each
 *   other's candidates differently) are reported to `onCandidateError` and
 *   are not fatal: the pair connects on the rest.
 * - **Only `to`'s frames** are taken; others' are left to other peers.
 * - **Any `RTCPeerConnection`**: a browser's (the default, the global), or a
 *   Bun library's through `rtc` (node-datachannel's polyfill, werift): Bun
 *   has none of its own.
 *
 * `typedDataChannel` (PR-R2):
 *
 * - **The channel envelope** (`{ type, <idField>?, data }` as JSON text),
 *   so one `channelContract()` serves a WebSocket channel and a data
 *   channel. Between peers there is no server: `side` says which of the
 *   contract's sides this peer plays (`"client"` sends `receives`,
 *   `"server"` sends `sends`), or `symmetric: true` reads `receives` both
 *   ways, with `replies` in both directions.
 * - **Checked both ways**, on the channel client's policy (TC §5.6): a send
 *   through the contract's sender guard (a failure throws `ValidationError`
 *   and writes nothing), what arrives through its receiver guard (a failure
 *   warns and delivers; `"drop"` discards it and fires `$invalid`; `"throw"`
 *   rejects a waiting request), on in development and off in production, BYO
 *   per message type. The guards load lazily (`./channelChecks`).
 * - **Requests**: `request(type, data)` stamps the envelope's id and
 *   resolves with the reply type's frame carrying it; the answering peer's
 *   listener for a requested type returns the reply (or a promise of it).
 *   An unreliable channel (`ordered: false`, `maxRetransmits`,
 *   `maxPacketLifeTime`) refuses requests: a lost reply would hang them.
 * - **Backpressure**: `sendWhenReady()` waits until the channel is open and
 *   its `bufferedAmount` is at most `highWaterMark`, on the
 *   `bufferedamountlow` event (no polling); `send` never waits (sends made
 *   while the channel connects are written, in order, once it opens).
 * - **Binary**: with `binary: { maxBytes }`, raw binary frames pass (kind
 *   and size checked, the content the app's) and arrive as `Uint8Array`
 *   whatever the stack delivers (`ArrayBuffer`, a `Uint8Array`, a `Blob`).
 *
 * Browser-safe; it imports nothing but the error classes (the signalling
 * channel is the app's `channel()`), so a page that uses no WebRTC carries
 * none of it.
 */
import type {
  ChannelContract,
  ChannelSpec,
  ValidationIssue,
} from "@kingsleyweb/bun-contract";
import type {
  ChannelClient,
  ChannelEntry,
  ChannelEntryOf,
  ChannelValidationConfig,
} from "./channel";
import type { ChannelChecks, Verdict } from "./channelChecks";
import type { ChannelFailureCode } from "./errors";
import type { Jsonify } from "./jsonify";
import type { PartValidation } from "./types";
import {
  ChannelClosedError,
  ChannelError,
  RequestTimeoutError,
  ValidationError,
} from "./errors";

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

/** A session description, as signalling carries it (`RTCSessionDescriptionInit`). */
export interface SessionDescriptionInit {
  /** `"offer"`, `"answer"`, `"pranswer"` or `"rollback"` (`RTCSdpType`). */
  type: "offer" | "answer" | "pranswer" | "rollback";
  /** The SDP. */
  sdp?: string;
}

/** An ICE candidate, as signalling carries it (`RTCIceCandidateInit`). */
export interface IceCandidateInit {
  /** The candidate line, `""` for the end of candidates. */
  candidate: string;
  /** The media stream's identification tag, when known. */
  sdpMid?: string | null;
  /** The index of the media description, when known. */
  sdpMLineIndex?: number | null;
  /** The ICE username fragment, when known. */
  usernameFragment?: string | null;
}

/**
 * What {@link connectPeer} needs of an `RTCPeerConnection`: the W3C surface a
 * browser's, node-datachannel's polyfill and werift's share. Events are
 * listened to with `addEventListener` when it exists, else through the
 * `on<event>` property (chained to any handler already there).
 */
export interface PeerConnectionLike {
  /** Creates an offer. */
  createOffer: () => Promise<SessionDescriptionInit>;
  /** Creates an answer to the remote offer. */
  createAnswer: () => Promise<SessionDescriptionInit>;
  /** Sets the local description. */
  setLocalDescription: (description: SessionDescriptionInit) => Promise<void>;
  /** Sets the remote description. */
  setRemoteDescription: (description: SessionDescriptionInit) => Promise<void>;
  /** Adds a remote candidate. */
  addIceCandidate: (candidate: IceCandidateInit) => Promise<void>;
  /** The local description once set (its SDP then carries the gathered candidates). */
  readonly localDescription: SessionDescriptionInit | null;
  /** Creates a data channel (on the offering side, before or after `connectPeer`: it starts the negotiation). */
  createDataChannel: (label: string, init?: never) => unknown;
  /** Closes the connection. */
  close: () => void;
}

/** An `RTCPeerConnection` constructor: the global one, or a library's. */
export type PeerConnectionConstructor<
  PC extends PeerConnectionLike = PeerConnectionLike,
> = new (configuration: Record<string, unknown>) => PC;

/**
 * A signalling channel's entry, as far as {@link connectPeer} reads it:
 * bun-common's `signallingContract()` channel, opened with `channel()`, has
 * this shape (and more: `join`, `leave`, `peers`).
 */
export interface SignallingEntry extends ChannelEntry {
  /** What the client sends. */
  receives: {
    /** An offer for `to`. */
    offer: { to: string; description: SessionDescriptionInit };
    /** An answer for `to`. */
    answer: { to: string; description: SessionDescriptionInit };
    /** A candidate for `to`. */
    candidate: { to: string; candidate: IceCandidateInit };
  };
  /** What the relay sends. */
  sends: {
    /** An offer from `from`. */
    offer: { from: string; description: SessionDescriptionInit };
    /** An answer from `from`. */
    answer: { from: string; description: SessionDescriptionInit };
    /** A candidate from `from`. */
    candidate: { from: string; candidate: IceCandidateInit };
  };
}

/** {@link connectPeer}'s options. */
export interface ConnectPeerOptions<
  PC extends PeerConnectionLike = PeerConnectionLike,
> {
  /** The peer to connect to: its name in the room (what it joined as). */
  to: string;
  /**
   * The offer to answer: the `offer` message received from `to` (its data,
   * `{ from, description }`), or its description. Given, this side answers;
   * absent, it offers. Default: none (offer).
   */
  offer?: { description: SessionDescriptionInit } | SessionDescriptionInit;
  /**
   * The `RTCPeerConnection` constructor: node-datachannel's polyfill
   * (`node-datachannel/polyfill`) or werift's in Bun. Default: the global
   * one (a browser's); none there throws a `TypeError`.
   */
  rtc?: PeerConnectionConstructor<PC>;
  /** The STUN and TURN servers (`RTCConfiguration.iceServers`). Default: none (host candidates only). */
  iceServers?: readonly {
    /** The server's URL, or several. */
    urls: string | readonly string[];
    /** A TURN server's user name. */
    username?: string;
    /** A TURN server's credential. */
    credential?: string;
  }[];
  /** The rest of the `RTCConfiguration` (`iceTransportPolicy`, `bundlePolicy`, …), under `iceServers`. Default: none. */
  configuration?: Readonly<Record<string, unknown>>;
  /**
   * A remote candidate `addIceCandidate` refused: not fatal (the pair
   * connects on the others). Default: none (ignored).
   */
  onCandidateError?: (error: unknown, candidate: IceCandidateInit) => void;
  /**
   * The negotiation failed: a description refused, an offer or answer that
   * could not be made or sent, an offer in glare. Default: none (ignored).
   */
  onError?: (error: unknown) => void;
}

/** What {@link connectPeer} returns: the connection, and the negotiation over the signalling channel. */
export interface Peer<PC extends PeerConnectionLike = PeerConnectionLike> {
  /** The `RTCPeerConnection` (its events, its tracks, its state). */
  readonly connection: PC;
  /** The peer connected to. */
  readonly to: string;
  /** The connection's `createDataChannel`: on the offering side, the first one starts the negotiation. */
  readonly createDataChannel: PC["createDataChannel"];
  /** Stops listening on the signalling channel and closes the connection. The channel stays open. */
  close: () => void;
}

/* ------------------------------------------------------------------------ */
/* Runtime                                                                   */
/* ------------------------------------------------------------------------ */

/** The signalling channel as {@link connectPeer} drives it. */
interface Signalling {
  /** Sends a message. */
  send: (type: string, data: unknown) => void;
  /** Listens for a message type; returns the remover. */
  on: (type: string, listener: (data: never) => void) => () => void;
}

/** An event target, by `addEventListener` or by `on<event>`. */
type Target = Partial<
  Record<
    "addEventListener" | "removeEventListener",
    (type: string, listener: (event: never) => void) => void
  >
> &
  Record<string, unknown>;

/** Listens for `type` on `target`; returns the remover. */
function listen(
  target: object,
  type: string,
  listener: (event: never) => void,
): () => void {
  const on = target as Target;
  if (typeof on.addEventListener === "function") {
    on.addEventListener(type, listener);
    return () => on.removeEventListener?.(type, listener);
  }
  const property = `on${type}`;
  const previous = on[property];
  on[property] = (event: never): void => {
    if (typeof previous === "function") (previous as typeof listener)(event);
    listener(event);
  };
  return () => {
    on[property] = previous;
  };
}

/** A gathered candidate as signalling carries it; `undefined` for the end of gathering (a `null` candidate). */
function candidateInit(candidate: unknown): IceCandidateInit | undefined {
  if (candidate === null || typeof candidate !== "object") return undefined;
  const json = (
    typeof (candidate as { toJSON?: unknown }).toJSON === "function"
      ? (candidate as { toJSON: () => unknown }).toJSON()
      : candidate
  ) as Partial<IceCandidateInit>;
  if (typeof json.candidate !== "string") return undefined;
  return {
    candidate: json.candidate,
    sdpMid: json.sdpMid ?? null,
    sdpMLineIndex: json.sdpMLineIndex ?? null,
    ...(typeof json.usernameFragment === "string"
      ? { usernameFragment: json.usernameFragment }
      : {}),
  };
}

/** The description to answer, from {@link ConnectPeerOptions.offer}. */
function offeredDescription(
  offer: NonNullable<ConnectPeerOptions<PeerConnectionLike>["offer"]>,
): SessionDescriptionInit {
  return "description" in offer ? offer.description : offer;
}

/**
 * Connects to the peer `to` over a signalling channel (bun-common's
 * `signallingContract()`, opened with `channel()` and joined): makes the
 * `RTCPeerConnection` and runs the offer/answer exchange and trickle ICE
 * over the channel. Offers, unless `offer` is given (then it answers). The
 * data channels and tracks are the app's, on `peer.connection`.
 *
 * @param sig The signalling channel, joined to the room.
 * @param options The peer, the role (`offer`), the `RTCPeerConnection` and
 *   its configuration, and the reports.
 * @throws TypeError when no `rtc` is given and the runtime has no
 *   `RTCPeerConnection` (Bun).
 */
export function connectPeer<
  E extends SignallingEntry,
  PC extends PeerConnectionLike = PeerConnectionLike,
>(sig: ChannelClient<E>, options: ConnectPeerOptions<PC>): Peer<PC> {
  const Rtc =
    options.rtc ??
    (
      globalThis as unknown as {
        RTCPeerConnection?: PeerConnectionConstructor<PC>;
      }
    ).RTCPeerConnection;
  if (Rtc === undefined) {
    throw new TypeError(
      "connectPeer(): this runtime has no RTCPeerConnection; pass `rtc` (node-datachannel's polyfill, or werift's, in Bun)",
    );
  }
  const { to } = options;
  const channel = sig as unknown as Signalling;
  const connection = new Rtc({
    ...options.configuration,
    ...(options.iceServers === undefined
      ? {}
      : { iceServers: options.iceServers }),
  });
  const fail = (error: unknown): void => {
    options.onError?.(error);
  };

  /** Local candidates gathered before this side's description went out. */
  let outbox: IceCandidateInit[] | undefined = [];
  /** Remote candidates received before the remote description was set. */
  let inbox: IceCandidateInit[] | undefined = [];
  /** Whether this side's offer waits for its answer. */
  let awaitingAnswer = false;
  /** The offer being made, until it is sent (or fails). */
  let offering: Promise<void> | undefined;
  /** Whether this side has offered (the first `createDataChannel` offers, once). */
  let offered = false;
  /** Whether {@link close} ran. */
  let closed = false;
  /** The offer to answer, when this side answers. */
  const initial =
    options.offer === undefined ? undefined : offeredDescription(options.offer);

  const addCandidate = (candidate: IceCandidateInit): void => {
    connection.addIceCandidate(candidate).catch((error: unknown) => {
      options.onCandidateError?.(error, candidate);
    });
  };
  /** The remote description is set: add the candidates that waited for it. */
  const remoteReady = (): void => {
    const waiting = inbox;
    inbox = undefined;
    for (const candidate of waiting ?? []) addCandidate(candidate);
  };
  /** This side's description went out: send the candidates that waited for it. */
  const localSent = (): void => {
    const waiting = outbox;
    outbox = undefined;
    for (const candidate of waiting ?? []) {
      channel.send("candidate", { to, candidate });
    }
  };
  /** The SDP to send: the local description's once set (it may carry candidates), else what was created. */
  const sdpOf = (created: SessionDescriptionInit): string | undefined =>
    connection.localDescription?.sdp ?? created.sdp;

  const makeOffer = async (): Promise<void> => {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (closed) return;
    awaitingAnswer = true;
    channel.send("offer", {
      to,
      description: { type: "offer", sdp: sdpOf(offer) },
    });
    localSent();
  };
  const answer = async (description: SessionDescriptionInit): Promise<void> => {
    await connection.setRemoteDescription(description);
    remoteReady();
    const created = await connection.createAnswer();
    await connection.setLocalDescription(created);
    if (closed) return;
    channel.send("answer", {
      to,
      description: {
        type: created.type === "pranswer" ? "pranswer" : "answer",
        sdp: sdpOf(created),
      },
    });
    localSent();
  };

  const removers = [
    listen(connection, "icecandidate", (event: { candidate?: unknown }) => {
      const candidate = candidateInit(event.candidate);
      if (candidate === undefined || closed) return;
      if (outbox === undefined) {
        try {
          channel.send("candidate", { to, candidate });
        } catch (error) {
          fail(error);
        }
      } else outbox.push(candidate);
    }),
    channel.on(
      "candidate",
      (data: { from: string; candidate: IceCandidateInit }) => {
        if (data.from !== to || closed) return;
        if (inbox === undefined) addCandidate(data.candidate);
        else inbox.push(data.candidate);
      },
    ),
    channel.on(
      "answer",
      (data: { from: string; description: SessionDescriptionInit }) => {
        if (data.from !== to || closed || !awaitingAnswer) return;
        awaitingAnswer = false;
        connection
          .setRemoteDescription(data.description)
          .then(remoteReady, fail);
      },
    ),
    channel.on(
      "offer",
      (data: { from: string; description: SessionDescriptionInit }) => {
        if (data.from !== to || closed) return;
        // The offer given as `options.offer` reaches this listener too when
        // the app opened the peer from its own `offer` listener (the channel
        // calls a listener added while it dispatches): it is answered once.
        if (data.description === initial) return;
        if (awaitingAnswer || offering !== undefined) {
          fail(
            new Error(
              `connectPeer(): an offer from "${to}" while this side's own waits for its answer (glare): ignored`,
            ),
          );
          return;
        }
        answer(data.description).catch(fail);
      },
    ),
  ];

  /**
   * Offers, unless an offer is already being made or waits for its answer:
   * a browser that still needs a negotiation then asks again once the
   * connection is stable.
   */
  const offer = (): void => {
    if (closed || offering !== undefined || awaitingAnswer) return;
    offered = true;
    offering = makeOffer()
      .catch(fail)
      .finally(() => {
        offering = undefined;
      });
  };
  if (initial === undefined) {
    // The offering side: an offer per negotiation the connection asks for
    // (a browser's first data channel or track, or a renegotiation)...
    removers.push(listen(connection, "negotiationneeded", offer));
  } else {
    answer(initial).catch(fail);
  }
  /**
   * ...and on the first data channel made through the peer, a microtask
   * later (so channels made together go in one offer): node-datachannel's
   * polyfill never fires `negotiationneeded` (0.33.6, measured).
   */
  const createDataChannel = ((...args: Parameters<PC["createDataChannel"]>) => {
    const made = (
      connection.createDataChannel as (...values: unknown[]) => unknown
    ).apply(connection, args);
    if (initial === undefined && !offered) queueMicrotask(offer);
    return made;
  }) as PC["createDataChannel"];

  return {
    connection,
    to,
    createDataChannel,
    close() {
      if (closed) return;
      closed = true;
      for (const remove of removers) remove();
      connection.close();
    },
  };
}

/* ------------------------------------------------------------------------ */
/* typedDataChannel: types                                                   */
/* ------------------------------------------------------------------------ */

/**
 * What {@link typedDataChannel} needs of an `RTCDataChannel`: the W3C
 * surface a browser's, node-datachannel's polyfill and werift's share.
 * Events are listened to as {@link PeerConnectionLike}'s are.
 */
export interface DataChannelLike {
  /** `"connecting"`, `"open"`, `"closing"` or `"closed"`. */
  readonly readyState: string;
  /** Bytes queued, not yet sent. */
  readonly bufferedAmount: number;
  /** The `bufferedamountlow` event's threshold (`sendWhenReady` sets it). */
  bufferedAmountLowThreshold: number;
  /** How binary frames arrive (set to `"arraybuffer"`; a stack may ignore it). */
  binaryType?: string;
  /** `false` on an unordered channel. */
  readonly ordered?: boolean;
  /** Set on a channel with limited retransmits. */
  readonly maxRetransmits?: number | null;
  /** Set on a channel with a limited packet lifetime. */
  readonly maxPacketLifeTime?: number | null;
  /** Sends a text frame (binary frames go through the same method). */
  send: (data: string) => void;
  /** Closes the channel. */
  close: () => void;
}

/** This peer's view of a contract: what it sends and receives, what it may request, and what it answers. */
interface PeerView {
  /** Each message type this peer sends, to its data's wire type. */
  sends: object;
  /** Each message type this peer receives, to its data's wire type (it sees it after JSON). */
  receives: object;
  /** A type this peer may request, to the type answering it. */
  requests: object;
  /** A type this peer answers, to the type its answer is sent as. */
  answers: object;
}

/** `S` read from one peer's side (`typedDataChannel`'s `side` or `symmetric`). */
export type DataChannelView<
  S extends ChannelSpec,
  D extends "client" | "server" | "symmetric",
> =
  ChannelEntryOf<S> extends infer E extends {
    receives: object;
    sends: object;
    replies: object;
  }
    ? D extends "client"
      ? {
          sends: E["receives"];
          receives: E["sends"];
          requests: E["replies"];
          answers: Record<never, never>;
        }
      : D extends "server"
        ? {
            sends: E["sends"];
            receives: E["receives"];
            requests: Record<never, never>;
            answers: E["replies"];
          }
        : {
            sends: E["receives"];
            receives: E["receives"];
            requests: E["replies"];
            answers: E["replies"];
          }
    : never;

/** A message's arguments after its type: its data (none for a message without), then the call's options. */
type DataArgs<D, O> = [D] extends [undefined]
  ? [data?: undefined, options?: O]
  : undefined extends D
    ? [data?: D, options?: O]
    : [data: D, options?: O];

/** The types this peer sends. */
type SendType<V extends PeerView> = keyof V["sends"] & string;

/** The types this peer receives. */
type ReceiveType<V extends PeerView> = keyof V["receives"] & string;

/** The types `request()` takes: those `requests` maps to a type this peer receives. */
type RequestType<V extends PeerView> = {
  [T in SendType<V>]: T extends keyof V["requests"]
    ? V["requests"][T] extends ReceiveType<V>
      ? T
      : never
    : never;
}[SendType<V>];

/** A received message's data, after JSON. */
type Data<V extends PeerView, T> = Jsonify<
  V["receives"][T & keyof V["receives"]]
>;

/** What a listener for `T` returns: for a type this peer answers, the answer's wire input (or a promise of it), else nothing. */
type ListenerResult<V extends PeerView, T> = T extends keyof V["answers"]
  ? V["answers"][T] extends SendType<V>
    ? | V["sends"][V["answers"][T]]
      | Promise<V["sends"][V["answers"][T]] | undefined>
      | undefined
    : unknown
  : unknown;

/** The data channel's state: its `readyState`. */
type DataChannelState = "connecting" | "open" | "closing" | "closed";

/** What `on` takes: a received type, or an event of the wrapper's. */
type DataChannelEventName<V extends PeerView> =
  ReceiveType<V> | "$state" | "$error" | "$invalid" | "$binary";

/** The listener for `N`. */
type DataChannelListener<V extends PeerView, N> = N extends "$state"
  ? (state: DataChannelState) => void
  : N extends "$error"
    ? (error: ChannelError | ValidationError | ChannelClosedError) => void
    : N extends "$invalid"
      ? (error: ValidationError) => void
      : N extends "$binary"
        ? (data: Uint8Array) => void
        : (
            data: Data<V, N>,
            frame: { type: N; id?: string },
          ) => ListenerResult<V, N>;

/** `send`'s options. */
interface DataSendOptions {
  /** This message's validation, over the channel's; `false` skips it. Default: the channel's. */
  validate?: PartValidation;
}

/** `request`'s options. */
interface DataRequestOptions extends DataSendOptions {
  /** Milliseconds before the request rejects with {@link RequestTimeoutError}; `false` for none. Default: the channel's `timeout` (30 s). */
  timeout?: number | false;
}

/** `sendWhenReady`'s options. */
interface DataReadyOptions extends DataSendOptions {
  /** The channel's `bufferedAmount` to wait under, bytes. Default `1_048_576` (1 MiB). */
  highWaterMark?: number;
}

/** {@link typedDataChannel}'s options: the side this peer plays, and the channel's own. */
export type TypedDataChannelOptions = (
  | {
      /**
       * The contract's side this peer plays: `"client"` sends `receives` and
       * receives `sends` (and may request); `"server"` the other way (and
       * answers). One peer plays each.
       */
      side: "client" | "server";
      /** Not with `side`. */
      symmetric?: never;
    }
  | {
      /** Both peers send and receive the contract's `receives` (its `sends` is not read), and request and answer each other by `replies`. */
      symmetric: true;
      /** Not with `symmetric`. */
      side?: never;
    }
) & {
  /**
   * This channel's validation (the channel client's shape: `send`,
   * `receive`, `onFailure`); `false` turns it all off. Default: every
   * message checked in development, none in production, sends throwing and
   * receives warning.
   */
  validate?: ChannelValidationConfig | false;
  /** Development or production, for the validation's defaults. Default: from `NODE_ENV` (development where there is none). */
  mode?: "development" | "production";
  /** A request's timeout, ms; `false` for none. Default `30_000`. */
  timeout?: number | false;
  /**
   * Raw binary frames: each at most `maxBytes`, delivered to
   * `on("$binary")` as a `Uint8Array`; `sendBinary` sends one. Default:
   * none (a binary frame is refused: `$error` with `UNSUPPORTED_DATA`).
   */
  binary?: {
    /** The largest frame, bytes. */
    maxBytes: number;
  };
  /** Where problems are logged. Default: `console`. */
  logger?: Pick<Console, "warn" | "error">;
};

/** The side the options name. */
type SideOf<O> = O extends { symmetric: true }
  ? "symmetric"
  : O extends { side: infer D extends "client" | "server" }
    ? D
    : never;

/** A typed data channel: what {@link typedDataChannel} returns. */
export interface TypedDataChannel<V extends PeerView = PeerView> {
  /**
   * Sends a message, checked first (a failure throws `ValidationError` and
   * writes nothing). Never waits: while the channel connects it is written
   * once it opens. Throws {@link ChannelClosedError} once it is closing or
   * closed.
   */
  send: <T extends SendType<V>>(
    type: T,
    ...args: DataArgs<V["sends"][T], DataSendOptions>
  ) => void;
  /**
   * Sends a request and resolves with its reply's data (a type the
   * contract's `replies` maps); rejects with the peer's error frame
   * ({@link ChannelError}), {@link RequestTimeoutError}, or
   * {@link ChannelClosedError} when the channel closes first. Refused on an
   * unreliable channel (a `TypeError`).
   */
  request: <T extends RequestType<V>>(
    type: T,
    ...args: DataArgs<V["sends"][T], DataRequestOptions>
  ) => Promise<Data<V, V["requests"][T & keyof V["requests"]]>>;
  /** Waits until the channel is open and its `bufferedAmount` is at most `highWaterMark` (on `bufferedamountlow`), then sends; rejects where `send` throws. */
  sendWhenReady: <T extends SendType<V>>(
    type: T,
    ...args: DataArgs<V["sends"][T], DataReadyOptions>
  ) => Promise<void>;
  /** Sends a raw binary frame: a `TypeError` without the `binary` option, a `RangeError` over its `maxBytes`. */
  sendBinary: (data: ArrayBuffer | ArrayBufferView) => void;
  /**
   * Listens for a received message type, or an event: `$state` (each
   * `readyState` change), `$error` (an error frame no request waits for, a
   * deferred send's failure, a frame refused under `"throw"`, a refused
   * binary frame, the close that failed a request), `$invalid` (a frame
   * `"drop"` discarded), `$binary` (a raw binary frame). For a type this
   * peer answers, the listener's return (or the promise's value) is sent as
   * the answer when the frame is a request. Returns the remover; a listener
   * that throws is logged (and a request it answered gets an `EXCEPTION`
   * error frame).
   */
  on: <N extends DataChannelEventName<V>>(
    name: N,
    listener: DataChannelListener<V, N>,
  ) => () => void;
  /** Closes the data channel: waiting requests reject with {@link ChannelClosedError}. */
  close: () => void;
  /** The data channel's `readyState`. */
  readonly state: DataChannelState;
  /** The data channel's `bufferedAmount`: bytes queued, not yet sent. */
  readonly bufferedAmount: number;
}

/* ------------------------------------------------------------------------ */
/* typedDataChannel: runtime                                                 */
/* ------------------------------------------------------------------------ */

/** The checks module, imported on first use and shared by every data channel. */
let checksModule: Promise<typeof import("./channelChecks")> | undefined;

/**
 * The one `process` read here, `process.env.NODE_ENV`, as `client.ts`
 * reads it (a type, erased; a bundler's define replaces it).
 */
declare const process: {
  /** The environment; only `NODE_ENV` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
};

/** Development unless `mode` or `NODE_ENV` says production (TC §5.5). */
function isDevelopment(
  mode: "development" | "production" | undefined,
): boolean {
  if (mode !== undefined) return mode === "development";
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
}

/** Whether a validation level could turn a check on: an object with a key but `onFailure`. */
function mayCheck(level: ChannelValidationConfig | false | undefined): boolean {
  return (
    typeof level === "object" &&
    Object.entries(level).some(
      ([name, value]) =>
        name !== "onFailure" && value !== false && value !== undefined,
    )
  );
}

/** A received frame dropped by its check. */
const DROPPED = Symbol("dropped");

/** A request waiting for its reply. */
interface Waiting {
  /** The request's type. */
  readonly type: string;
  /** The type answering it. */
  readonly reply: string;
  /** Resolves it. */
  readonly resolve: (value: unknown) => void;
  /** Rejects it. */
  readonly reject: (error: unknown) => void;
}

/** Bytes as a `Uint8Array` (a view of the same memory where they are one). */
function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Wraps a data channel in a channel contract (`channelContract()`, shared
 * with the other peer): typed, checked messages both ways in the channel
 * envelope, requests answered by the other peer's listeners,
 * `sendWhenReady` on `bufferedamountlow`, and raw binary frames when
 * `binary` is set. The channel stays the app's: `close()` closes it.
 *
 * @param dc The `RTCDataChannel` (`peer.createDataChannel(label)`, or a
 *   `datachannel` event's), a browser's or a library's.
 * @param contract The shared contract.
 * @param options The side this peer plays (`side` or `symmetric`), the
 *   validation, the request timeout, binary frames, the logger.
 * @throws TypeError when the options name no side, or both.
 */
export function typedDataChannel<
  const S extends ChannelSpec,
  const O extends TypedDataChannelOptions,
>(
  dc: DataChannelLike,
  contract: ChannelContract<S>,
  options: O,
): TypedDataChannel<DataChannelView<S, SideOf<O>>> {
  const symmetric = options.symmetric === true;
  const side = symmetric ? "symmetric" : options.side;
  if (
    (symmetric && options.side !== undefined) ||
    (side !== "client" && side !== "server" && side !== "symmetric")
  ) {
    throw new TypeError(
      'typedDataChannel(): name the side this peer plays: side "client" or "server", or symmetric: true',
    );
  }
  const { spec, meta } = contract;
  const key = meta.path;
  const idField = meta.envelope.idField;
  const logger = options.logger ?? console;
  const development = isDevelopment(options.mode);
  const replies = meta.replies;
  /** What this peer sends and receives, as a contract the checks read (its `receives` what this peer sends). */
  const sends = side === "server" ? spec.sends : spec.receives;
  const receives = side === "client" ? spec.sends : spec.receives;
  /** A type this peer may request, to its reply; a type it answers, to its answer. */
  const requests: Readonly<Record<string, string>> =
    side === "server" ? {} : replies;
  const answers: Readonly<Record<string, string>> =
    side === "client" ? {} : replies;
  const binary = options.binary;
  const reliable =
    dc.ordered !== false &&
    (dc.maxRetransmits ?? null) === null &&
    (dc.maxPacketLifeTime ?? null) === null;

  const listeners = new Map<string, Set<(...args: never[]) => unknown>>();
  const waiting = new Map<string, Waiting>();
  let counter = 0;
  let checks: ChannelChecks | undefined;
  let loading: Promise<ChannelChecks | undefined> = Promise.resolve(undefined);
  /** Writes made while the channel connects, sent in order when it opens. */
  let outbox: (string | Uint8Array)[] = [];
  /** The sends checked later (the checks not loaded yet, or asynchronous), in order. */
  let tail: Promise<void> = Promise.resolve();
  let deferred = 0;
  /** The received frames, handled one at a time, in order. */
  let rx: Promise<void> = Promise.resolve();
  /** The `sendWhenReady` calls, served in order. */
  let ready: Promise<void> = Promise.resolve();
  let closedBy: ChannelClosedError | undefined;

  if (
    options.validate !== false &&
    (development || mayCheck(options.validate))
  ) {
    loading = (checksModule ??= import("./channelChecks"))
      .then((module) =>
        module.createChannelChecks({
          key,
          development,
          levels: [undefined, options.validate],
          // This peer's view, built by the checks as from generated
          // schemas: its sends as the contract's `receives` (the sender
          // guard's side), what it receives as `sends`.
          contract: side === "client" ? contract.contract : undefined,
          meta: { path: key, idField, replies: requests },
          schemas:
            side === "client"
              ? undefined
              : () => Promise.resolve({ receives: sends, sends: receives }),
          ValidationError,
        }),
      )
      .then(
        (loaded) => (checks = loaded),
        (error: unknown) => {
          logger.error(
            `${key}: the data channel's checks failed to load`,
            error,
          );
          return undefined;
        },
      );
  }

  /** Calls the listeners of `name`, returning the first answer one gave. */
  const emit = (name: string, ...args: unknown[]): unknown => {
    let answer: unknown;
    for (const listener of listeners.get(name) ?? []) {
      try {
        const result = (listener as (...values: unknown[]) => unknown)(...args);
        if (answer === undefined) answer = result;
      } catch (error) {
        logger.error(`${key}: a "${name}" listener threw`, error);
        if (answer === undefined)
          answer = Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
      }
    }
    return answer;
  };
  /** A failure no caller can see: to `$error`, or the log. */
  const report = (error: unknown): void => {
    if ((listeners.get("$error")?.size ?? 0) > 0) emit("$error", error);
    else logger.warn((error as Error).message ?? error);
  };
  const state = (): DataChannelState =>
    (["connecting", "open", "closing", "closed"].includes(dc.readyState)
      ? dc.readyState
      : "connecting") as DataChannelState;
  const alive = (): void => {
    if (closedBy !== undefined) throw closedBy;
    if (state() === "closing" || state() === "closed")
      throw new ChannelClosedError(key, "the data channel is closed");
  };
  /** Writes one frame: now when open, once open while connecting. */
  const transmit = (frame: string | Uint8Array): void => {
    alive();
    if (state() === "connecting") outbox.push(frame);
    else (dc.send as (data: string | Uint8Array) => void)(frame);
  };
  const frameText = (type: string, data: unknown, id?: string): string =>
    JSON.stringify(
      id === undefined ? { type, data } : { type, [idField]: id, data },
    );

  /** A send's verdict under the failure mode: the value to write, or a throw. */
  const sent = (loaded: ChannelChecks, verdict: Verdict): unknown => {
    if (verdict.error !== undefined) {
      const mode = loaded.onSend;
      if (mode === "throw") throw verdict.error;
      if (mode === "warn") logger.warn(verdict.error.message);
      else mode(verdict.error);
    }
    return verdict.value;
  };
  /**
   * Checks and writes one message: at once when the checks are loaded and
   * synchronous and nothing waits before it (a failure throws to the
   * caller); otherwise in order behind the others (a failure reaches the
   * returned promise).
   */
  const write = (
    type: string,
    data: unknown,
    validate: PartValidation | undefined,
    id?: string,
  ): Promise<void> | undefined => {
    alive();
    if (
      deferred === 0 &&
      (checks !== undefined || options.validate === false)
    ) {
      const verdict = checks?.send(type, data, validate);
      if (!(verdict instanceof Promise)) {
        const value = verdict === undefined ? data : sent(checks!, verdict);
        transmit(frameText(type, value, id));
        return undefined;
      }
    }
    deferred++;
    const run = tail.then(async () => {
      const loaded = await loading;
      const value =
        loaded === undefined
          ? data
          : sent(loaded, await loaded.send(type, data, validate));
      transmit(frameText(type, value, id));
    });
    tail = run.then(
      () => void deferred--,
      () => void deferred--,
    );
    return run;
  };

  /** A received frame's verdict under the failure mode: the value to deliver, or {@link DROPPED}. */
  const received = async (
    type: string,
    data: unknown,
    reject?: (error: unknown) => void,
  ): Promise<unknown> => {
    const loaded = checks ?? (await loading);
    if (loaded === undefined) return data;
    const verdict = await loaded.receive(type, data);
    const error = verdict.error;
    if (error === undefined) return verdict.value;
    const mode = loaded.onReceive;
    if (mode === "warn") {
      logger.warn(error.message);
      return verdict.value;
    }
    if (mode === "drop") {
      emit("$invalid", error);
      reject?.(error);
      return DROPPED;
    }
    try {
      if (mode === "throw") throw error;
      mode(error);
      return verdict.value;
    } catch (thrown) {
      if (reject === undefined) report(thrown);
      else reject(thrown);
      return DROPPED;
    }
  };

  /** Answers the request `id` with an error frame. */
  const refuse = (
    id: string,
    code: ChannelFailureCode,
    status: number,
    body: { issues?: readonly ValidationIssue[]; detail?: string } = {},
  ): void => {
    try {
      transmit(JSON.stringify({ type: "error", id, code, status, ...body }));
    } catch {
      // Closed meanwhile: nobody to answer.
    }
  };

  /** Handles one JSON frame. */
  const handle = async (frame: Record<string, unknown>): Promise<void> => {
    const type = frame.type;
    const id = typeof frame[idField] === "string" ? frame[idField] : undefined;
    if (typeof type !== "string") {
      logger.warn(`${key}: a frame without a type was ignored`);
      return;
    }
    const pending = id === undefined ? undefined : waiting.get(id);
    if (type === "error" && typeof frame.code === "string") {
      const error = new ChannelError(
        key,
        {
          code: frame.code as ChannelFailureCode,
          status: typeof frame.status === "number" ? frame.status : 400,
          ...(Array.isArray(frame.issues)
            ? { issues: frame.issues as ValidationIssue[] }
            : {}),
          ...(typeof frame.detail === "string" ? { detail: frame.detail } : {}),
        },
        pending?.type,
      );
      if (pending !== undefined) {
        waiting.delete(id!);
        pending.reject(error);
      } else report(error);
      return;
    }
    if (pending !== undefined && pending.reply === type) {
      waiting.delete(id!);
      const value = await received(type, frame.data, pending.reject);
      if (value !== DROPPED) pending.resolve(value);
      return;
    }
    const answer = id === undefined ? undefined : answers[type];
    if (!Object.hasOwn(receives, type)) {
      if (
        id !== undefined &&
        answer === undefined &&
        Object.hasOwn(answers, type) === false
      ) {
        refuse(id, "UNKNOWN_MESSAGE", 400, {
          detail: `Unknown message type (declared: ${Object.keys(receives).join(", ")})`,
        });
      } else logger.warn(`${key}: an undeclared message type was ignored`);
      return;
    }
    let refused: ValidationError | undefined;
    const value = await received(
      type,
      frame.data,
      answer === undefined
        ? undefined
        : (error) => {
            refused = error as ValidationError;
          },
    );
    if (value === DROPPED) {
      if (answer !== undefined && id !== undefined)
        refuse(id, "VALIDATION", 400, { issues: refused?.issues ?? [] });
      return;
    }
    const result = emit(
      type,
      value,
      id === undefined ? { type } : { type, id },
    );
    if (answer === undefined || id === undefined) return;
    try {
      const reply = await result;
      if (reply === undefined) return;
      await write(
        answer,
        spec.sends[answer] === null && side === "server" ? undefined : reply,
        undefined,
        id,
      );
    } catch (error) {
      if (error instanceof ValidationError) report(error);
      refuse(id, "EXCEPTION", 500);
    }
  };

  /** Normalises and handles one `message` event, in order with the others. */
  const onMessage = (event: { data?: unknown }): void => {
    const data = event.data;
    rx = rx.then(async () => {
      if (closedBy !== undefined) return;
      if (typeof data === "string") {
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          logger.warn(`${key}: a frame that is not JSON was ignored`);
          return;
        }
        if (
          typeof frame !== "object" ||
          frame === null ||
          Array.isArray(frame)
        ) {
          logger.warn(`${key}: a frame that is not an object was ignored`);
          return;
        }
        await handle(frame as Record<string, unknown>);
        return;
      }
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        bytes = bytesOf(data);
      } else if (
        typeof (data as { arrayBuffer?: unknown })?.arrayBuffer === "function"
      ) {
        bytes = new Uint8Array(
          await (
            data as { arrayBuffer: () => Promise<ArrayBuffer> }
          ).arrayBuffer(),
        );
      } else {
        logger.warn(`${key}: a frame of an unknown kind was ignored`);
        return;
      }
      if (binary === undefined || bytes.byteLength > binary.maxBytes) {
        report(
          new ChannelError(key, {
            code: "UNSUPPORTED_DATA",
            status: 400,
            detail:
              binary === undefined
                ? "Binary frames are not declared on this data channel"
                : `A binary frame of ${bytes.byteLength} bytes is over the ${binary.maxBytes} declared`,
          }),
        );
        return;
      }
      emit("$binary", bytes);
    });
  };

  /** The channel closed: every request and waiter fails, nothing more is written. */
  const onClose = (): void => {
    closedBy ??= new ChannelClosedError(key, "the data channel closed");
    outbox = [];
    for (const [id, pending] of waiting) {
      waiting.delete(id);
      pending.reject(closedBy);
    }
    emit("$state", "closed");
  };

  if (dc.binaryType !== undefined) dc.binaryType = "arraybuffer";
  listen(dc, "message", onMessage);
  listen(dc, "open", () => {
    const queued = outbox;
    outbox = [];
    for (const frame of queued) {
      try {
        transmit(frame);
      } catch (error) {
        report(error);
      }
    }
    emit("$state", "open");
  });
  listen(dc, "closing", () => emit("$state", "closing"));
  listen(dc, "close", onClose);

  /** Resolves once the channel is open and its buffer at most `mark`, on `open` and `bufferedamountlow`. */
  const drained = (mark: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const removers: (() => void)[] = [];
      const done = (error?: Error): void => {
        for (const remove of removers) remove();
        if (error === undefined) resolve();
        else reject(error);
      };
      const check = (): void => {
        try {
          alive();
        } catch (error) {
          done(error as Error);
          return;
        }
        if (state() === "open" && dc.bufferedAmount <= mark) done();
        else if (state() === "open") dc.bufferedAmountLowThreshold = mark;
      };
      removers.push(
        listen(dc, "open", check),
        listen(dc, "bufferedamountlow", check),
        listen(dc, "close", check),
      );
      check();
    });

  const handleApi: TypedDataChannel = {
    send(type, ...args: unknown[]) {
      const [data, call] = args as [unknown, DataSendOptions | undefined];
      const run = write(type, data, call?.validate);
      run?.catch(report);
    },
    request(type, ...args: unknown[]) {
      const [data, call] = args as [unknown, DataRequestOptions | undefined];
      if (!reliable) {
        return Promise.reject(
          new TypeError(
            `${key}: request() needs a reliable data channel (ordered, no maxRetransmits or maxPacketLifeTime)`,
          ),
        );
      }
      const reply = requests[type];
      if (reply === undefined) {
        return Promise.reject(
          new TypeError(
            `${key}: "${String(type)}" is not a request this peer makes`,
          ),
        );
      }
      const id = String(++counter);
      const timeout = call?.timeout ?? options.timeout ?? 30_000;
      return new Promise<unknown>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle =
          <A extends unknown[]>(f: (...values: A) => void) =>
          (...values: A): void => {
            clearTimeout(timer);
            waiting.delete(id);
            f(...values);
          };
        const entry: Waiting = {
          type,
          reply,
          resolve: settle(resolve),
          reject: settle(reject),
        };
        waiting.set(id, entry);
        if (timeout !== false) {
          timer = setTimeout(
            () => entry.reject(new RequestTimeoutError(key, type, id, timeout)),
            timeout,
          );
        }
        try {
          write(type, data, call?.validate, id)?.catch(entry.reject);
        } catch (error) {
          entry.reject(error);
        }
      }) as never;
    },
    sendWhenReady(type, ...args: unknown[]) {
      const [data, call] = args as [unknown, DataReadyOptions | undefined];
      const mark = call?.highWaterMark ?? 1_048_576;
      const turn = ready.then(() => drained(mark));
      ready = turn.catch(() => undefined);
      return turn.then(() => write(type, data, call?.validate));
    },
    sendBinary(data) {
      if (binary === undefined) {
        throw new TypeError(
          `${key}: binary frames are not declared (typedDataChannel's binary option)`,
        );
      }
      const bytes = bytesOf(data);
      if (bytes.byteLength > binary.maxBytes) {
        throw new RangeError(
          `${key}: a binary frame of ${bytes.byteLength} bytes is over the ${binary.maxBytes} declared`,
        );
      }
      if (deferred === 0) {
        transmit(bytes);
        return;
      }
      deferred++;
      const run = tail.then(() => transmit(bytes));
      tail = run.then(
        () => void deferred--,
        () => void deferred--,
      );
      run.catch(report);
    },
    on(name, listener) {
      let set = listeners.get(name);
      if (set === undefined) listeners.set(name, (set = new Set()));
      const entry = listener as (...args: never[]) => unknown;
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },
    close() {
      if (closedBy === undefined) {
        closedBy = new ChannelClosedError(key, "the data channel was closed");
        for (const [id, pending] of waiting) {
          waiting.delete(id);
          pending.reject(closedBy);
        }
        outbox = [];
      }
      dc.close();
    },
    get state() {
      return state();
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
  };
  return handleApi;
}
