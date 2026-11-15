/**
 * `./serve`: the engine around a plain `Bun.serve` (plan §3.4).
 *
 * ```ts
 * Bun.serve(hardenServe({
 *   port: 443,
 *   fetch: withSecurity(security, async (req, server) => app(req)),
 * }));
 * ```
 *
 * `withSecurity` turns each request into facts (the peer from
 * `server.requestIP()`, the client through bun-common's trust-proxy
 * resolution), asks the engine, and answers a refusal itself; everything
 * else reaches the handler. `hardenServe` sets the listener's own limits.
 */
import process from "node:process";
import {
  ConfigError,
  createLogger,
  resolveLogger,
} from "@kingsleyweb/bun-common";
import type {
  Logger,
  LoggerLike,
  TrustProxyOption,
} from "@kingsleyweb/bun-common";
import { refuses } from "../engine/actions";
import type { Decision } from "../engine/decision";
import { requestFacts } from "../engine/facts";
import type { SecurityIdentity } from "../engine/facts";
import type { Security } from "../engine/security";
import { dropResponse, refusalResponse } from "./respond";

/** The part of a `Bun.serve` server `withSecurity` uses. */
export interface RequestIpServer {
  /** The socket peer of a request, as `Bun.Server#requestIP` returns it. */
  requestIP: (request: Request) => { readonly address: string } | null;
}

/** Options for {@link withSecurity}. */
export interface WithSecurityOptions {
  /**
   * Which proxies in front of this listener to trust, with bun-common's
   * `trustProxy` values (Express's `trust proxy`). Off by default: the
   * client is the socket peer and no forwarding header is read. Spread
   * bun-common's `behindCloudflare()` or `behindRailway()` here. Deploy-time
   * configuration, never policy (plan Q27).
   */
  readonly trustProxy?: TrustProxyOption;
  /** A client-address header set by the outermost trusted proxy; see bun-common's `clientIpHeader`. */
  readonly clientIpHeader?: string;
  /**
   * The answer to a refusal, in place of the default problem+json or HTML
   * page (plan §4.2). Not called for `drop`. If it throws, the default is
   * sent and the error logged.
   */
  readonly renderBlock?: (
    decision: Decision,
    request: Request,
  ) => Response | Promise<Response>;
  /**
   * When the engine itself throws (a bug), answer `503` instead of letting
   * the request through. Default `false`: a defence bug must not take the
   * site down (topologies.md §6.2).
   */
  readonly failClosedOnEngineError?: boolean;
  /** Where engine and hook errors are logged. Default: a console logger named `bun-security`. */
  readonly logger?: LoggerLike;
}

/** The longest a `delay` decision holds a request, in milliseconds (layers.md §0.1's `maxDelayMs`). */
const MAX_DELAY_MS = 2_000;

