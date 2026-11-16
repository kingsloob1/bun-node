/**
 * Layer L13.2, CSRF, in two parts (layers.md L13.2):
 *
 * 1. **Fetch Metadata resource isolation**: a state-changing request
 *    (`POST`, `PUT`, `PATCH`, `DELETE`) that carries cookies and that the
 *    browser marks `Sec-Fetch-Site: cross-site` is refused, unless its
 *    `Origin` is one the service trusts or its route takes cross-site
 *    requests on purpose (`securityProfile(name, { crossSite: true })`).
 *    Without the header (an older browser), the `Origin` is checked against
 *    the request's own origin and the trusted ones; a request with neither
 *    header is not a browser's, and passes.
 * 2. **A signed double-submit token**, for apps that want one: an HMAC over
 *    the session id and a random nonce, in a cookie and echoed in a header
 *    or form field, compared in constant time.
 */
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  BunRequest,
  BunResponse,
  RouterMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-common";
import type { Decision } from "../engine/decision";
import { refusalResponse } from "../serve/respond";
import { stateOf } from "./state";

/** The signed double-submit token's options. */
export interface CsrfTokenOptions {
  /** The HMAC key: at least 32 bytes. Keep it secret and the same across instances. */
  readonly secret: string | Uint8Array;
  /**
   * The session the token is bound to, from the request (a session id, never
   * a password). Default: none, so a token is bound to the secret alone.
   */
  readonly session?: (req: BunRequest) => string | undefined;
  /** The cookie holding the token. Default `__Host-csrf` over HTTPS, `csrf` otherwise. */
  readonly cookie?: string;
  /** The header a client echoes it in. Default `x-csrf-token`. */
  readonly header?: string;
  /** The form field a client may echo it in instead, read from a parsed body. Default `_csrf`. */
  readonly field?: string;
}

/** Options for {@link csrf}. */
export interface CsrfOptions {
  /**
   * Origins trusted to send cross-site state-changing requests
   * (`"https://app.example"`): scheme, host and port, as browsers send
   * `Origin`. The request's own origin is always trusted. Default none.
   */
  readonly origins?: readonly string[];
  /**
   * Whether a `Sec-Fetch-Site: same-site` request (a sibling subdomain)
   * passes. Default `true`; `false` lets only same-origin requests and the
   * trusted origins through.
   */
  readonly allowSameSite?: boolean;
  /**
   * Check only requests that carry cookies, the credentials a forged
   * request rides on. Default `true`; `false` checks every state-changing
   * request.
   */
  readonly onlyWithCookies?: boolean;
  /** The signed double-submit token; none by default. */
  readonly token?: CsrfTokenOptions;
}

/** What a CSRF check found wrong; `undefined` when it passes. */
export type CsrfRefusal =
  | "cross-site"
  | "untrusted-origin"
  | "opaque-origin"
  | "missing-token"
  | "invalid-token";

/** The methods a CSRF check covers. */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The shortest HMAC key accepted, in bytes. */
const MIN_SECRET_BYTES = 32;

/** The token's nonce, in bytes. */
const NONCE_BYTES = 16;

/** The CSRF guard {@link csrf} returns: a middleware with the token's issuer. */
export interface CsrfGuard extends RouterMiddlewareHandler {
  /**
   * The request's token, for a form or a page to echo: the one its cookie
   * holds when it is valid for the session, else a new one, set in the
   * cookie on `res`. Throws a `ConfigError` without `token` options.
   */
  readonly token: (req: BunRequest, res: BunResponse) => string;
  /** The check alone: the refusal for `req`, `undefined` when it passes. */
  readonly check: (
    req: BunRequest,
    crossSite?: boolean,
  ) => CsrfRefusal | undefined;
}

/** A base64url string of `bytes`. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Whether `a` and `b` are the same string, in time independent of where they differ. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The origin a request arrived at: scheme, host and port. */
function ownOrigin(req: BunRequest): string {
  return `${req.protocol}://${req.host}`.toLowerCase();
}

/** The refusal's decision, as the engine would answer it. */
export function csrfDecision(refusal: CsrfRefusal): Decision {
  return {
    action: "block",
    status: 403,
    code: "csrf",
    hits: [
      {
        layer: "L13",
        rule: "csrf",
        action: "block",
        reason: `csrf: ${refusal}`,
      },
    ],
    tags: [],
    risk: 1,
    subject: {},
  };
}

