/**
 * `@kingsleyweb/bun-auth/serve`: better-auth on a plain `Bun.serve`, without
 * bun-common's router (plan §4.4).
 */
import { normalizeIpAddress } from "@kingsleyweb/bun-common/lib/utils/native";
import { reportServerError, withClientAddress } from "../handover";
import { createLimiterCheck } from "../limiter";
import {
  assertAuthInstance,
  configurationWarnings,
  createWarner,
  rateLimitWarning,
  resolveOptions,
  throwsErrors,
} from "../options";
import type { AuthInstance, BunAuthOptions } from "../types";

/** What `withAuth` needs of the server `Bun.serve` passes its `fetch`. */
export interface ServeServer {
  /** The socket peer of `request` (`Bun.Server#requestIP`). */
  requestIP: (request: Request) => { address: string } | null;
}

/**
 * Wraps a `Bun.serve` `fetch` so that requests under better-auth's base path
 * are answered by better-auth's handler, and every other request goes to
 * `fetch`. The request is handed over unread, with the client's address (the
 * socket peer, `server.requestIP()`) in the `clientIpHeader` header in place
 * of any copy the client sent.
 *
 * ```ts
 * Bun.serve({
 *   port: 3000,
 *   fetch: withAuth(auth, (request) => new Response("app")),
 * });
 * ```
 *
 * The peer is the client only when nothing sits in front of the server: behind
 * a proxy, every client has the proxy's address, so better-auth's limiter
 * counts them as one. Mount on bun-common's adapter with `trustProxy` there
 * ({@link mountAuth} from `@kingsleyweb/bun-auth`). An error better-auth
 * throws (`onAPIError: { throw: true }`) rejects the returned promise, for
 * `Bun.serve`'s `error` handler; a `5xx` better-auth answers itself is logged.
 * The configuration warnings are logged once, when this is called.
 *
 * @throws ConfigError (bun-common's) for an invalid option or a value that is
 * not a better-auth instance.
 */
export function withAuth<S extends ServeServer>(
  auth: AuthInstance,
  fetch: (request: Request, server: S) => Response | Promise<Response>,
  options?: BunAuthOptions,
): (request: Request, server: S) => Promise<Response> {
  assertAuthInstance(auth, "withAuth()");
  if (typeof fetch !== "function") {
    throw new TypeError("withAuth(): fetch must be a function");
  }
  const resolved = resolveOptions(auth, options, "withAuth()");
  const warn = createWarner(resolved);
  for (const [kind, message, fields] of configurationWarnings(auth, resolved)) {
    warn(kind, message, fields);
  }
  const throws = throwsErrors(auth);
  const limiter = createLimiterCheck(auth);
  const base = resolved.basePath;
  const prefix = base === "/" ? "/" : `${base}/`;
  return async (request, server) => {
    const path = new URL(request.url).pathname;
    if (path !== base && !path.startsWith(prefix)) {
      return fetch(request, server);
    }
    const peer = server.requestIP(request)?.address;
    const handed = withClientAddress(
      request,
      resolved.clientIpHeader,
      normalizeIpAddress(peer) ?? "",
    );
    if (resolved.warn) {
      const other = await limiter.check(request);
      if (other !== undefined) {
        warn("rate-limit", rateLimitWarning(other), { other });
        limiter.done();
      }
    }
    const response = await auth.handler(handed);
    reportServerError(resolved.logger, handed, response, throws);
    return response;
  };
}

export type { AuthInstance, BunAuthOptions } from "../types";
