import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import type { FetchLike } from "./api/client";
import type { DocsUiConfig } from "../../lib/docs/browser/config.ts";
import type { UnauthorizedRedirect } from "../kit/unauthorized";
import type { RouterHistory } from "./routing";
import { useEffect, useMemo } from "react";
import { isUiEvent, useMountRoot } from "../kit/frame";
import { DocsFetchContext, DocsUiConfigContext } from "./context";
import { RouterProvider } from "./router";
import {
  createUnauthorizedRedirect,
  watchAuthFailures,
} from "../kit/unauthorized";
import { DocsTabs } from "./layout/DocsTabs";
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
  /** Where the router reads and moves the URL (a mount's); the page's own history when absent. */
  history?: RouterHistory;
  /** What an authorization failure does (a mount's); the config's `unauthorized` redirect when absent. */
  unauthorized?: UnauthorizedRedirect;
  /** Wraps the routed viewer (a mount's renders nothing outside `basePath`). Defaults to none. */
  guard?: ComponentType<{ children: ReactNode }>;
}

/** No guard: the viewer as it is. */
function NoGuard({ children }: { children: ReactNode }) {
  return children;
}

/** The `/` shortcut: focus the screen's search box. */
function useSearchShortcut() {
  const root = useMountRoot();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Mounted, only a key pressed inside the mount element counts.
      if (shortcutFor(event) === "focus-search" && isUiEvent(root, event)) {
        const box = findSearchBox(root ?? document);
        if (box) {
          event.preventDefault();
          box.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [root]);
}

/**
 * The whole viewer: providers, routing, the document. With
 * `config.unauthorized`, a failed document read whose status it lists sends
 * the browser to the sign-in target, once (`unauthorized.ts`). Only the
 * viewer's own queries reach the cache: the try-it panel's calls do not, so
 * the documented API's 401 to a tried request never redirects. With
 * `shell: "tabs"`, the kit's compact bar names the document's section
 * above it ({@link DocsTabs}).
 */
export function App({
  config,
  queryClient,
  fetch,
  history,
  unauthorized: given,
  guard: Guard = NoGuard,
}: AppProps) {
  useSearchShortcut();
  const unauthorized = useMemo(
    () =>
      given ?? createUnauthorizedRedirect(config.unauthorized, config.basePath),
    [given, config.unauthorized, config.basePath],
  );
  useEffect(
    () => watchAuthFailures(queryClient, unauthorized),
    [queryClient, unauthorized],
  );
  return (
    <DocsUiConfigContext value={config}>
      <DocsFetchContext value={fetch ?? null}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider
            basePath={config.basePath}
            history={history}
          >
            <Guard>
              {config.shell === "tabs" && <DocsTabs />}
              {/* The page's main landmark: the viewer has no header or nav of its own. */}
              <main
                className="docs-viewer"
                data-shell={config.shell ?? "full"}
              >
                <DocsViewer />
              </main>
            </Guard>
          </RouterProvider>
        </QueryClientProvider>
      </DocsFetchContext>
    </DocsUiConfigContext>
  );
}
