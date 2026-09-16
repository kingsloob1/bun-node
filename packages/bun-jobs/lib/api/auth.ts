import type { BunRequest, RouterHandler } from "@kingsleyweb/bun-common";
import type {
  JobsApiAction,
  JobsApiAuthorizeContext,
  ResolvedJobsApiConfig,
  ResolvedJobsApiCsrfOptions,
} from "./config";
import { isMutation } from "./config";
import { ApiError, tagRequestAction } from "./errors";

/**
 * Who may do what, and from where.
 *
 * Three independent defences, each usable on its own so the WebSocket unit
 * reuses them on upgrades:
 *
 * 1. **Static limits** — `actions` and `readOnly` — decided before `authorize`
 *    is asked, so no `authorize` can re-enable what configuration removed.
 * 2. **`authorize`** — the host's own decision, normalised to allow or deny.
 * 3. **Origin and CSRF checks** — because an admin session is usually a cookie,
 *    and a browser sends cookies on cross-site requests it was tricked into.
 *
 * Every check is a pure function first and a router handler second.
 */

/** A normalised `authorize` answer. */
export type AuthDecision =
  | {
      /** Allowed. */
      allow: true;
    }
  | {
      /** Denied. */
      allow: false;
      /** `401` for an unauthenticated caller, `403` for one lacking permission. */
      status: 401 | 403;
      /** Client-visible reason, when `authorize` gave one. */
      reason?: string;
      /** Whether the static limits (`actions`, `readOnly`) denied it, not `authorize`. */
      static?: true;
    };

/** The allow decision, shared. */
const ALLOW: AuthDecision = Object.freeze({ allow: true });

/**
 * Normalises what `authorize` returned. Anything that is not a recognised
 * shape — `undefined` from a forgotten `return`, a string — is a denial:
 * failing open on a malformed answer is how an admin API ends up public.
 */
export function normalizeAuthorizeResult(result: unknown): AuthDecision {
  if (result === true) {
    return ALLOW;
  }
  if (typeof result === "object" && result !== null && "allow" in result) {
    const answer = result as {
      allow: unknown;
      status?: unknown;
      reason?: unknown;
    };
    if (answer.allow === true) {
      return ALLOW;
    }
    if (answer.allow === false) {
      const decision: AuthDecision = {
        allow: false,
        status: answer.status === 401 ? 401 : 403,
      };
      if (typeof answer.reason === "string" && answer.reason !== "") {
        decision.reason = answer.reason;
      }
      return decision;
    }
  }
  return { allow: false, status: 403 };
}

/** The target fields of an authorize context. */
export type AuthorizeTarget = Pick<
  JobsApiAuthorizeContext,
  "queue" | "jobId" | "jobIds" | "runner" | "channel"
>;

/** What {@link decide} is asked, minus what it derives itself (`mutation`). */
export type AuthorizeRequest = Omit<JobsApiAuthorizeContext, "mutation">;

/**
 * The target fields of anything, and only those: `queue`, `jobId`, `runner`
 * and `channel` when they are strings, `jobIds` when it is an array of
 * strings (copied and frozen). Everything else — an `action`, a `transport`,
 * a `mutation` a route's `target` happened to return — is dropped, so a target
 * can never change what is being authorized.
 */
export function pickTarget(value: unknown): AuthorizeTarget {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const target: AuthorizeTarget = {};
  for (const key of ["queue", "jobId", "runner", "channel"] as const) {
    if (typeof source[key] === "string") {
      target[key] = source[key];
    }
  }
  if (
    Array.isArray(source.jobIds) &&
    source.jobIds.every((id) => typeof id === "string")
  ) {
    // A copy `authorize` cannot change under the handler that runs next.
    target.jobIds = Object.freeze([...(source.jobIds as string[])]);
  }
  return target;
}

