/**
 * The app's router components: the docs viewer's provider, links and
 * redirect (the one router every UI shares), and {@link Routes}, which
 * renders the matched screen inside this app's error boundary.
 */
import type { ReactNode } from "react";
import type { RouteDef } from "./routing";
import { ScreenErrorBoundary } from "./components/ScreenErrorBoundary";
import { matchPath, ParamsContext, useLocation } from "./routing";

export {
  Link,
  Navigate,
  RouterProvider,
} from "@kingsleyweb/bun-ui/docs/embed/router";

/** Props of {@link Routes}. */
export interface RoutesProps {
  /** Routes, tried in order; the first match wins. */
  routes: readonly RouteDef[];
  /** Rendered when nothing matches. */
  notFound: ReactNode;
}

/** The first route matching the location, inside the screen error boundary. */
export function Routes({ routes, notFound }: RoutesProps) {
  const { path } = useLocation();
  let matched: ReactNode = notFound;
  if (path !== null) {
    for (const route of routes) {
      const params = matchPath(route.path, path);
      if (params) {
        matched = (
          <ParamsContext
            key={route.path}
            value={params}
          >
            {route.element}
          </ParamsContext>
        );
        break;
      }
    }
  }
  return (
    <ScreenErrorBoundary resetKey={path ?? ""}>{matched}</ScreenErrorBoundary>
  );
}
