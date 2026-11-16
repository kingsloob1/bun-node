/**
 * `securityWebSocket`: layer L9.5 on a bun-common WebSocket route (layers.md
 * L9.5). An HTTP limit sees the upgrade; once the socket is open it could
 * send without limit. This wraps a route's handlers so each inbound message
 * first passes the policy's `messages` section (`Security.socket()`): a
 * message over a limit is dropped, a second breach within the section's
 * `breach` window closes the connection (1008 by default). Messages are
 * handed on in the order they arrived, also while a shared limit's answer
 * is awaited.
 *
 * ```ts
 * const security = createSecurity({ policy: { messages: { perConnection: { limit: 20, window: "1s" } } } });
 * app.ws("/live", securityWebSocket(security, { message: (ws, data) => { ... } }));
 * ```
 *
 * The connection's facts come from its upgrade (`ws.data`, built by
 * bun-common): the client address as the adapter's `trustProxy` resolved it
 * (`ws.data.ip`), the path, the route, the headers; `identify` adds who is
 * calling, for limits keyed on a user, session, tenant or API key.
 */
import type {
  BunWebSocketHandlerType,
  WebSocketClient,
} from "@kingsleyweb/bun-common";
import { canonicalPath } from "../engine/path";
import { boundedHeaders } from "../engine/facts";
import type { RequestFacts, SecurityIdentity } from "../engine/facts";
import { isThenable } from "../engine/maybe";
import type {
  MessageDecision,
  Security,
  SocketLimiter,
} from "../engine/security";

/** What {@link securityWebSocket} takes beside the engine and the handlers. */
export interface SecurityWebSocketOptions<TCustom = unknown> {
  /**
   * Who is calling on this connection (from `ws.data.user`, `ws.data.custom`),
   * for message limits keyed on a user, session, tenant or API key. Called
   * once, when the connection opens. Default: none (address keys only).
   */
  readonly identify?: (
    ws: WebSocketClient<TCustom>,
  ) => SecurityIdentity | undefined;
  /** Called with each message dropped and each connection closed by a limit, after the fact. Its errors are ignored. */
  readonly onRefused?: (
    ws: WebSocketClient<TCustom>,
    decision: MessageDecision,
  ) => void;
}

/** One connection's limiter and the messages waiting on it. */
interface Guarded {
  /** The limiter; `undefined` when the engine was closed at open (messages pass). */
  readonly limiter: SocketLimiter | undefined;
  /** The decision chain while an answer is awaited. */
  queue: Promise<void> | undefined;
}

/** The facts of a connection's upgrade, from `ws.data`. */
function socketFacts<TCustom>(
  ws: WebSocketClient<TCustom>,
  identity: SecurityIdentity | undefined,
): RequestFacts {
  const data = ws.data as Partial<WebSocketClient<TCustom>["data"]> | undefined;
  const peer = ws.remoteAddress ?? "";
  const rawPath = typeof data?.path === "string" ? data.path : "/";
  const bounded = boundedHeaders(
    data?.headers instanceof Headers ? data.headers : new Headers(),
  );
  return {
    method: "GET",
    path: canonicalPath(rawPath),
    rawPath,
    query:
      typeof data?.search === "string" ? data.search.replace(/^\?/, "") : "",
    headers: bounded.values,
    headerCount: bounded.count,
    headerLengths: bounded.lengths,
    cookieNames: [],
    peer,
    client: typeof data?.ip === "string" && data.ip !== "" ? data.ip : peer,
    chain: [{ address: peer, source: "socket", trusted: false }],
    ...(typeof data?.route === "string"
      ? { routeKey: `GET ${data.route}` }
      : {}),
    ...(identity === undefined ? {} : { identity }),
  };
}

/**
 * `handler` with the policy's WebSocket message limits in front of its
 * `message` (layers.md L9.5); see the module's description. Its other
 * handlers and settings are kept as they are.
 */
export function securityWebSocket<TCustom = unknown>(
  security: Pick<Security<never>, "socket">,
  handler: BunWebSocketHandlerType<TCustom>,
  options: SecurityWebSocketOptions<TCustom> = {},
): BunWebSocketHandlerType<TCustom> {
  const connections = new WeakMap<object, Guarded>();
  const open = (ws: WebSocketClient<TCustom>): Guarded => {
    let limiter: SocketLimiter | undefined;
    try {
      limiter = security.socket(socketFacts(ws, options.identify?.(ws)));
    } catch {
      // A closed engine limits nothing.
      limiter = undefined;
    }
    const guarded: Guarded = { limiter, queue: undefined };
    connections.set(ws, guarded);
    return guarded;
  };
  const refused = (
    ws: WebSocketClient<TCustom>,
    decision: MessageDecision,
  ): void => {
    try {
      options.onRefused?.(ws, decision);
    } catch {
      // The app's hook never breaks the socket.
    }
  };
  return {
    ...handler,
    open(ws) {
      open(ws);
      return handler.open?.(ws);
    },
    message(ws, message) {
      const guarded = connections.get(ws) ?? open(ws);
      const limiter = guarded.limiter;
      if (limiter === undefined) return handler.message(ws, message);
      const act = (decision: MessageDecision): void | Promise<void> => {
        if (decision.action === "allow") return handler.message(ws, message);
        if (decision.action === "close") {
          ws.close(decision.code ?? 1008, decision.reason ?? "rate_limited");
        }
        refused(ws, decision);
        return undefined;
      };
      const decide = (): void | Promise<void> => {
        const decision = limiter.message();
        return isThenable(decision)
          ? Promise.resolve(decision).then(act)
          : act(decision);
      };
      // While an answer is awaited, later messages wait behind it.
      const chain = (pending: Promise<void>): Promise<void> => {
        const tail = pending.catch(() => undefined);
        guarded.queue = tail;
        void tail.then(() => {
          if (guarded.queue === tail) guarded.queue = undefined;
        });
        return pending;
      };
      if (guarded.queue !== undefined) return chain(guarded.queue.then(decide));
      const result = decide();
      return isThenable(result) ? chain(Promise.resolve(result)) : result;
    },
    close(ws, code, reason) {
      connections.delete(ws);
      return handler.close?.(ws, code, reason);
    },
  };
}
