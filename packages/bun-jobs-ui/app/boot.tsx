import type { Root } from "react-dom/client";
import type { UiConfig } from "../shared/config.ts";
import type { ApiClientOptions } from "./api/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "./api/client";
import { App } from "./App";
import { readUiConfig } from "./config";
import { AppProviders } from "./providers";
import { createQueryClient } from "./queryClient";
import { applyTheme, initialTheme } from "./theme";

/** Options of {@link boot}. */
export interface BootOptions {
  /** The document to read the config from and render into. Defaults to `document`. */
  doc?: Document;
  /** Passed to the API client (tests inject `fetch`). */
  client?: ApiClientOptions;
  /** Retry failed reads. Defaults to `true`; tests pass `false`. */
  retry?: boolean;
}

/** What {@link boot} started. */
export interface BootResult {
  /** The config it read. */
  config: UiConfig;
  /** The React root; `unmount()` tears the app down. */
  root: Root;
}

/**
 * Starts the app: reads the injected config, applies the theme, and renders
 * into `#root`. A missing or malformed config renders a plain message
 * instead (there is no API to talk to without it) and rethrows.
 */
export function boot(options: BootOptions = {}): BootResult {
  const doc = options.doc ?? document;
  const container = doc.getElementById("root");
  if (!container) {
    throw new Error("The page has no #root element.");
  }
  let config: UiConfig;
  try {
    config = readUiConfig(doc);
  } catch (error) {
    container.textContent = `The jobs UI could not start: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
  applyTheme(initialTheme(config.theme), doc.documentElement);
  doc.title = config.title;

  const client = createApiClient(config, options.client);
  const queryClient = createQueryClient({ retry: options.retry });
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <AppProviders
        config={config}
        client={client}
        queryClient={queryClient}
      >
        <App />
      </AppProviders>
    </StrictMode>,
  );
  return { config, root };
}
