import type { Root } from "react-dom/client";
import type { DocsUiConfig } from "../lib/shared/config.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readDocsUiConfig } from "./config";
import { createQueryClient } from "./queryClient";
import { applyTheme, initialTheme } from "./theme";

/** Options of {@link boot}. */
export interface BootOptions {
  /** The document to read the config from and render into. Defaults to `document`. */
  doc?: Document;
  /** Retry failed reads. Defaults to `true`; tests pass `false`. */
  retry?: boolean;
}

/** What {@link boot} started. */
export interface BootResult {
  /** The config it read. */
  config: DocsUiConfig;
  /** The React root; `unmount()` tears the app down. */
  root: Root;
}

/**
 * Starts the viewer: reads the injected config, applies the theme, and renders
 * into `#root`. A missing or malformed config renders a plain message
 * instead (there is no document to fetch without it) and rethrows.
 */
export function boot(options: BootOptions = {}): BootResult {
  const doc = options.doc ?? document;
  const container = doc.getElementById("root");
  if (!container) {
    throw new Error("The page has no #root element.");
  }
  let config: DocsUiConfig;
  try {
    config = readDocsUiConfig(doc);
  } catch (error) {
    container.textContent = `The API docs viewer could not start: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
  applyTheme(initialTheme(config.theme), doc.documentElement);
  doc.title = config.title;

  const queryClient = createQueryClient({ retry: options.retry });
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <App
        config={config}
        queryClient={queryClient}
      />
    </StrictMode>,
  );
  return { config, root };
}
