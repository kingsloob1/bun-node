/**
 * Renders the security app the way `boot()` does — its providers, its
 * client over a fake API, the live stream off unless asked — at a path
 * under the mount.
 */
import type { SecurityUiConfig } from "../../../lib/security/browser/config.ts";
import type { MockApi, MockHandler, MockReply } from "./mockApi";
import { createSecurityClient } from "../../../app/security/api/client";
import { App } from "../../../app/security/App";
import { LiveOptionsContext } from "../../../app/security/live/context";
import { AppProviders } from "../../../app/security/providers";
import { createQueryClient } from "../../../app/security/queryClient";
import { breakGlassStore } from "../../../app/security/session/breakGlass";
import { render, visit } from "./dom";
import { securityConfig } from "./config";
import { defaultRoutes, mockApi } from "./mockApi";

export { securityConfig };

/** Options of {@link renderApp}. */
export interface RenderAppOptions {
  /** The path under the mount, with its query (`"/"`, `"/api?scope=global"`). */
  path?: string;
  /** The routes, over {@link defaultRoutes}. */
  routes?: Record<string, MockHandler | MockReply>;
  /** Replace the default routes entirely. */
  replaceRoutes?: boolean;
  /** Config overrides. */
  config?: Partial<SecurityUiConfig>;
  /** Turn the live stream on (default off). */
  live?: boolean;
  /** The break-glass storage (default `window.sessionStorage`). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** The clock the break-glass store reads. */
  now?: () => number;
}

/** Renders the app; the fake API and the client. */
export function renderApp(options: RenderAppOptions = {}) {
  const config = securityConfig(options.config);
  const api: MockApi = mockApi(config.apiBase, {
    ...(options.replaceRoutes === true ? {} : defaultRoutes()),
    ...options.routes,
  });
  const client = createSecurityClient(
    config,
    breakGlassStore(options.storage ?? window.sessionStorage, options.now),
    {
      fetch: api.fetch,
    },
  );
  const queryClient = createQueryClient({ retry: false });
  visit(`${config.basePath}${options.path ?? "/"}`);
  const view = render(
    <LiveOptionsContext value={{ disabled: options.live !== true }}>
      <AppProviders
        config={config}
        client={client}
        queryClient={queryClient}
      >
        <App />
      </AppProviders>
    </LiveOptionsContext>,
  );
  return { view, api, client, queryClient, config };
}
