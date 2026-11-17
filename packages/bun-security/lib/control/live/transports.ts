/**
 * The live hub's WebSocket channel (ui.md §6, control-plane.md §4: a typed
 * channel at `/live`, with SSE the fallback): `subscribe` and `unsubscribe`
 * frames in, the hub's messages out, as `{ type, data }`.
 *
 * A socket lives on the adapter's own server, so the channel is attached to
 * the adapter (`api.live.attach(adapter)`, which `secureAdmin` calls),
 * after the API's router is mounted; the router passes an upgrade request
 * for `/live` on to it. Before the upgrade answers `101`: the operator is
 * authenticated, a browser's `Origin` must be the API's own or a trusted
 * one, and an operator at their connection limit is refused (`429`).
 */
import type {
  BunHttpAdapter,
  BunRequest,
  BunResponse,
  NextFunction,
} from "@kingsleyweb/bun-common";
import type { ServerWebSocket } from "bun";
import type { LiveCursorDto } from "../contract/live";
import type { Operator, ResolvedSecurityApiOptions } from "../options";
import type { LiveHub, LiveSession } from "./hub";
import {
  BunRouter,
  BunWebSocket,
  defineChannel,
} from "@kingsleyweb/bun-common";
import * as A from "../analyticsSchemas";
import { LIVE_CLOSE_CODES, LIVE_LIMITS } from "../contract/live";
import { ApiProblem } from "../problems";

/** A resume point from `<epoch>:<seq>` (the `resume` query, or `Last-Event-ID`); `undefined` when absent or malformed. */
export function parseResume(
  text: string | undefined,
): LiveCursorDto | undefined {
  if (text === undefined) return undefined;
  const match = /^([\da-f]{1,32}):(\d{1,15})$/.exec(text);
  return match === null
    ? undefined
    : { epoch: match[1], seq: Number(match[2]) };
}

