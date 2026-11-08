import type { QueryClient } from "@tanstack/react-query";
import type { UiUnauthorized } from "../../lib/kit/browser/unauthorized.ts";
import { createContext, use } from "react";
import { unauthorizedRedirectUrl } from "../../lib/kit/browser/unauthorized.ts";

/**
 * `unauthorized` in the browser: the one place an authorization failure
 * becomes a navigation, once per page load. Shared by the docs viewer and
 * the jobs UI (as `@kingsleyweb/bun-ui/docs/embed/unauthorized`).
 *
 * Sources report here: the query and mutation caches through
 * {@link watchAuthFailures} (any failed call, whichever client made it: the
 * viewer's document read; every jobs UI API call), the jobs UI's live
 * socket (`LiveClient`'s `onAuthFailure`), and the jobs UI's crashed screens
 * (through {@link UnauthorizedRedirect.probe}: a lazy screen's chunk the
 * shell's `authorize` refused fails with no status to read). No screen knows
 * about it; a failure that is not redirected shows its message as before.
 *
 * One per page: the app that owns the page creates it. The embedded docs
 * screens never do, so the jobs UI's docs section redirects through
 * the jobs UI's alone.
 */

/** The parts of `window.location` the redirect reads and calls. */
export interface RedirectLocation {
  /** The page's URL, to resolve the target and compare origins. */
  readonly href: string;
  /** Sends the browser to a URL. */
  assign: (url: string) => void;
}

/** A mount's redirect, made by {@link createUnauthorizedRedirect}. */
export interface UnauthorizedRedirect {
  /** Whether `unauthorized` is configured at all. */
  readonly enabled: boolean;
  /** Whether a report has sent the browser away (later reports do nothing). */
  readonly redirected: boolean;
  /**
   * Reports a failure's status. One the mount lists sends the browser to the
   * target, once: the first such report navigates, every later one returns
   * `true` without navigating again. Returns whether the browser was (or
   * already had been) sent away.
   */
  report: (status: number) => boolean;
  /** {@link UnauthorizedRedirect.report} for an error from any client: reads its numeric `status`, if it has one. */
  reportError: (error: unknown) => boolean;
  /**
   * Asks the server whether this page may still be loaded, for a failure
   * that carries no status: a `HEAD` of the shell (`basePath`), whose status
   * is reported. A screen whose chunk failed to load is the case: the
   * shell's `authorize` guards the bundle files, and a failed dynamic import
   * never says why. Resolves what {@link UnauthorizedRedirect.report} returned, or
   * `false` when the probe itself failed.
   */
  probe: () => Promise<boolean>;
}

/** Options of {@link createUnauthorizedRedirect}; tests replace both. */
export interface UnauthorizedRedirectOptions {
  /** Where to read the page's URL and navigate. Defaults to `globalThis.location`, looked up per report. */
  location?: () => RedirectLocation | undefined;
  /** The `fetch` {@link UnauthorizedRedirect.probe} calls. Defaults to `globalThis.fetch`, looked up per probe. */
  fetch?: () => typeof fetch;
}

/** The status an error carries, if any: `ApiError`'s, bun-client's `HttpError`'s, anything with a numeric `status`. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const { status } = error;
  return typeof status === "number" ? status : undefined;
}

/** Whether `path` is `base` or lies under it, segment-wise. */
function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** The pathname as the router compares it: decoded where it can be, lower-cased, no trailing `/`. */
function comparablePath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape: compare it as written.
  }
  return decoded.replace(/\/+$/, "").toLowerCase();
}

/** A redirect that never navigates: `unauthorized` is off. */
export const NO_UNAUTHORIZED_REDIRECT: UnauthorizedRedirect = Object.freeze({
  enabled: false,
  redirected: false,
  report: () => false,
  reportError: () => false,
  probe: () => Promise.resolve(false),
});

/**
 * Creates the redirect for one page load. `null` gives {@link NO_UNAUTHORIZED_REDIRECT}.
 *
 * The target carries `returnParam` set to the page the user is on (path,
 * query and fragment). A target that resolves into this UI on this origin is
 * never followed (an absolute URL `jobsUi()` could not check, since it does
 * not know its own origin): it would load the UI, fail again and loop, so
 * the screens show their messages instead.
 *
 * @param redirect `UiConfig.unauthorized`.
 * @param basePath `UiConfig.basePath`.
 * @param options Where to navigate and what to fetch with; see {@link UnauthorizedRedirectOptions}.
 */
export function createUnauthorizedRedirect(
  redirect: UiUnauthorized | null,
  basePath: string,
  options: UnauthorizedRedirectOptions = {},
): UnauthorizedRedirect {
  const getLocation = options.location ?? (() => globalThis.location);
  const getFetch = options.fetch ?? (() => globalThis.fetch);
  if (redirect === null) {
    return NO_UNAUTHORIZED_REDIRECT;
  }
  const statuses = new Set<number>(redirect.statuses);
  const base = basePath.toLowerCase();
  let redirected = false;

  const report = (status: number): boolean => {
    if (redirected) {
      return true;
    }
    if (!statuses.has(status)) {
      return false;
    }
    const location = getLocation();
    if (location === undefined) {
      return false;
    }
    const here = new URL(location.href);
    const target = unauthorizedRedirectUrl(
      redirect,
      `${here.pathname}${here.search}${here.hash}`,
    );
    const resolved = new URL(target, here);
    if (
      resolved.origin === here.origin &&
      isWithin(comparablePath(resolved.pathname), base)
    ) {
      return false;
    }
    redirected = true;
    location.assign(target);
    return true;
  };

  return {
    enabled: true,
    get redirected() {
      return redirected;
    },
    report,
    reportError: (error) => {
      const status = statusOf(error);
      return status === undefined ? false : report(status);
    },
    probe: async () => {
      if (redirected) {
        return true;
      }
      let status: number;
      try {
        const response = await getFetch()(basePath, {
          method: "HEAD",
          credentials: "same-origin",
          cache: "no-store",
        });
        status = response.status;
      } catch {
        return false;
      }
      return report(status);
    },
  };
}

/**
 * Reports every failed query and mutation of `queryClient` to `redirect`:
 * the cache-level hook, so every API call is covered whichever client made it
 * and no screen needs code of its own. Returns the unsubscribe. Subscribes to
 * nothing when the redirect is off.
 */
export function watchAuthFailures(
  queryClient: QueryClient,
  redirect: UnauthorizedRedirect,
): () => void {
  if (!redirect.enabled) {
    return () => {};
  }
  const offQueries = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "error") {
      redirect.reportError(event.action.error);
    }
  });
  const offMutations = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "error") {
      redirect.reportError(event.action.error);
    }
  });
  return () => {
    offQueries();
    offMutations();
  };
}

/** Carries the page's {@link UnauthorizedRedirect}; {@link NO_UNAUTHORIZED_REDIRECT} outside `AppProviders`. */
export const UnauthorizedRedirectContext = createContext<UnauthorizedRedirect>(
  NO_UNAUTHORIZED_REDIRECT,
);

/** The page's {@link UnauthorizedRedirect}. */
export function useUnauthorizedRedirect(): UnauthorizedRedirect {
  return use(UnauthorizedRedirectContext);
}