/**
 * The CSRF guard (layers.md L13.2): a middleware that refuses a forged
 * state-changing request with `403` problem+json (code `csrf`), and, with
 * `token`, issues and checks a signed double-submit token. `installSecurity`
 * runs it in the route stage; on its own it goes ahead of the routes it
 * guards. A route marked `securityProfile(name, { crossSite: true })` is
 * not refused for coming from another site.
 *
 * @example
 * ```ts
 * const guard = csrf({ origins: ["https://app.example"] });
 * app.use(guard);
 * ```
 */
export function csrf(options: CsrfOptions = {}): CsrfGuard {
  const trusted = new Set(
    (options.origins ?? []).map((origin) => origin.toLowerCase()),
  );
  const allowSameSite = options.allowSameSite ?? true;
  const onlyWithCookies = options.onlyWithCookies ?? true;
  const token = options.token;
  let key: Uint8Array | undefined;
  if (token !== undefined) {
    key =
      typeof token.secret === "string"
        ? new TextEncoder().encode(token.secret)
        : token.secret;
    if (key.byteLength < MIN_SECRET_BYTES) {
      throw new ConfigError(
        `csrf(): token.secret must be at least ${MIN_SECRET_BYTES} bytes; got ${key.byteLength}`,
      );
    }
  }
  const header = (token?.header ?? "x-csrf-token").toLowerCase();
  const field = token?.field ?? "_csrf";

  /** The cookie name for `req`. */
  const cookieName = (req: BunRequest): string =>
    token?.cookie ?? (req.protocol === "https" ? "__Host-csrf" : "csrf");

  /** The signature of `nonce` for `req`'s session. */
  const sign = (req: BunRequest, nonce: string): string =>
    createHmac("sha256", key!)
      .update(`${token?.session?.(req) ?? ""}!${nonce}`)
      .digest("base64url");

  /** Whether `value` is a token signed for `req`'s session. */
  const valid = (req: BunRequest, value: string): boolean => {
    const dot = value.indexOf(".");
    if (dot <= 0) return false;
    return sameString(value.slice(dot + 1), sign(req, value.slice(0, dot)));
  };

  /** The token `req`'s cookie holds. */
  const cookieToken = (req: BunRequest): string | undefined => {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[cookieName(req)];
    return typeof value === "string" ? value : undefined;
  };

  /** The token `req` echoes, from the header or a parsed body's field. */
  const echoedToken = (req: BunRequest): string | undefined => {
    const fromHeader = req.request.headers.get(header);
    if (fromHeader) return fromHeader;
    const body: unknown = req.body;
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const value = (body as Record<string, unknown>)[field];
      if (typeof value === "string") return value;
    }
    return undefined;
  };

  const check = (
    req: BunRequest,
    crossSite = false,
  ): CsrfRefusal | undefined => {
    if (!STATE_CHANGING.has(req.method)) return undefined;
    const headers = req.request.headers;
    const hasCookies = headers.has("cookie");
    if (!crossSite && (hasCookies || !onlyWithCookies)) {
      const origin = headers.get("origin")?.toLowerCase();
      const site = headers.get("sec-fetch-site")?.toLowerCase();
      const trustedOrigin = origin !== undefined && trusted.has(origin);
      if (site !== undefined) {
        if (site === "cross-site" && !trustedOrigin) return "cross-site";
        if (site === "same-site" && !allowSameSite && !trustedOrigin) {
          return "cross-site";
        }
      } else if (origin !== undefined) {
        if (origin === "null") return "opaque-origin";
        if (origin !== ownOrigin(req) && !trustedOrigin) {
          return "untrusted-origin";
        }
      }
    }
    if (token !== undefined && !crossSite && (hasCookies || !onlyWithCookies)) {
      const held = cookieToken(req);
      const echoed = echoedToken(req);
      if (held === undefined || echoed === undefined) return "missing-token";
      if (!sameString(held, echoed) || !valid(req, held)) {
        return "invalid-token";
      }
    }
    return undefined;
  };

  const middleware: RouterMiddlewareHandler = (req, res, next) => {
    const refusal = check(req, stateOf(req.request)?.profile?.crossSite);
    if (refusal === undefined) return next();
    return res.send(refusalResponse(csrfDecision(refusal), req.request));
  };

  const issue = (req: BunRequest, res: BunResponse): string => {
    if (token === undefined) {
      throw new ConfigError(
        "csrf(): token() needs the token option ({ token: { secret } })",
      );
    }
    const held = cookieToken(req);
    if (held !== undefined && valid(req, held)) return held;
    const nonce = base64url(randomBytes(NONCE_BYTES));
    const value = `${nonce}.${sign(req, nonce)}`;
    res.cookie(cookieName(req), value, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: req.protocol === "https",
    });
    return value;
  };

  const guard: CsrfGuard = Object.assign(middleware, { token: issue, check });
  return guard;
}
