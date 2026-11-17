/** The providers every screen reads: the query cache, the config, the client, the router, meta. */
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SecurityUiConfig } from "../../lib/security/browser/config.ts";
import type { SecurityClient } from "./api/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  createUnauthorizedRedirect,
  UnauthorizedRedirectContext,
  watchAuthFailures,
} from "@kingsleyweb/bun-ui/docs/embed/unauthorized";
import { ToastProvider } from "../kit/components/ToastProvider";
import { SecurityClientContext, UiConfigContext } from "./context";
import { MetaProvider } from "./meta/MetaProvider";
import { RouterProvider } from "./router";

/** Props of {@link AppProviders}. */
export interface AppProvidersProps {
  /** The injected configuration. */
  config: SecurityUiConfig;
  /** The API client. */
  client: SecurityClient;
  /** The query cache. */
  queryClient: QueryClient;
  /** The app. */
  children: ReactNode;
}

/** See the module's description. */
export function AppProviders({
  config,
  client,
  queryClient,
  children,
}: AppProvidersProps) {
  const unauthorized = useMemo(
    () => createUnauthorizedRedirect(config.unauthorized, config.basePath),
    [config.unauthorized, config.basePath],
  );
  useEffect(
    () => watchAuthFailures(queryClient, unauthorized),
    [queryClient, unauthorized],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <UiConfigContext value={config}>
        <UnauthorizedRedirectContext value={unauthorized}>
          <SecurityClientContext value={client}>
            <ToastProvider>
              <RouterProvider basePath={config.basePath}>
                <MetaProvider>{children}</MetaProvider>
              </RouterProvider>
            </ToastProvider>
          </SecurityClientContext>
        </UnauthorizedRedirectContext>
      </UiConfigContext>
    </QueryClientProvider>
  );
}
