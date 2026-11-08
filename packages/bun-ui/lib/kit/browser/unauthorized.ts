/**
 * The `unauthorized` option: where to send the browser when the caller turns
 * out not to be signed in. Shared by `docsUi()` and `jobsUi()`,
 * on both sides of each: the server (the shell's 303) and the app (an API
 * 401). Types, defaults and pure functions only, with no runtime imports: the
 * apps bundle this file for the browser.
 */

/** A status that can trigger the redirect: 401 (not signed in) or 403 (not allowed). */
export type UiUnauthorizedStatus = 401 | 403;

/**
 * The `unauthorized` option as a host writes it: where to send the browser
 * when an authorization check fails, instead of leaving it on a page that
 * reports the failure.
 */
export interface UnauthorizedOptions {
  /**
   * Where to go: a path on this host starting with one `/` (`"/login"`,
   * `"/auth/sign-in?app=jobs"`), or an absolute `http:`/`https:` URL (an
   * identity provider's sign-in page). Required. A path inside the UI's own
   * `basePath` is a `ConfigError`: the UI would redirect to itself.
   * `javascript:`, `data:`, `//host` and anything else are refused.
   */
  redirectTo: string;
  /**
   * Query parameter that carries the page the user was on, so the sign-in
   * page can send them back: path, query and (in the browser) fragment,
   * always a relative URL starting with one `/` (e.g.
   * `/login?returnTo=%2Fdocs%2Fhttp`). `false` adds nothing. Defaults to
   * `"returnTo"`. Letters, digits, `_`, `.`, `~` and `-` only. The sign-in
   * page must still check the value before redirecting to it.
   */
  returnParam?: string | false;
  /**
   * Which failures redirect. Defaults to `[401]`: only "not signed in". A 403
   * means signed in but not allowed, which the page explains itself; add
   * `403` to redirect on that too. Must be a non-empty array of `401` and
   * `403`.
   */
  statuses?: readonly UiUnauthorizedStatus[];
}

/** The resolved `unauthorized` option, as the browser receives it in the page's config. */
export interface UiUnauthorized {
  /** The target: a path (`"/login"`) or an absolute `http(s)` URL, validated on the server. */
  redirectTo: string;
  /** The query parameter that carries the in-app location back, or `null` for none. */
  returnParam: string | null;
  /** The statuses that redirect, ascending and without repeats (`[401]` by default). */
  statuses: readonly UiUnauthorizedStatus[];
}

/** `unauthorized.returnParam` when unset. */
export const DEFAULT_RETURN_PARAM = "returnTo";

/** `unauthorized.statuses` when unset: only "not signed in". */
export const DEFAULT_UNAUTHORIZED_STATUSES: readonly UiUnauthorizedStatus[] =
  Object.freeze([401]);

/**
 * Whether a value read back from a page's config has the shape of a
 * {@link UiUnauthorized}: enough that a stale or hand-edited shell fails with
 * a message instead of a broken redirect. The server validated the values.
 */
export function isUiUnauthorized(value: unknown): value is UiUnauthorized {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.redirectTo === "string" &&
    (record.returnParam === null || typeof record.returnParam === "string") &&
    Array.isArray(record.statuses) &&
    record.statuses.every((status) => status === 401 || status === 403)
  );
}

/** Any origin, used to parse a path target as a URL and print it back as a path. */
const PATH_ORIGIN = "http://unauthorized.invalid";

/**
 * Makes an in-app location safe to hand back as a relative URL: it starts
 * with exactly one `/` (never `//` or `/\`, which a browser reads as another
 * host). Anything not starting with `/` becomes `/`.
 */
export function relativeReturnPath(location: string): string {
  if (!location.startsWith("/")) {
    return "/";
  }
  return location.replace(/^[/\\]+/, "/");
}

/**
 * The URL to send the browser to: `redirectTo`, with `returnParam` set to
 * `returnPath` (made relative by {@link relativeReturnPath}) when both are
 * given. A path target stays a path; an absolute target stays absolute. A
 * `returnParam` already in `redirectTo`'s query is replaced, and its
 * fragment is kept.
 */
export function unauthorizedRedirectUrl(
  redirect: Pick<UiUnauthorized, "redirectTo" | "returnParam">,
  returnPath: string | undefined,
): string {
  if (redirect.returnParam === null || returnPath === undefined) {
    return redirect.redirectTo;
  }
  const isPath = redirect.redirectTo.startsWith("/");
  const url = isPath
    ? new URL(redirect.redirectTo, PATH_ORIGIN)
    : new URL(redirect.redirectTo);
  url.searchParams.set(redirect.returnParam, relativeReturnPath(returnPath));
  return isPath ? `${url.pathname}${url.search}${url.hash}` : url.href;
}
