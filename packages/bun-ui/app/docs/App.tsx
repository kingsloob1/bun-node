import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { FetchLike } from "./api/client";
import type { DocsUiConfig } from "../../lib/docs/browser/config.ts";
import { useEffect, useMemo } from "react";
import { DocsFetchContext, DocsUiConfigContext } from "./context";
import { RouterProvider } from "./router";
import {
  createUnauthorizedRedirect,
  watchAuthFailures,
} from "../kit/unauthorized";
import { DocsViewer } from "./screens/docs/viewer";
import { findSearchBox, shortcutFor } from "./shortcuts";

/** Props of {@link App}. */
export interface AppProps {
  /** The injected configuration. */
  config: DocsUiConfig;
  /** The query client (tests pass one without retries). */
  queryClient: QueryClient;
  /** The `fetch` every request goes through (tests inject one). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
}

/** The `/` shortcut: focus the screen's search box. */
function useSearchShortcut() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutFor(event) === "focus-search") {
        const box = findSearchBox(document);
        if (box) {
          event.preventDefault();
          box.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/**
 * The whole viewer: providers, routing, the document. With
 * `config.unauthorized`, a failed document read whose status it lists sends
 * the browser to the sign-in target, once (`unauthorized.ts`). Only the
 * viewer's own queries reach the cache: the try-it panel's calls do not, so
 * the documented API's 401 to a tried request never redirects.
 */
export function App({ config, queryClient, fetch }: AppProps) {
  useSearchShortcut();
  const unauthorized = useMemo(
    () => createUnauthorizedRedirect(config.unauthorized, config.basePath),
    [config.unauthorized, config.basePath],
  );
  useEffect(
    () => watchAuthFailures(queryClient, unauthorized),
    [queryClient, unauthorized],
  );
  return (
    <DocsUiConfigContext value={config}>
      <DocsFetchContext value={fetch ?? null}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider basePath={config.basePath}>
            <div className="docs-viewer">
              <DocsViewer />
            </div>
          </RouterProvider>
        </QueryClientProvider>
      </DocsFetchContext>
    </DocsUiConfigContext>
  );
}
