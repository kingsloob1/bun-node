/**
 * The types bun-auth is written in: the shape of an app's `betterAuth()`
 * instance it reads, the session typed from that instance, and the options.
 */
import type { BunRequest, LoggerLike } from "@kingsleyweb/bun-common";
import type { BetterAuthOptions } from "better-auth";

/**
 * What bun-auth reads of a `betterAuth({...})` instance: the value
 * `betterAuth()` returns satisfies it, with or without plugins. bun-auth calls
 * `handler` and `api.getSession`, reads `options` and `$context`, and never
 * writes to any of them.
 */
export interface AuthInstance {
  /** better-auth's Fetch API handler: every route under its base path. */
  handler: (request: Request) => Promise<Response>;
  /** better-auth's in-process API; bun-auth calls only `getSession`. */
  api: {
    /** The session the request's cookies (or bearer token) carry, or `null`. */
    getSession: (context: { headers: Headers }) => Promise<unknown>;
  };
  /** The options the instance was made with, read and never changed. */
  options: BetterAuthOptions;
  /** The resolved context; bun-auth reads whether the rate limiter is on. */
  $context: Promise<{
    /** The resolved rate-limit settings. */
    rateLimit: {
      /** Whether better-auth's own limiter counts requests. */
      enabled: boolean;
    };
  }>;
  /** better-auth's inferred types; `Session` is the app's session shape. */
  $Infer: {
    /** `{ session, user }`, typed from the instance's options and plugins. */
    Session: { session: object; user: object };
  };
}

/**
 * The session of an app's auth instance, `{ session, user }`, as better-auth
 * infers it from the instance's options and plugins (`typeof
 * auth.$Infer.Session`): with the admin plugin, `user.role` is typed, and so
 * on.
 *
 * ```ts
 * type Session = AuthSession<typeof auth>;
 * ```
 */
export type AuthSession<A extends AuthInstance = AuthInstance> =
  A["$Infer"]["Session"];

/**
 * A bun-common request carrying the session of an app's auth instance, as
 * {@link sessionMiddleware} and {@link requireSession} set it: `session` and
 * `user` typed from `A`, `null` when the request has none. After
 * `requireSession` neither is `null`. Both are optional, so a route handler
 * can declare its request as this type.
 *
 * ```ts
 * app.get("/me", requireSession(auth), (req: AuthRequest<typeof auth>, res) => {
 *   res.json({ email: req.user?.email });
 * });
 * ```
 */
export type AuthRequest<A extends AuthInstance = AuthInstance> = BunRequest & {
  /**
   * The session record (its id, expiry, address, …), or `null`; `undefined`
   * until `sessionMiddleware` or `requireSession` has run on the request.
   */
  session?: AuthSession<A>["session"] | null;
  /**
   * The signed-in user, or `null`; `undefined` until `sessionMiddleware` or
   * `requireSession` has run on the request.
   */
  user?: AuthSession<A>["user"] | null;
};

/** Options for {@link mountAuth}, {@link authHandler} and `withAuth`. */
export interface BunAuthOptions {
  /**
   * The path the handler answers under, on the router it is mounted on.
   * Defaults to the instance's own: the path of its `baseURL` when that has
   * one, else its `basePath`, else better-auth's `/api/auth`. Set it when the
   * router is itself mounted under a prefix (`/v1` + `/api/auth`), or when
   * the instance takes its base URL from the environment
   * (`BETTER_AUTH_URL`), which bun-auth does not read.
   */
  basePath?: string;
  /**
   * The header bun-auth sets to the client's address on the request it hands
   * to better-auth, after removing any copy a client sent. Name it in
   * better-auth's `advanced.ipAddress.ipAddressHeaders` so its rate limiter
   * and the session's `ipAddress` use it. Default `x-bun-auth-client-ip`.
   */
  clientIpHeader?: string;
  /**
   * Log a warning (once each) for a setting that hides errors, trusts a
   * forgeable address, loses the body's bytes or counts a sign-in twice.
   * Default `true`. Errors are logged either way.
   */
  warn?: boolean;
  /**
   * Where warnings and errors go: any logger bun-common accepts (pino,
   * winston, a `LogSink`, …). Defaults to the router's logger for
   * {@link mountAuth}, and to bun-common's console logger otherwise.
   */
  logger?: LoggerLike;
}

/** Options for {@link requireSession}. */
export interface RequireSessionOptions {
  /**
   * Roles of which the user must have one (better-auth's admin plugin,
   * `user.role`, which may list several separated by commas); `403`
   * otherwise. Unset: any signed-in user.
   */
  roles?: readonly string[];
  /**
   * The organization the session must have active (better-auth's
   * organization plugin, `session.activeOrganizationId`): its id, or `true`
   * for any; `403` otherwise. Unset: no requirement.
   */
  organization?: string | true;
}