/** Whether a request asks to upgrade to a WebSocket. */
export function isUpgrade(req: BunRequest): boolean {
  return req.request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** The live channel's contract, for the socket and the AsyncAPI document. */
export function liveChannel(path: string) {
  return defineChannel({
    path,
    receives: { subscribe: A.SubscribeFrame, unsubscribe: A.UnsubscribeFrame },
    sends: {
      subscribed: A.LiveSubscribed,
      event: A.LiveEventMessage,
      overview: A.LiveOverview,
      more: A.LiveMore,
      gap: A.LiveGap,
      ban: A.LiveBan,
      "policy.published": A.LiveControl,
      "bundle.compiled": A.LiveControl,
      "approval.created": A.LiveControl,
      "approval.decided": A.LiveControl,
      "breakGlass.used": A.LiveControl,
      "ban.changed": A.LiveControl,
    },
    replies: { subscribe: "subscribed", unsubscribe: "subscribed" },
    meta: {
      name: "liveSocket",
      description:
        "The live hub's WebSocket channel: subscribe to topics (overview, events, policy, approvals), with resume",
    },
  });
}

/**
 * A router holding only the channel, for the AsyncAPI document: the live
 * socket itself is the adapter's ({@link SecurityApiLive.attach}), mounted
 * where the API is, so its path here is `/live` under the same base.
 */
export function liveDocsRouter(): BunRouter {
  const router = new BunRouter();
  // A socket that serves nothing: it only lets the route be declared.
  void new BunWebSocket({
    newInstance: false,
    getServer: () => undefined,
    router,
  });
  const channel = liveChannel("/live");
  router.ws(
    channel.path,
    channel.checks(),
    channel.handler({}),
    channel.options(),
  );
  return router;
}

/** What the hub's API object exposes as `api.live`. */
export interface SecurityApiLive {
  /** The hub. */
  readonly hub: LiveHub;
  /**
   * Registers the WebSocket channel at `<basePath>/live` on `adapter`. Call
   * it after `adapter.use(api.basePath, api.router)`. Idempotent per adapter.
   */
  readonly attach: (adapter: BunHttpAdapter) => void;
  /** After a stored event batch from `service` (PR-CP4's `/agent/events`): its events and counters to the live topics. */
  readonly publishBatch: LiveHub["publishBatch"];
  /** After a ban changes (PR-CP4): a no-op until the `bans:<scope>` topic lands. */
  readonly publishBan: LiveHub["publishBan"];
  /** Closes every live connection (`1001`) and stops the hub. */
  readonly close: () => void;
}

/** The upgrade's operator, for the socket's `open`. */
const OPERATORS = new WeakMap<Request, Operator>();

/** Each socket's session. */
const SESSIONS = new WeakMap<object, LiveSession>();

/** The socket's custom data. */
interface LiveSocketData {
  /** Who connected. */
  readonly operator: Operator | undefined;
}

/** Whether `origin` may open a socket on a request to `req`'s host. */
function trustedOrigin(
  req: BunRequest,
  origin: string | null,
  trusted: readonly string[],
): boolean {
  // A non-browser client sends none; a browser always does on an upgrade.
  if (origin === null) return true;
  if (trusted.includes(origin)) return true;
  try {
    return new URL(origin).host === new URL(req.request.url).host;
  } catch {
    return false;
  }
}

/** `api.live`; see the module's description. */
export function createLive(
  hub: LiveHub,
  options: ResolvedSecurityApiOptions,
): SecurityApiLive {
  const path = `${options.basePath}/live`;
  const channel = liveChannel(path);
  const attached = new WeakSet<BunHttpAdapter>();
  const trusted = options.csrf === false ? [] : options.csrf.origins;

  /** Before the 101: who, from where, and room for one more. */
  const guard = async (
    req: BunRequest,
    _res: BunResponse,
    next: NextFunction,
  ): Promise<void> => {
    try {
      if (!trustedOrigin(req, req.request.headers.get("origin"), trusted)) {
        throw new ApiProblem(
          403,
          "forbidden",
          "a live socket from another origin is refused",
        );
      }
      const operator = await options.authenticate(req);
      if (operator === null) {
        throw new ApiProblem(
          401,
          "unauthenticated",
          "sign in to open the live socket",
        );
      }
      if (hub.sessionsOf(operator) >= LIVE_LIMITS.connectionsPerOperator) {
        throw new ApiProblem(
          429,
          "rate_limited",
          `an operator holds at most ${LIVE_LIMITS.connectionsPerOperator} live connections`,
        );
      }
      OPERATORS.set(req.request, operator);
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const handler = channel.handler<LiveSocketData>({
    subscribe: async (ws, data) => {
      const session = SESSIONS.get(ws);
      if (session === undefined) {
        return { topics: [], refused: [], epoch: hub.epoch, seq: hub.seq };
      }
      return await session.subscribe(data.topics, data.resume);
    },
    unsubscribe: (ws, data) => {
      const session = SESSIONS.get(ws);
      return {
        topics: session?.unsubscribe(data.topics) ?? [],
        refused: [],
        epoch: hub.epoch,
        seq: hub.seq,
      };
    },
  });
  // The channel handles frames; the session lives from open to close.
  const frames = handler as {
    open?: (ws: ServerWebSocket<never>) => void;
    close?: (ws: ServerWebSocket<never>, code: number, reason: string) => void;
  };
  const baseOpen = frames.open;
  const baseClose = frames.close;
  frames.open = (ws) => {
    baseOpen?.call(handler, ws);
    const operator = (ws.data as { custom?: LiveSocketData }).custom?.operator;
    if (operator === undefined) {
      ws.close(LIVE_CLOSE_CODES.accessChanged, "not authenticated");
      return;
    }
    try {
      SESSIONS.set(
        ws,
        hub.open(operator, {
          send: (type, data) => {
            ws.send(JSON.stringify({ type, data }));
          },
          buffered: () => ws.getBufferedAmount(),
          close: (code, reason) => {
            ws.close(code, reason);
          },
        }),
      );
    } catch {
      // Two upgrades raced past the guard: the limit holds at open.
      ws.close(LIVE_CLOSE_CODES.limit, "too many live connections");
    }
  };
  frames.close = (ws, code, reason) => {
    SESSIONS.get(ws)?.closedByClient();
    baseClose?.call(handler, ws, code, reason);
  };

  const live: SecurityApiLive = {
    hub,
    attach: (adapter: BunHttpAdapter) => {
      if (attached.has(adapter)) return;
      attached.add(adapter);
      adapter.ws(
        path,
        guard,
        channel.checks(),
        handler,
        channel.options<LiveSocketData>((req) => ({
          custom: { operator: OPERATORS.get(req.request) },
        })),
      );
    },
    publishBatch: (service, batch) => hub.publishBatch(service, batch),
    publishBan: (ban) => hub.publishBan(ban),
    close: () => hub.close(),
  };
  return Object.freeze(live);
}
