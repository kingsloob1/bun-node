/** Starts the security app: reads the config, applies theme and layout, renders. */
import type { Root } from "react-dom/client";
import type { SecurityUiConfig } from "../../lib/security/browser/config.ts";
import type { SecurityClientOptions } from "./api/client";
import type { LiveOptions } from "./live/context";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyLayout } from "../kit/layout";
import { createSecurityClient } from "./api/client";
import { App } from "./App";
import { readUiConfig } from "./config";
import { LiveOptionsContext } from "./live/context";
import { AppProviders } from "./providers";
import { createQueryClient } from "./queryClient";
import { breakGlassStore } from "./session/breakGlass";
import { applyTheme, initialTheme } from "./theme";

/** Options of {@link boot} (tests inject these). */
export interface BootOptions {
  /** The document. Default `document`. */
  doc?: Document;
  /** The client's options (tests inject `fetch`). */
  client?: SecurityClientOptions;
  /** Retry failed reads. Default `true`. */
  retry?: boolean;
  /** The live stream's options. */
  live?: LiveOptions;
  /** Where the break-glass session is kept. Default `sessionStorage`. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** What {@link boot} started. */
export interface BootResult {
  /** The config read. */
  config: SecurityUiConfig;
  /** The React root. */
  root: Root;
}

/** The session storage, when the browser lets the page have it. */
function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** See the module's description. */
export function boot(options: BootOptions = {}): BootResult {
  const doc = options.doc ?? document;
  const container = doc.getElementById("root");
  if (!container) throw new Error("The page has no #root element.");
  let config: SecurityUiConfig;
  try {
    config = readUiConfig(doc);
  } catch (error) {
    container.textContent = `The security UI could not start: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
  applyTheme(initialTheme(config.theme), doc.documentElement);
  applyLayout(config.layout, doc.documentElement);
  doc.title = config.title;
  const client = createSecurityClient(
    config,
    breakGlassStore(
      options.storage === undefined ? sessionStore() : options.storage,
    ),
    options.client,
  );
  const queryClient = createQueryClient({ retry: options.retry });
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <LiveOptionsContext value={options.live ?? null}>
        <AppProviders
          config={config}
          client={client}
          queryClient={queryClient}
        >
          <App />
        </AppProviders>
      </LiveOptionsContext>
    </StrictMode>,
  );
  return { config, root };
}
