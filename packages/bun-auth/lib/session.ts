/**
 * The session on the request (plan §5): looked up once per request with
 * better-auth's in-process `getSession`, set on `req.session` and
 * `req.user`, and kept by the native `Request`, so every later reader gets it
 * for free.
 */
import type {
  BunRequest,
  BunResponse,
  NextFunction,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-common/lib/errors";
import { assertAuthInstance } from "./options";
import type {
  AuthInstance,
  AuthRequest,
  AuthSession,
  RequireSessionOptions,
} from "./types";

/** Resolved sessions (`null`: none), by the native request. */
const SESSIONS = new WeakMap<Request, AuthSession | null>();

/** Lookups in flight, by the native request, so two readers share one. */
const PENDING = new WeakMap<Request, Promise<AuthSession | null>>();

/** Whether `value` is a `{ session, user }` pair. */
function isSession(value: unknown): value is AuthSession {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AuthSession).session === "object" &&
    (value as AuthSession).session !== null &&
    typeof (value as AuthSession).user === "object" &&
    (value as AuthSession).user !== null
  );
}

/**
 * The request's session, looked up at most once: set on `req.session` and
 * `req.user` (or `null`) and kept for {@link getAuthSession}.
 */
export async function resolveSession(
  auth: AuthInstance,
  req: BunRequest,
): Promise<AuthSession | null> {
  const request = req.request;
  if (SESSIONS.has(request)) {
    return SESSIONS.get(request) ?? null;
  }
  let pending = PENDING.get(request);
  if (pending === undefined) {
    pending = auth.api
      .getSession({ headers: request.headers })
      .then((found) => (isSession(found) ? found : null));
    PENDING.set(request, pending);
  }
  try {
    const session = await pending;
    SESSIONS.set(request, session);
    const target = req as AuthRequest;
    target.session = session?.session ?? null;
    target.user = session?.user ?? null;
    return session;
  } finally {
    PENDING.delete(request);
  }
}

/**
 * Middleware that looks up the request's session with better-auth
 * (`auth.api.getSession`, in process) and sets `req.session` and `req.user`,
 * each `null` without one. It never refuses a request: {@link requireSession}
 * does. The lookup happens once per request, however many of these and of
 * `requireSession` run; {@link getAuthSession} reads it again.
 *
 * ```ts
 * app.use(sessionMiddleware(auth));
 * app.get("/", (req: AuthRequest<typeof auth>, res) => res.json({ signedIn: req.user !== null }));
 * ```
 *
 * A failed lookup (the database is down) goes to the error handlers.
 */
export function sessionMiddleware(auth: AuthInstance): RouterHandler {
  assertAuthInstance(auth, "sessionMiddleware()");
  return async (req: BunRequest, _res: BunResponse, next: NextFunction) => {
    try {
      await resolveSession(auth, req);
    } catch (error) {
      next(error as Error);
      return;
    }
    next();
  };
}

/** Sends a problem+json refusal in bun-common's error style. */
function refuse(
  res: BunResponse,
  status: 401 | 403,
  code: string,
  title: string,
  detail: string,
): void {
  if (res.headersSent) return;
  res.status(status);
  res.setHeader("Content-Type", "application/problem+json");
  res.setHeader("Cache-Control", "no-store");
  res.send(
    JSON.stringify({
      type: `urn:bun-auth:error:${code}`,
      title,
      status,
      code,
      detail,
    }),
  );
}

/** The roles in better-auth admin's `user.role`: one, or several separated by commas. */
function rolesOf(user: object): string[] {
  const role = (user as { role?: unknown }).role;
  if (typeof role === "string") {
    return role
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  if (Array.isArray(role)) {
    return role.filter((part): part is string => typeof part === "string");
  }
  return [];
}

/** Checks {@link RequireSessionOptions}, throwing bun-common's `ConfigError`. */
function checkRequireOptions(options: RequireSessionOptions | undefined): void {
  if (options === undefined) return;
  const { roles, organization } = options;
  if (
    roles !== undefined &&
    (!Array.isArray(roles) ||
      roles.length === 0 ||
      roles.some((role) => typeof role !== "string" || role === ""))
  ) {
    throw new ConfigError(
      "requireSession(): roles must be a non-empty list of role names",
      { roles },
    );
  }
  if (
    organization !== undefined &&
    organization !== true &&
    (typeof organization !== "string" || organization === "")
  ) {
    throw new ConfigError(
      "requireSession(): organization must be an organization id or true",
      { organization },
    );
  }
}

/**
 * Middleware that lets a request through only with a session, looked up as
 * {@link sessionMiddleware} does (and set on `req.session` and `req.user`):
 *
 * - no session: `401`, `application/problem+json`
 *   (`urn:bun-auth:error:UNAUTHORIZED`);
 * - `roles` given and the user has none of them (`user.role`, the admin
 *   plugin's): `403` (`urn:bun-auth:error:FORBIDDEN`);
 * - `organization` given and the session does not have it active
 *   (`session.activeOrganizationId`, the organization plugin's): `403`.
 *
 * ```ts
 * app.get("/admin", requireSession(auth, { roles: ["admin"] }), (req: AuthRequest<typeof auth>, res) => {
 *   res.json({ id: req.user?.id });
 * });
 * ```
 *
 * @throws ConfigError (bun-common's) at creation, for an invalid option.
 */
export function requireSession(
  auth: AuthInstance,
  options?: RequireSessionOptions,
): RouterHandler {
  assertAuthInstance(auth, "requireSession()");
  checkRequireOptions(options);
  const roles = options?.roles;
  const organization = options?.organization;
  return async (req: BunRequest, res: BunResponse, next: NextFunction) => {
    let session: AuthSession | null;
    try {
      session = await resolveSession(auth, req);
    } catch (error) {
      next(error as Error);
      return;
    }
    if (session === null) {
      refuse(
        res,
        401,
        "UNAUTHORIZED",
        "Unauthorized",
        "A session is required.",
      );
      return;
    }
    if (roles !== undefined) {
      const held = rolesOf(session.user);
      if (!roles.some((role) => held.includes(role))) {
        refuse(
          res,
          403,
          "FORBIDDEN",
          "Forbidden",
          "The signed-in user does not have a role this route requires.",
        );
        return;
      }
    }
    if (organization !== undefined) {
      const active = (session.session as { activeOrganizationId?: unknown })
        .activeOrganizationId;
      const allowed =
        organization === true
          ? typeof active === "string" && active !== ""
          : active === organization;
      if (!allowed) {
        refuse(
          res,
          403,
          "FORBIDDEN",
          "Forbidden",
          "The session does not have the organization this route requires active.",
        );
        return;
      }
    }
    next();
  };
}

/**
 * The session {@link sessionMiddleware} or {@link requireSession} looked up
 * for this request, typed from the app's auth instance: `{ session, user }`,
 * or `null` when the request has none. Reads it again without a lookup.
 *
 * ```ts
 * const found = getAuthSession<typeof auth>(req);
 * ```
 *
 * @throws TypeError when neither ran on this request: a request with no
 * lookup is not the same as one without a session.
 */
export function getAuthSession<A extends AuthInstance = AuthInstance>(
  req: BunRequest | Request,
): AuthSession<A> | null {
  const request = req instanceof Request ? req : req.request;
  if (!SESSIONS.has(request)) {
    throw new TypeError(
      "getAuthSession(): no session was looked up for this request; " +
        "run sessionMiddleware(auth) or requireSession(auth) ahead of it",
    );
  }
  return SESSIONS.get(request) ?? null;
}
