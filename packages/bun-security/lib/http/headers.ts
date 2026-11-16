/**
 * Layer L13.1, security headers (layers.md L13.1): a native helmet
 * equivalent, as a bun-common before-write hook, so it reaches every answer
 * the adapter writes: a route's, a not-found page, an error, a refusal.
 */
import type { BeforeWriteHook } from "@kingsleyweb/bun-common";

/** `Strict-Transport-Security`'s settings. */
export interface HstsOptions {
  /** Seconds browsers remember to use HTTPS. Default `31536000` (a year). */
  readonly maxAge?: number;
  /** Covers subdomains too. Default `true`. */
  readonly includeSubDomains?: boolean;
  /** Asks to be preloaded into browsers' lists: hard to undo. Default `false`. */
  readonly preload?: boolean;
}

/**
 * Options for {@link securityHeaders}. Each header takes its value, or
 * `false` to leave it out. A header the response already has is kept (the
 * app's own wins) unless {@link override} is set.
 */
export interface SecurityHeadersOptions {
  /** `Strict-Transport-Security`, sent only over HTTPS. Default a year with subdomains. */
  readonly hsts?: HstsOptions | false;
  /**
   * `Content-Security-Policy`. Default `frame-ancestors 'none'`, only when
   * the app sets none: an app's CSP is the app's to write.
   */
  readonly contentSecurityPolicy?: string | false;
  /** `X-Content-Type-Options`. Default `nosniff`. */
  readonly contentTypeOptions?: string | false;
  /** `Referrer-Policy`. Default `strict-origin-when-cross-origin`. */
  readonly referrerPolicy?: string | false;
  /** `Cross-Origin-Opener-Policy`. Default `same-origin`. */
  readonly crossOriginOpenerPolicy?: string | false;
  /**
   * `Cross-Origin-Resource-Policy`. Default `same-origin`; assets other
   * sites embed (a CDN's) need `cross-origin`.
   */
  readonly crossOriginResourcePolicy?: string | false;
  /** `Permissions-Policy`. Default camera, microphone, geolocation and payment off. */
  readonly permissionsPolicy?: string | false;
  /** `X-Frame-Options`, for old browsers (CSP `frame-ancestors` is the real control). Default `DENY`. */
  readonly frameOptions?: string | false;
  /** Headers removed from every answer. Default `x-powered-by` and `server`. */
  readonly remove?: readonly string[];
  /**
   * Adds `Cache-Control: no-store` to an answer that sets a cookie and says
   * nothing about caching, so a shared cache cannot hand one user's cookie
   * to another (layers.md L13.3). Default `true`.
   */
  readonly noStoreWithCookies?: boolean;
  /** Replace a header the response already has. Default `false`: the app's own value wins. */
  readonly override?: boolean;
}

/** The headers set on every answer, as `[name, value]`. */
type HeaderList = readonly (readonly [string, string])[];

/** `Strict-Transport-Security`'s value. */
function hstsValue(options: HstsOptions): string {
  const maxAge = options.maxAge ?? 31_536_000;
  if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new RangeError(
      `securityHeaders(): hsts.maxAge must be a whole number of seconds; got ${String(maxAge)}`,
    );
  }
  let value = `max-age=${maxAge}`;
  if (options.includeSubDomains ?? true) value += "; includeSubDomains";
  if (options.preload === true) value += "; preload";
  return value;
}

/** The headers `options` set on every answer (HSTS aside). */
function headerList(options: SecurityHeadersOptions): HeaderList {
  const list: [string, string][] = [];
  const add = (
    name: string,
    value: string | false | undefined,
    fallback: string,
  ) => {
    if (value !== false) list.push([name, value ?? fallback]);
  };
  add(
    "content-security-policy",
    options.contentSecurityPolicy,
    "frame-ancestors 'none'",
  );
  add("x-content-type-options", options.contentTypeOptions, "nosniff");
  add(
    "referrer-policy",
    options.referrerPolicy,
    "strict-origin-when-cross-origin",
  );
  add(
    "cross-origin-opener-policy",
    options.crossOriginOpenerPolicy,
    "same-origin",
  );
  add(
    "cross-origin-resource-policy",
    options.crossOriginResourcePolicy,
    "same-origin",
  );
  add(
    "permissions-policy",
    options.permissionsPolicy,
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  add("x-frame-options", options.frameOptions, "DENY");
  return list;
}

/** Whether the request was made over HTTPS: bun-common's `req.protocol` (trust-proxy aware) when built, else its URL. */
function overHttps(context: Parameters<BeforeWriteHook>[0]): boolean {
  return context.req !== undefined
    ? context.req.protocol === "https"
    : context.request.url.startsWith("https:");
}

/**
 * The security headers (layers.md L13.1) as a before-write hook: set on
 * every answer the adapter writes, the app's own values kept unless
 * `override`. `installSecurity` installs it; on its own, pass it to
 * `adapter.addBeforeWriteHook()`. Throws a `RangeError` for a bad
 * `hsts.maxAge`.
 *
 * @example
 * ```ts
 * adapter.addBeforeWriteHook(securityHeaders({ crossOriginResourcePolicy: "cross-origin" }));
 * ```
 */
export function securityHeaders(
  options: SecurityHeadersOptions = {},
): BeforeWriteHook {
  const list = headerList(options);
  const hsts =
    options.hsts === false ? undefined : hstsValue(options.hsts ?? {});
  const remove = (options.remove ?? ["x-powered-by", "server"]).map((name) =>
    name.toLowerCase(),
  );
  const override = options.override === true;
  const noStoreWithCookies = options.noStoreWithCookies ?? true;
  return (context) => {
    const headers = context.response.headers;
    for (const [name, value] of list) {
      if (override || !headers.has(name)) headers.set(name, value);
    }
    if (hsts !== undefined && overHttps(context)) {
      if (override || !headers.has("strict-transport-security")) {
        headers.set("strict-transport-security", hsts);
      }
    }
    for (const name of remove) headers.delete(name);
    if (
      noStoreWithCookies &&
      headers.has("set-cookie") &&
      !headers.has("cache-control")
    ) {
      headers.set("cache-control", "no-store");
    }
  };
}
