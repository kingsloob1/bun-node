import type { ReactNode } from "react";
import { createContext, use, useCallback, useMemo } from "react";

/**
 * A small history router scoped under the mount's `basePath`.
 *
 * The app's routes are flat and few, so this replaces a router library: it
 * tracks `location.pathname`/`search` relative to `basePath`, intercepts
 * plain left-clicks on its {@link Link}s, matches `:param` and trailing `*`
 * patterns, and keeps URL-addressable state in the query string. A path
 * outside `basePath` matches nothing and renders the 404.
 */

/** Where the app is, relative to `basePath`. */
export interface AppLocation {
  /** Path under `basePath`, always starting with `/`; `null` when the URL is outside `basePath`. */
  path: string | null;
  /** The query string, with its leading `?` (or `""`). */
  search: string;
}

/** Options of a navigation. */
export interface NavigateOptions {
  /** Replace the current history entry instead of pushing one. Defaults to `false`. */
  replace?: boolean;
}

/** What the router provides. */
export interface RouterContextValue {
  /** The mount path, no trailing slash (`""` when mounted at the root). */
  basePath: string;
  /** The current location. */
  location: AppLocation;
  /** Navigates to an app path (relative to `basePath`, may carry `?query`). */
  navigate: (to: string, options?: NavigateOptions) => void;
  /** The full URL path for an app path. */
  href: (to: string) => string;
}

/** Carries the router. */
export const RouterContext = createContext<RouterContextValue | null>(null);
/** Carries the params the matched route bound. */
export const ParamsContext = createContext<Readonly<Record<string, string>>>(
  {},
);

/** Normalises a base path: leading `/`, no trailing `/`, `/` itself becomes `""`. */
export function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, "");
  if (trimmed === "") {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * The path under `basePath`, or `null` when `pathname` is outside it.
 * `/jobs` and `/jobs/` are both `/`; `/jobsx` is outside `/jobs`.
 */
export function stripBasePath(
  pathname: string,
  basePath: string,
): string | null {
  const base = normalizeBasePath(basePath);
  if (base !== "" && pathname !== base && !pathname.startsWith(`${base}/`)) {
    return null;
  }
  const rest = pathname.slice(base.length);
  if (rest === "" || rest === "/") {
    return "/";
  }
  return rest.length > 1 && rest.endsWith("/") ? rest.slice(0, -1) : rest;
}

/**
 * Matches an app path against a pattern: `/queues/:queue` binds `queue`
 * (percent-decoded), a trailing `/*` binds the rest as `*`. Returns the
 * params, or `null` when it does not match.
 */
export function matchPath(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index++) {
    const part = patternParts[index]!;
    if (part === "*" && index === patternParts.length - 1) {
      params["*"] = pathParts.slice(index).map(safeDecode).join("/");
      return params;
    }
    const actual = pathParts[index];
    if (actual === undefined) {
      return null;
    }
    if (part.startsWith(":")) {
      params[part.slice(1)] = safeDecode(actual);
    } else if (part !== actual) {
      return null;
    }
  }
  return pathParts.length === patternParts.length ? params : null;
}

/** `decodeURIComponent`, keeping a malformed segment as it is. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Reads the current location from `window.location`. */
export function readLocation(basePath: string): AppLocation {
  return {
    path: stripBasePath(window.location.pathname, basePath),
    search: window.location.search,
  };
}

/** The router, or a clear error outside a {@link RouterProvider}. */
export function useRouter(): RouterContextValue {
  const router = use(RouterContext);
  if (!router) {
    throw new Error("useRouter must be used inside a <RouterProvider>");
  }
  return router;
}

/** The current location. */
export function useLocation(): AppLocation {
  return useRouter().location;
}

/** A function that navigates to an app path. */
export function useNavigate(): RouterContextValue["navigate"] {
  return useRouter().navigate;
}

/** A function that turns an app path into a full URL path. */
export function useHref(): RouterContextValue["href"] {
  return useRouter().href;
}

/** The params the matched route bound. */
export function useParams<
  T extends Record<string, string> = Record<string, string>,
>(): Readonly<T> {
  return use(ParamsContext) as Readonly<T>;
}

/** The current query string, parsed. */
export function useSearchParams(): URLSearchParams {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

/**
 * One query-string value as state: `[value, setValue]`. Setting `""` or
 * `null` removes the key. Updates replace the history entry, so typing in a
 * filter does not flood the back button.
 */
export function useQueryParam(
  key: string,
): [string, (value: string | null) => void] {
  const { location, navigate } = useRouter();
  const value = new URLSearchParams(location.search).get(key) ?? "";
  const setValue = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (next === null || next === "") {
        params.delete(key);
      } else {
        params.set(key, next);
      }
      const query = params.toString();
      navigate(`${location.path ?? "/"}${query ? `?${query}` : ""}`, {
        replace: true,
      });
    },
    [key, location.path, navigate],
  );
  return [value, setValue];
}

/** One route: a pattern and what it renders. */
export interface RouteDef {
  /** Pattern relative to `basePath`: `/`, `/queues/:queue`, `/docs/*`. */
  path: string;
  /** What the route renders; params are available through {@link useParams}. */
  element: ReactNode;
}
