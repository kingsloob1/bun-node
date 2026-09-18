import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import type { NavigateOptions, RouteDef } from "./routing";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  matchPath,
  normalizeBasePath,
  ParamsContext,
  readLocation,
  RouterContext,
  useLocation,
  useNavigate,
  useRouter,
} from "./routing";

/**
 * The router's components: the provider, route matching, redirects and
 * links. The pure path functions and the hooks live in `routing.ts`.
 */

/** Props of {@link RouterProvider}. */
export interface RouterProviderProps {
  /** The mount path (`UiConfig.basePath`). */
  basePath: string;
  /** The app. */
  children: ReactNode;
}

/** Provides routing under `basePath`, following `window.history`. */
export function RouterProvider({ basePath, children }: RouterProviderProps) {
  const base = normalizeBasePath(basePath);
  const [location, setLocation] = useState(() => readLocation(base));

  useEffect(() => {
    const onPopState = () => setLocation(readLocation(base));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [base]);

  const href = useCallback(
    (to: string) => {
      const target = to.startsWith("/") ? to : `/${to}`;
      if (base === "") {
        return target;
      }
      // `/` is the mount itself; keep the query attached without a slash.
      return target === "/" || target.startsWith("/?")
        ? `${base}${target.slice(1)}`
        : `${base}${target}`;
    },
    [base],
  );

  const navigate = useCallback(
    (to: string, options: NavigateOptions = {}) => {
      const url = href(to);
      if (options.replace) {
        window.history.replaceState(null, "", url);
      } else {
        window.history.pushState(null, "", url);
      }
      setLocation(readLocation(base));
    },
    [base, href],
  );

  const value = useMemo(
    () => ({ basePath: base, location, navigate, href }),
    [base, location, navigate, href],
  );
  return <RouterContext value={value}>{children}</RouterContext>;
}

/** Props of {@link Routes}. */
export interface RoutesProps {
  /** Routes, tried in order; the first match wins. */
  routes: readonly RouteDef[];
  /** Rendered when nothing matches (including a URL outside `basePath`). */
  notFound: ReactNode;
}

/** Renders the first route matching the current location. */
export function Routes({ routes, notFound }: RoutesProps) {
  const { path } = useLocation();
  if (path !== null) {
    for (const route of routes) {
      const params = matchPath(route.path, path);
      if (params) {
        return (
          <ParamsContext
            key={route.path}
            value={params}
          >
            {route.element}
          </ParamsContext>
        );
      }
    }
  }
  return <>{notFound}</>;
}

/** Props of {@link Navigate}. */
export interface NavigateProps {
  /** App path to go to. */
  to: string;
  /** Replace the history entry. Defaults to `true`: a redirect should not be a back-button stop. */
  replace?: boolean;
}

/** Redirects on render. */
export function Navigate({ to, replace = true }: NavigateProps) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace });
  }, [navigate, to, replace]);
  return null;
}

/** Props of {@link Link}. */
export interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  /** App path (relative to `basePath`), may carry `?query`. */
  to: string;
  /** Mark the link `aria-current="page"` when the location matches: `"exact"`, or `"prefix"` for a section. Defaults to none. */
  activeMatch?: "exact" | "prefix";
}

/** Whether a click should be left to the browser (new tab, download, modified). */
function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.altKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.defaultPrevented
  );
}

/** An `<a>` that navigates in-app on a plain left-click. */
export function Link({ to, activeMatch, onClick, target, ...rest }: LinkProps) {
  const { navigate, href, location } = useRouter();
  const toPath = to.split("?")[0] || "/";
  const active =
    location.path !== null &&
    (activeMatch === "exact"
      ? location.path === toPath
      : activeMatch === "prefix"
        ? toPath === "/"
          ? location.path === "/"
          : location.path === toPath || location.path.startsWith(`${toPath}/`)
        : false);
  return (
    <a
      {...rest}
      target={target}
      href={href(to)}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (isModifiedClick(event) || (target && target !== "_self")) {
          return;
        }
        event.preventDefault();
        navigate(to);
      }}
    />
  );
}