/** The static-limit decision for an action: a denial when it is disabled, else `undefined`. */
export function staticDecision(
  config: Pick<ResolvedJobsApiConfig, "enabledActions">,
  action: JobsApiAction,
): AuthDecision | undefined {
  return config.enabledActions.has(action)
    ? undefined
    : {
        allow: false,
        status: 403,
        reason: "This action is not enabled",
        static: true,
      };
}

/**
 * Decides one request: the static limits first, then `authorize` (or the
 * explicit `allowUnauthenticated`). The context is built field by field:
 * the target fields are picked ({@link pickTarget}), then `action`,
 * `transport` and `route` are set, and `mutation` is derived from the action —
 * nothing in a target can override them. A throwing `authorize` propagates.
 */
export async function decide(
  config: Pick<
    ResolvedJobsApiConfig,
    "enabledActions" | "authorize" | "allowUnauthenticated"
  >,
  req: BunRequest,
  request: AuthorizeRequest,
): Promise<AuthDecision> {
  const denied = staticDecision(config, request.action);
  if (denied) {
    return denied;
  }
  if (!config.authorize) {
    return config.allowUnauthenticated ? ALLOW : { allow: false, status: 403 };
  }
  const context: JobsApiAuthorizeContext = {
    ...pickTarget(request),
    action: request.action,
    transport: request.transport === "ws" ? "ws" : "http",
    ...(request.route
      ? {
          route: {
            method: String(request.route.method),
            path: String(request.route.path),
          },
        }
      : {}),
    mutation: isMutation(request.action),
  };
  return normalizeAuthorizeResult(await config.authorize(req, context));
}

/** The error a denial is answered with. */
export function denialError(
  decision: Extract<AuthDecision, { allow: false }>,
): ApiError {
  return decision.status === 401
    ? new ApiError(
        "UNAUTHORIZED",
        401,
        decision.reason ?? "Authentication required",
      )
    : new ApiError(
        "FORBIDDEN",
        403,
        decision.reason ?? "Not allowed to perform this action",
      );
}

/**
 * Wraps a request check (CSRF, JSON parsing, validation) so its failure is
 * recorded in `failures` instead of answered. The request carries on, and the
 * authorize step decides what the client is told — so nothing about a
 * route's schema or rules reaches a caller `authorize` would have refused.
 *
 * Once one check has failed, the later ones are skipped: the first failure is
 * the one reported.
 */
export function deferFailure(
  handler: RouterHandler,
  failures: WeakMap<BunRequest, unknown>,
): RouterHandler {
  return async (req, res, next) => {
    if (failures.has(req)) {
      return next();
    }
    let outcome: { error?: unknown } | undefined;
    try {
      await handler(req, res, (value?: string | Error) => {
        outcome = value === undefined ? {} : { error: value };
        return undefined;
      });
    } catch (error) {
      outcome = { error };
    }
    if (outcome === undefined) {
      // The check answered the request itself; nothing to continue.
      return undefined;
    }
    if (outcome.error !== undefined) {
      failures.set(req, outcome.error);
    }
    return next();
  };
}

/** Options for {@link authorizeHandler}. */
export interface AuthorizeHandlerOptions {
  /** The route being authorized, reported to `authorize` as `context.route`. */
  route?: JobsApiAuthorizeContext["route"];
  /**
   * Reads the target out of the request — from the **validated** params and
   * body, so register this after the validator. Only the target fields of what
   * it returns are used; a throw is treated like a failed check.
   */
  target?: (req: BunRequest) => AuthorizeTarget;
  /**
   * The failure a deferred check recorded for this request, if any (see
   * {@link deferFailure}).
   */
  pending?: (req: BunRequest) => unknown;
}

/**
 * A router handler that authorizes one action over HTTP. `authorize` is asked
 * exactly once per request:
 *
 * - every check passed and the target was read: it is asked with the target,
 *   and the request continues or is answered 401/403;
 * - a check failed, or reading the target threw: it is asked **without** a
 *   target. A denial is answered 401/403; only a caller it allows is told what
 *   was wrong with the request (400, 415, …).
 */
