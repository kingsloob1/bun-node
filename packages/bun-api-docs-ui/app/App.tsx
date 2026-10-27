import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { FetchLike } from "./api/client";
import type { DocsUiConfig } from "../lib/shared/config.ts";
import { useEffect } from "react";
import { DocsFetchContext, DocsUiConfigContext } from "./context";
import { RouterProvider } from "./router";
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

/** The whole viewer: providers, routing, the document. */
export function App({ config, queryClient, fetch }: AppProps) {
  useSearchShortcut();
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
