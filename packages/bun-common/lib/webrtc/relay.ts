/**
 * `signallingRelay` (typed-client plan, `webrtc.md` §3, PR-R1): the server
 * half of a {@link signallingContract} channel. It holds no media and needs
 * no WebRTC: it keeps each room's peers by name and forwards an `offer`,
 * `answer` or `candidate` only to the peer it names, in the sender's room.
 *
 * ```ts
 * app.ws(...signallingRelay(signalling, { authorize, maxPeersPerRoom: 8 }));
 * ```
 *
 * - **Rooms** are the route's params (`/rtc/:room`: one room per `room`; a
 *   path without params is one room). A socket joins with `join { peer }`,
 *   answered with `peers` (the others, by name); the others get
 *   `join { peer }`. `leave`, or the socket closing, takes it out, and the
 *   others get `leave { peer }`.
 * - **Forwarding**: a frame for `to` reaches that peer as `{ from, … }`,
 *   `from` being the sender's joined name (never what the frame claims).
 * - **Refusals** are the channel's error frame, `VALIDATION`, echoing the
 *   frame's id, value-free: a frame from a socket that has not joined, for a
 *   peer that is not in the sender's room (another room's peer included:
 *   nothing crosses rooms), or for the sender itself; a `join` while joined,
 *   under a name the room already has, or into a full room. The socket stays
 *   open.
 * - Every frame is checked both ways by the channel (`defineChannel`), so
 *   nothing undeclared is relayed.
 *
 * The rooms live in this process: two relays behind a load balancer do not
 * see each other's peers.
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { BunRequest } from "../BunRequest";
import type { BunResponse } from "../BunResponse";
import type { WebSocketRouteOptions } from "../BunWebSocket";
import type { ChannelContract } from "../contract/channel";
import type { NextFunction, RouterHandler } from "../types/general";
import type { SignallingOptions, SignallingSpec } from "./signalling";
import { defineChannel } from "../channel";
import { channelErrorFrame } from "../contract/channel";

/** {@link signallingRelay}'s options. */
export interface SignallingRelayOptions {
  /**
   * Middleware run before the upgrade, ahead of the channel's own request
   * checks: an auth check that answers `401` (or calls `next(err)`) refuses
   * the socket. Being in the `ws()` chain it runs for a plain `GET` to the
   * path too. Default: none.
   */
  readonly authorize?: RouterHandler;
  /**
   * The most peers a room holds (1–1024); a `join` into a full room is
   * refused. Default `8`: a full mesh of WebRTC peers grows as the square of
   * the room.
   */
  readonly maxPeersPerRoom?: number;
}

/** What `app.ws(...)` takes from {@link signallingRelay}: the path, the upgrade's middleware, the handler, the route options. */
export type SignallingRoute<P extends string = string> = readonly [
  path: P,
  middleware: (req: BunRequest, res: BunResponse, next: NextFunction) => void,
  handler: WebSocketHandler<never>,
  options: WebSocketRouteOptions<never>,
];

/** A joined socket's place: its room's key, and its name there. */
interface Member {
  /** The room's key (its params, in a fixed order). */
  readonly room: string;
  /** The peer's name in the room. */
  readonly peer: string;
}

/** The frame a handler is given beside its data. */
interface Frame {
  /** The frame's correlation id, when it carried one. */
  readonly id: string | undefined;
}