export function authorizeHandler(
  config: Pick<
    ResolvedJobsApiConfig,
    "enabledActions" | "authorize" | "allowUnauthenticated"
  >,
  action: JobsApiAction,
  options?: AuthorizeHandlerOptions,
): RouterHandler {
  return async (req, _res, next) => {
    tagRequestAction(req, action);
    let failure = options?.pending?.(req);
    let target: AuthorizeTarget = {};
    if (failure === undefined && options?.target) {
      try {
        target = pickTarget(options.target(req));
      } catch (error) {
        failure = error;
      }
    }
    const decision = await decide(config, req, {
      ...(failure === undefined ? target : {}),
      action,
      transport: "http",
      ...(options?.route ? { route: options.route } : {}),
    });
    if (!decision.allow) {
      return next(denialError(decision));
    }
    return failure === undefined ? next() : next(failure as Error);
  };
}

/** Origins accepted besides the same origin, or every origin. */
export type OriginAllowList = readonly (string | RegExp)[] | "*";

/** How a request's own origin is worked out. */
export interface RequestOriginOptions {
  /**
   * Trust `X-Forwarded-Proto` and `X-Forwarded-Host` for the request's scheme
   * and host. Only behind a proxy that sets them and strips any a client sent.
   * Defaults to `false`: the request URL's scheme and the `Host` header.
   */
  trustProxy?: boolean;
}