/** Whether `value` is a promise-like. */
function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Wraps a `Bun.serve` `fetch` handler with the engine: every request is
 * decided before the handler sees it. A refusal is answered here
 * (problem+json, an HTML page, or `renderBlock`'s answer); `drop` closes the
 * connection with no answer; everything else reaches `fetch`. When the
 * engine throws, the request goes through (or gets `503` with
 * `failClosedOnEngineError`) and the error is logged.
 *
 * @param security The engine, from `createSecurity()`.
 * @param fetch    The handler to protect.
 * @param options  Trust and answers; see {@link WithSecurityOptions}.
 */
export function withSecurity<
  TServer extends RequestIpServer,
  TResult extends Response | undefined | void,
>(
  security: Security<Request>,
  fetch: (request: Request, server: TServer) => TResult | Promise<TResult>,
  options: WithSecurityOptions = {},
): (
  request: Request,
  server: TServer,
) => Response | TResult | Promise<Response | TResult> {
  const logger: Logger = resolveLogger(
    options.logger,
    createLogger({ name: "bun-security" }),
  );

  /** The facts of `request`, with `identity`. */
  const factsOf = (
    request: Request,
    server: TServer,
    identity: SecurityIdentity | undefined,
  ) =>
    requestFacts(request, {
      peer: server.requestIP(request)?.address ?? "",
      ...(options.trustProxy === undefined
        ? {}
        : { trustProxy: options.trustProxy }),
      ...(options.clientIpHeader === undefined
        ? {}
        : { clientIpHeader: options.clientIpHeader }),
      ...(identity === undefined ? {} : { identity }),
    });

  /** The engine failed: let the request through, or refuse it with `503`. */
  const engineFailed = (
    error: unknown,
    request: Request,
    server: TServer,
  ): Response | TResult | Promise<Response | TResult> => {
    logger.error(
      "bun-security: the engine threw; the request was not checked",
      { error },
    );
    if (options.failClosedOnEngineError) {
      return refusalResponse(
        {
          action: "block",
          status: 503,
          code: "unavailable",
          retryAfter: 1,
          hits: [],
          tags: [],
          risk: 0,
          subject: {},
        },
        request,
      );
    }
    return fetch(request, server);
  };

  /** The refusal `render` gives `decision`, or the default when it throws. */
  const refuse = async (
    render: NonNullable<WithSecurityOptions["renderBlock"]>,
    decision: Decision,
    request: Request,
  ): Promise<Response> => {
    try {
      return await render(decision, request);
    } catch (error) {
      logger.error(
        "bun-security: renderBlock threw; sent the default refusal",
        { error },
      );
      return refusalResponse(decision, request);
    }
  };

  /** Acts on a decision. */
  const act = (
    decision: Decision,
    request: Request,
    server: TServer,
  ): Response | TResult | Promise<Response | TResult> => {
    if (decision.action === "drop") {
      return dropResponse();
    }
    if (refuses(decision.action)) {
      const render = options.renderBlock;
      return render
        ? refuse(render, decision, request)
        : refusalResponse(decision, request);
    }
    if (
      decision.action === "delay" &&
      decision.delayMs !== undefined &&
      decision.delayMs > 0
    ) {
      return Bun.sleep(Math.min(decision.delayMs, MAX_DELAY_MS)).then(() =>
        fetch(request, server),
      );
    }
    return fetch(request, server);
  };

  return (request, server) => {
    let outcome: Decision | Promise<Decision>;
    try {
      const identity = security.identify(request);
      outcome = isThenable(identity)
        ? Promise.resolve(identity).then((resolved) =>
            security.evaluate(factsOf(request, server, resolved)),
          )
        : security.evaluate(factsOf(request, server, identity));
    } catch (error) {
      return engineFailed(error, request, server);
    }
    if (isThenable(outcome)) {
      return Promise.resolve(outcome).then(
        (decision) => act(decision, request, server),
        (error: unknown) => engineFailed(error, request, server),
      );
    }
    return act(outcome, request, server);
  };
}

/** Options for {@link hardenServe}. */
export interface HardenServeOptions {
  /**
   * Whether this is production, where `development` must be off. Default:
   * `process.env.NODE_ENV === "production"`, read when `hardenServe` runs.
   */
  readonly production?: boolean;
}

/** `hardenServe`'s idle timeout, in seconds: Bun's own default, stated (layers.md L1). */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 10;

/** `hardenServe`'s request body cap, in bytes: 1 MiB (layers.md L1). */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024;

/** The `Bun.serve` options `hardenServe` reads and sets. */
export interface HardenableServeOptions {
  /** Seconds a connection may sit idle before Bun closes it: 1 to 255. */
  idleTimeout?: number;
  /** The largest request body Bun reads, in bytes. */
  maxRequestBodySize?: number;
  /** Bun's development mode (detailed error pages). */
  development?: unknown;
}

/**
 * `Bun.serve` options with the listener's own limits set (layers.md L1):
 * `idleTimeout` (default {@link DEFAULT_IDLE_TIMEOUT_SECONDS}, so a client
 * that opens a connection and goes quiet is closed) and
 * `maxRequestBodySize` (default {@link DEFAULT_MAX_REQUEST_BODY_SIZE}),
 * keeping values the options already set once they pass the checks.
 * Throws bun-common's `ConfigError` for an `idleTimeout` of `0` (no
 * timeout) or outside Bun's 1–255 seconds, a body size that is not a
 * positive whole number, and `development` left on in production.
 *
 * @example
 * ```ts
 * Bun.serve(hardenServe({ port: 443, fetch: withSecurity(security, app) }));
 * ```
 */
export function hardenServe<T extends object>(
  options: T,
  settings: HardenServeOptions = {},
): T & { idleTimeout: number; maxRequestBodySize: number } {
  // `T` is the caller's own options type, so Bun.serve still infers from it;
  // these three fields are read through a view of it.
  const view: HardenableServeOptions = options;
  const idleTimeout = view.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  if (!Number.isInteger(idleTimeout) || idleTimeout < 1 || idleTimeout > 255) {
    throw new ConfigError(
      `hardenServe(): idleTimeout must be a whole number of seconds from 1 to 255 (0 turns the timeout off, which leaves a quiet connection open for good); got ${String(idleTimeout)}`,
      { idleTimeout },
    );
  }
  const maxRequestBodySize =
    view.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE;
  if (!Number.isSafeInteger(maxRequestBodySize) || maxRequestBodySize < 1) {
    throw new ConfigError(
      `hardenServe(): maxRequestBodySize must be a positive whole number of bytes; got ${String(maxRequestBodySize)}`,
      { maxRequestBodySize },
    );
  }
  const production =
    settings.production ?? process.env.NODE_ENV === "production";
  const development = view.development;
  if (production && development !== undefined && development !== false) {
    throw new ConfigError(
      "hardenServe(): development is on under NODE_ENV=production; it serves detailed error pages. Remove it or set it to false.",
    );
  }
  return { ...options, idleTimeout, maxRequestBodySize };
}
