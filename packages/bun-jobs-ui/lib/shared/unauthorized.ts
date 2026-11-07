/**
 * Where to send the browser when the caller turns out not to be signed in:
 * the part of `jobsUi()`'s `unauthorized` option that both the server (the
 * shell's 303) and the app (an API 401) need. Pure functions, no runtime
 * imports: the app bundles this file for the browser.
 */

/** A status that can trigger the redirect: 401 (not signed in) or 403 (not allowed). */
export type UiUnauthorizedStatus = 401 | 403;

/** The resolved `unauthorized` option, as the browser receives it in `UiConfig`. */
export interface UiUnauthorized {
  /** The target: a path (`"/login"`) or an absolute `http(s)` URL, validated by `jobsUi()`. */
  redirectTo: string;
  /** The query parameter that carries the in-app location back, or `null` for none. */
  returnParam: string | null;
  /** The statuses that redirect, ascending and without repeats (`[401]` by default). */
  statuses: readonly UiUnauthorizedStatus[];
}

/** Any origin, used to parse a path target as a URL and print it back as a path. */
const PATH_ORIGIN = "http://bun-jobs-ui.invalid";

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
 * `returnParam` already in `redirectTo`'s query is replaced, and its fragment is
 * kept.
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