/** An origin in canonical form (`scheme://host[:port]`, default port dropped), or `undefined` when it is not one. */
export function canonicalOrigin(origin: string): string | undefined {
  if (origin === "null") {
    return "null";
  }
  try {
    const url = new URL(origin);
    return url.origin === "null" ? undefined : url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The first value of a comma-separated forwarded header. */
function firstForwarded(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim();
  return first || null;
}

/**
 * Whether `origin` is the same origin as a request to `host`. The default port
 * of the origin's scheme is accounted for, so `https://a.example` matches a
 * `Host` of `a.example` and `a.example:443` alike.
 *
 * When `protocol` (the request's own scheme, `"https"` or `"https:"`) is given
 * the schemes must match too: `http://a.example` is not the same origin as a
 * request that arrived over `https`. Without it only hosts are compared, which
 * is how this behaved before the scheme was known.
 */
export function isSameOrigin(
  origin: string,
  host: string | null | undefined,
  protocol?: string | null,
): boolean {
  if (!host) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.origin === "null") {
      return false;
    }
    if (protocol) {
      const expected = protocol.endsWith(":") ? protocol : `${protocol}:`;
      if (parsed.protocol.toLowerCase() !== expected.toLowerCase()) {
        return false;
      }
    }
    return (
      new URL(`${parsed.protocol}//${host}`).host.toLowerCase() ===
      parsed.host.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Whether an origin is on a list.
 *
 * - A string entry matches when both are the same canonical origin.
 * - A `RegExp` entry must match the **whole** canonical origin
 *   (`scheme://host[:port]`, lower case): `/https:\/\/good\.example/` matches
 *   `https://good.example` but not `https://good.example.evil.net`. A partial
 *   match never counts, whether or not the pattern is anchored.
 */
export function originListed(
  origin: string,
  list: readonly (string | RegExp)[],
): boolean {
  const canonical = canonicalOrigin(origin);
  if (canonical === undefined) {
    return false;
  }
  for (const entry of list) {
    if (entry instanceof RegExp) {
      entry.lastIndex = 0;
      const match = entry.exec(canonical);
      entry.lastIndex = 0;
      if (match && match.index === 0 && match[0] === canonical) {
        return true;
      }
    } else if (canonicalOrigin(entry) === canonical) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a request's `Origin` may proceed: absent (a non-browser client), the
 * same origin, listed, or anything under `"*"`. `Origin: null` (a sandboxed
 * frame, a `file:` page) passes only when `"null"` is listed. `protocol`, when
 * given, is the request's own scheme; see {@link isSameOrigin}.
 */
export function originAllowed(
  origin: string | null | undefined,
  host: string | null | undefined,
  allowed: OriginAllowList | undefined,
  protocol?: string | null,
): boolean {
  if (origin === null || origin === undefined || origin === "") {
    return true;
  }
  if (allowed === "*") {
    return true;
  }
  return (
    isSameOrigin(origin, host, protocol) || originListed(origin, allowed ?? [])
  );
}

/** Reads a header from either request kind. */
function headerOf(req: BunRequest | Request, name: string): string | null {
  return req instanceof Request ? req.headers.get(name) : req.getHeader(name);
}

/**
 * The `Host` a request was sent to: `X-Forwarded-Host` when `trustProxy` is on
 * and it is present, else the header, else the URL's host.
 *
 * A `BunRequest` may carry a path-only `url` and no `Host` header (one built by
 * `router.fetch()` has both), so its own `host` getter — which already falls
 * back from the URL to the header — is the authority there.
 */
export function requestHost(
  req: BunRequest | Request,
  options?: RequestOriginOptions,
): string | null {
  if (options?.trustProxy) {
    const forwarded = firstForwarded(headerOf(req, "x-forwarded-host"));
    if (forwarded) {
      return forwarded;
    }
  }
  if (!(req instanceof Request)) {
    return req.getHeader("host") || req.host || null;
  }
  const header = req.headers.get("host");
  if (header) {
    return header;
  }
  try {
    return new URL(req.url).host || null;
  } catch {
    return null;
  }
}

/**
 * The scheme a request arrived over, without the colon: `X-Forwarded-Proto`
 * when `trustProxy` is on and it is present, else the request URL's. `null`
 * when neither says.
 */
export function requestProtocol(
  req: BunRequest | Request,
  options?: RequestOriginOptions,
): string | null {
  if (options?.trustProxy) {
    const forwarded = firstForwarded(headerOf(req, "x-forwarded-proto"));
    if (forwarded) {
      return forwarded.toLowerCase();
    }
  }
  try {
    const url =
      req instanceof Request ? new URL(req.url) : new URL(req.request.url);
    return url.protocol.replace(/:$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * A router handler refusing a request whose `Origin` is not allowed with 403
 * `ORIGIN_REJECTED`. Meant for WebSocket upgrades, where the browser sends
 * cookies cross-site and CORS does not apply. The same-origin test compares
 * the request's scheme as well as its host.
 */
export function originGuard(
  allowed: OriginAllowList | undefined,
  options?: RequestOriginOptions,
): RouterHandler {
  return (req, _res, next) =>
    originAllowed(
      headerOf(req, "origin"),
      requestHost(req, options),
      allowed,
      requestProtocol(req, options),
    )
      ? next()
      : next(
          new ApiError("ORIGIN_REJECTED", 403, "This origin may not connect"),
        );
}

/** What the CSRF check reads from a request. */
export interface CsrfRequestInfo {
  /** The method, upper case. */
  method: string;
  /** The `Content-Type` header. */
  contentType: string | null;
  /** Whether the request carries a body (`Content-Length` above 0, or chunked). */
  hasBody: boolean;
  /** The `Origin` header. */
  origin: string | null;
  /** The `Host` the request was sent to. */
  host: string | null;
  /**
   * The scheme the request arrived over, without the colon. When present, a
   * same-origin `Origin` must have this scheme too.
   */
  protocol?: string | null;
  /** The `Sec-Fetch-Site` header. */
  secFetchSite: string | null;
  /** Reads any header. */
  header: (name: string) => string | null;
}

/** Collects what the CSRF check needs from a request. */
export function csrfInfo(
  req: BunRequest | Request,
  options?: RequestOriginOptions,
): CsrfRequestInfo {
  const declared = headerOf(req, "content-length");
  // Without a `Content-Length` (a chunked upload, or a request constructed in
  // process rather than read off a socket), the native body says whether there
  // is one. A declared `0` is trusted as no body.
  const native = req instanceof Request ? req : req.request;
  const hasBody =
    declared !== null
      ? Number(declared) > 0
      : headerOf(req, "transfer-encoding") !== null || native.body !== null;
  return {
    method: req.method.toUpperCase(),
    contentType: headerOf(req, "content-type"),
    hasBody,
    origin: headerOf(req, "origin"),
    host: requestHost(req, options),
    protocol: requestProtocol(req, options),
    secFetchSite: headerOf(req, "sec-fetch-site"),
    header: (name) => headerOf(req, name),
  };
}

/** The media type of a `Content-Type` value, lower case, without parameters. */
export function mediaTypeOf(contentType: string | null): string | undefined {
  if (!contentType) {
    return undefined;
  }
  return contentType.split(";", 1)[0]!.trim().toLowerCase() || undefined;
}

/**
 * Checks a **mutation** against the CSRF rules, returning the error to answer
 * with, or `undefined` to proceed:
 *
 * 1. `Sec-Fetch-Site: cross-site`, unless the `Origin` is listed → 403 `CSRF_REJECTED`;
 * 2. an `Origin` neither same-origin (scheme and host) nor listed → 403 `CSRF_REJECTED`;
 * 3. the configured header missing → 403 `CSRF_REJECTED`;
 * 4. with `requireJson`, a `POST` — or any request with a body — that is not
 *    `application/json` → 415 `UNSUPPORTED_MEDIA_TYPE`.
 *
 * "Listed" uses {@link originListed}: a `RegExp` must match the whole
 * canonical origin. Rule 4 covers every `POST` even without a body because
 * `POST` is the one mutating method a cross-site form or `navigator.sendBeacon`
 * can send without a preflight, and a beacon can send it with no
 * `Content-Type` at all. `PUT`, `PATCH` and `DELETE` always preflight, so a
 * bodiless `DELETE` passes.
 */
export function checkCsrf(
  info: CsrfRequestInfo,
  csrf: ResolvedJobsApiCsrfOptions,
): ApiError | undefined {
  if (csrf === false) {
    return undefined;
  }
  const listed =
    info.origin !== null &&
    info.origin !== "" &&
    originListed(info.origin, csrf.allowedOrigins);

  if (info.secFetchSite?.toLowerCase() === "cross-site" && !listed) {
    return new ApiError(
      "CSRF_REJECTED",
      403,
      "Cross-site requests may not change state",
    );
  }
  if (
    info.origin !== null &&
    info.origin !== "" &&
    !listed &&
    !isSameOrigin(info.origin, info.host, info.protocol)
  ) {
    return new ApiError(
      "CSRF_REJECTED",
      403,
      "This origin may not change state",
    );
  }
  if (csrf.header !== false && !info.header(csrf.header)) {
    return new ApiError(
      "CSRF_REJECTED",
      403,
      `The ${csrf.header} header is required`,
      { context: { header: csrf.header } },
    );
  }
  if (
    csrf.requireJson &&
    (info.method === "POST" || info.hasBody) &&
    mediaTypeOf(info.contentType) !== "application/json"
  ) {
    return new ApiError(
      "UNSUPPORTED_MEDIA_TYPE",
      415,
      "Requests that change state must be application/json",
    );
  }
  return undefined;
}

/** A router handler applying {@link checkCsrf}. Register it on mutating routes only. */
export function csrfGuard(
  csrf: ResolvedJobsApiCsrfOptions,
  options?: RequestOriginOptions,
): RouterHandler {
  return (req, _res, next) => {
    const error = checkCsrf(csrfInfo(req, options), csrf);
    return error ? next(error) : next();
  };
}
