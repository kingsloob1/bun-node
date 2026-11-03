/**
 * `@kingsleyweb/bun-client/webrtc`: WebRTC over a typed signalling channel
 * (typed-client plan, `webrtc.md`, PR-R1).
 *
 * ```ts
 * import { channel } from "@kingsleyweb/bun-client/channel";
 * import { connectPeer } from "@kingsleyweb/bun-client/webrtc";
 * import { signalling } from "../shared/signalling"; // bun-common's signallingContract(), browser-safe
 *
 * const sig = channel(api, signalling, { params: { room } });
 * await sig.request("join", { peer: "alice" });
 *
 * // alice calls bob: she offers, once she has a data channel to offer
 * const peer = connectPeer(sig, { to: "bob", iceServers });
 * const chat = peer.createDataChannel("chat");
 *
 * // bob answers whoever calls
 * sig.on("offer", (offer) => {
 *   const peer = connectPeer(sig, { to: offer.from, offer, iceServers });
 *   peer.connection.addEventListener("datachannel", (event) => …);
 * });
 * ```
 *
 * - **The exchange**: the offering side makes an offer on its first data
 *   channel made through `peer.createDataChannel` and on every
 *   `negotiationneeded` the connection fires while no offer is in flight
 *   (node-datachannel's polyfill fires none), and applies the answer; the answering side (`offer` given) answers it, and any later
 *   offer from the same peer. Glare (both offering at once) and perfect
 *   negotiation are the app's: an offer arriving while this side's own waits
 *   for its answer is reported to `onError` and ignored.
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
 * Browser-safe; it imports nothing (the signalling channel is the app's
 * `channel()`), so a page that uses no WebRTC carries none of it.
 */
import type { ChannelClient, ChannelEntry } from "./channel";

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
