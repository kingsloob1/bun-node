/**
 * The server half of the `unauthorized` option, shared by `docsUi()` and
 * bun-jobs-ui's `jobsUi()`: validating it, telling a page navigation from any
 * other request, and answering the shell's `303`. The browser half is
 * `app/unauthorized.ts` (`./embed/unauthorized`); what both need is
 * `shared/unauthorized.ts`.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type {
  UiUnauthorized,
  UiUnauthorizedStatus,
} from "./shared/unauthorized";
import {
  DEFAULT_RETURN_PARAM,
  DEFAULT_UNAUTHORIZED_STATUSES,
  unauthorizedRedirectUrl,
} from "./shared/unauthorized";

/**
 * Builds the error a refused option throws: each caller passes its own
 * `ConfigError` (`docsUi()` bun-common's, `jobsUi()` bun-jobs'), so a refusal
 * is the class that caller's users already catch.
 */
export type UnauthorizedConfigError = (
  /** What is wrong, starting with the option's name. */
  message: string,
  /** The offending values, for the error's context. */
  context: Record<string, unknown>,
) => Error;

/** A query parameter name `unauthorized.returnParam` may be. */
const RETURN_PARAM = /^[\w.~-]+$/;

/** What a redirect target may not contain anywhere: whitespace, a control character or `\`. */
const UNSAFE_TARGET_CHAR = /[\s\\\p{Cc}]/u;

/** Any origin, to parse a path target with `new URL()`. */
const PATH_TARGET_ORIGIN = "http://unauthorized.invalid";

/** Whether `path` is `base` or lies under it, segment-wise. */
function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Validates `unauthorized.redirectTo`: a path starting with one `/`, or an
 * absolute `http(s)://` URL without credentials. A path is refused when it is
 * the UI's own `basePath` or under it: the UI would answer it, deny it, and
 * redirect again. The comparison resolves `..` as a browser does, and is
 * case-insensitive, because the router matches paths case-insensitively, as
 * Express does (`/JOBS/login` reaches a UI at `/jobs`). It also decodes
 * percent-escapes, which the router does not: stricter than needed, and
 * refusing such a target costs nothing. An absolute URL on the UI's own host
 * is caught by the app instead, which knows its origin.
 */
function resolveRedirectTarget(
  redirectTo: unknown,
  basePath: string,
  fail: UnauthorizedConfigError,
): string {
  const badTarget = (): Error =>
    fail(
      `unauthorized.redirectTo must be a path starting with "/" or an absolute http: or https: URL`,
      { redirectTo },
    );
  if (typeof redirectTo !== "string" || redirectTo === "") {
    throw badTarget();
  }
  if (UNSAFE_TARGET_CHAR.test(redirectTo)) {
    throw fail(
      `unauthorized.redirectTo may not contain whitespace, control characters or "\\"`,
      { redirectTo },
    );
  }
  if (redirectTo.startsWith("/")) {
    if (redirectTo.startsWith("//")) {
      throw fail(
        `unauthorized.redirectTo may not start with "//": a browser reads it as another host. Write the full https:// URL instead`,
        { redirectTo },
      );
    }
    const { pathname } = new URL(redirectTo, PATH_TARGET_ORIGIN);
    let decoded = pathname;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      // A malformed escape: compare it as written.
    }
    const path = decoded.replace(/\/+$/, "").toLowerCase();
    if (path !== "" && isWithin(path, basePath.toLowerCase())) {
      throw fail(
        `unauthorized.redirectTo ${redirectTo} is inside the UI's basePath ${basePath}: the UI would deny it again and redirect to itself, a redirect loop. Point it at a page outside ${basePath}`,
        { redirectTo, basePath },
      );
    }
    return redirectTo;
  }
  if (!/^https?:\/\//i.test(redirectTo)) {
    throw badTarget();
  }
  let url: URL;
  try {
    url = new URL(redirectTo);
  } catch {
    throw badTarget();
  }
  if (url.username !== "" || url.password !== "") {
    throw fail("unauthorized.redirectTo may not carry credentials", {
      redirectTo,
    });
  }
  return redirectTo;
}

/**
 * Validates the `unauthorized` option and fills in its defaults; `null` when
 * it is unset (the option is off). Every refusal is thrown as `fail` builds
 * it.
 *
 * @param value The option as the host passed it.
 * @param basePath The UI's normalised `basePath`, for the redirect-loop check.
 * @param fail Builds the caller's own `ConfigError`.
 */
export function resolveUnauthorized(
  value: unknown,
  basePath: string,
  fail: UnauthorizedConfigError,
): UiUnauthorized | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("unauthorized must be an object with a `redirectTo`", {
      value,
    });
  }
  const option = value as Record<string, unknown>;
  const redirectTo = resolveRedirectTarget(option.redirectTo, basePath, fail);

  let returnParam: string | null = DEFAULT_RETURN_PARAM;
  if (option.returnParam === false) {
    returnParam = null;
  } else if (option.returnParam !== undefined) {
    if (
      typeof option.returnParam !== "string" ||
      !RETURN_PARAM.test(option.returnParam)
    ) {
      throw fail(
        `unauthorized.returnParam must be false or a name of letters, digits, "_", ".", "~" and "-"`,
        { returnParam: option.returnParam },
      );
    }
    returnParam = option.returnParam;
  }

  let statuses = DEFAULT_UNAUTHORIZED_STATUSES;
  if (option.statuses !== undefined) {
    const list: unknown = option.statuses;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      !list.every((status) => status === 401 || status === 403)
    ) {
      throw fail(
        "unauthorized.statuses must be a non-empty array of 401 and 403 (leave unauthorized out to switch it off)",
        { statuses: list },
      );
    }
    statuses = Object.freeze(
      [...new Set(list as UiUnauthorizedStatus[])].sort((a, b) => a - b),
    );
  }
  return Object.freeze({ redirectTo, returnParam, statuses });
}

/**
 * Whether a request is a browser navigation, the only kind a redirect helps:
 * `Sec-Fetch-Mode: navigate` when the browser sends the header (every
 * current one does), else an `Accept` naming `text/html`. A script's
 * `fetch`, `curl` (whose `Accept` is the any-type wildcard) and a health
 * probe are not, and keep the problem.
 */
export function isNavigation(req: BunRequest): boolean {
  const mode = req.get("sec-fetch-mode");
  if (typeof mode === "string" && mode !== "") {
    return mode.toLowerCase() === "navigate";
  }
  return (req.get("accept") ?? "").toLowerCase().includes("text/html");
}

/**
 * Whether a denial with `status` should be answered with the redirect: the
 * option is on, the route is a page of the shell (not a bundle file, not a
 * document the viewer fetches), the status is listed, and the request is a
 * navigation.
 */
export function redirectsDenial(
  redirect: UiUnauthorized | null,
  shell: boolean,
  status: number,
  req: BunRequest,
): redirect is UiUnauthorized {
  return (
    redirect !== null &&
    shell &&
    (redirect.statuses as readonly number[]).includes(status) &&
    isNavigation(req)
  );
}

/** Answers `303 See Other` to the sign-in target, carrying the request's own path and query back. */
export function sendUnauthorizedRedirect(
  req: BunRequest,
  res: BunResponse,
  redirect: UiUnauthorized,
): void {
  res.status(303);
  res.setHeader("Location", unauthorizedRedirectUrl(redirect, req.originalUrl));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  void res.end();
}