/** A room's key: the socket's route params, sorted, so `{ a, b }` and `{ b, a }` are one room. */
function roomOf(ws: ServerWebSocket<unknown>): string {
  const params = (ws.data as { params?: Record<string, unknown> } | undefined)
    ?.params;
  if (params === undefined || params === null) return "[]";
  return JSON.stringify(
    Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * Serves a {@link signallingContract} channel: returns the `ws()` route's
 * arguments, `[path, middleware, handler, options]`, for
 * `app.ws(...signallingRelay(signalling))` on a `BunHttpAdapter`, a bun-nest
 * adapter or a `BunRouter` with a `BunWebSocket`. Each call keeps its own
 * rooms.
 *
 * @param contract The `signallingContract()` result, from the module the
 *   client shares.
 * @param options The upgrade's `authorize` middleware and the room size.
 * @throws TypeError when `maxPeersPerRoom` is not a whole number 1–1024.
 */
export function signallingRelay<const O extends SignallingOptions>(
  contract: ChannelContract<SignallingSpec<O>>,
  options: SignallingRelayOptions = {},
): SignallingRoute<O["path"]> {
  const max = options.maxPeersPerRoom ?? 8;
  if (!Number.isInteger(max) || max < 1 || max > 1_024) {
    throw new TypeError(
      "signallingRelay(): maxPeersPerRoom must be a whole number from 1 to 1024",
    );
  }
  const channel = defineChannel(
    contract as unknown as ChannelContract<SignallingSpec>,
  );
  /** Each room's peers, by name. */
  const rooms = new Map<string, Map<string, ServerWebSocket<unknown>>>();
  /** Each joined socket's place. */
  const members = new WeakMap<object, Member>();

  /** Answers `ws` with a `VALIDATION` error frame for the message `type`, its issue at `path` (value-free). */
  const refuse = (
    ws: ServerWebSocket<unknown>,
    type: string,
    path: string,
    message: string,
    frame: Frame,
  ): void => {
    ws.send(
      JSON.stringify(
        channelErrorFrame(
          "VALIDATION",
          { issues: [{ target: "data", key: type, path, message }] },
          frame.id,
        ),
      ),
    );
  };

  /** Takes `ws` out of its room, telling the others; nothing when it never joined. */
  const depart = (ws: ServerWebSocket<unknown>): void => {
    const me = members.get(ws);
    if (me === undefined) return;
    members.delete(ws);
    const room = rooms.get(me.room);
    if (room === undefined) return;
    room.delete(me.peer);
    if (room.size === 0) rooms.delete(me.room);
    for (const other of room.values()) {
      void channel.send(other, "leave", { peer: me.peer });
    }
  };

  /** The peer `to` in the sender's room, or `undefined` after refusing the frame. */
  const target = (
    ws: ServerWebSocket<unknown>,
    type: string,
    to: string,
    frame: Frame,
  ): { from: string; ws: ServerWebSocket<unknown> } | undefined => {
    const me = members.get(ws);
    if (me === undefined) {
      refuse(ws, type, "", "Join the room first", frame);
      return undefined;
    }
    const peer = rooms.get(me.room)?.get(to);
    if (peer === undefined || peer === ws) {
      refuse(ws, type, "to", "No such peer in this room", frame);
      return undefined;
    }
    return { from: me.peer, ws: peer };
  };

  const handler = channel.handler({
    join(ws, data, frame) {
      if (members.has(ws)) {
        refuse(ws, "join", "", "Already joined: send leave first", frame);
        return undefined;
      }
      const key = roomOf(ws);
      let room = rooms.get(key);
      if (room?.has(data.peer) === true) {
        refuse(ws, "join", "peer", "This name is taken in the room", frame);
        return undefined;
      }
      if ((room?.size ?? 0) >= max) {
        refuse(ws, "join", "", `The room is full (${max} peers)`, frame);
        return undefined;
      }
      const others = [...(room?.keys() ?? [])];
      for (const other of room?.values() ?? []) {
        void channel.send(other, "join", { peer: data.peer });
      }
      if (room === undefined) {
        room = new Map();
        rooms.set(key, room);
      }
      room.set(data.peer, ws);
      members.set(ws, { room: key, peer: data.peer });
      return { peers: others };
    },
    leave(ws) {
      depart(ws);
    },
    offer(ws, data, frame) {
      const to = target(ws, "offer", data.to, frame);
      if (to === undefined) return;
      void channel.send(to.ws, "offer", {
        from: to.from,
        description: data.description,
      });
    },
    answer(ws, data, frame) {
      const to = target(ws, "answer", data.to, frame);
      if (to === undefined) return;
      void channel.send(to.ws, "answer", {
        from: to.from,
        description: data.description,
      });
    },
    candidate(ws, data, frame) {
      const to = target(ws, "candidate", data.to, frame);
      if (to === undefined) return;
      void channel.send(to.ws, "candidate", {
        from: to.from,
        candidate: data.candidate,
      });
    },
  });
  // A closed socket leaves its room. Wrapped in place, so the handler keeps
  // the contract `defineChannel` attached to it.
  const close = handler.close?.bind(handler);
  handler.close = (ws, code, reason) => {
    depart(ws);
    return close?.(ws, code, reason);
  };

  const checks = channel.checks();
  const authorize = options.authorize;
  const middleware =
    authorize === undefined
      ? checks
      : (req: BunRequest, res: BunResponse, next: NextFunction): void => {
          void authorize(req, res, (error?: string | Error) =>
            error === undefined ? checks(req, res, next) : next(error),
          );
        };
  return [contract.spec.path, middleware, handler, channel.options()] as const;
}
