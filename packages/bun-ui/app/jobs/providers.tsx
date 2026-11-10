import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { JobsUiConfig } from "../../lib/jobs/browser/config.ts";
import type { ApiClient } from "./api/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  UnauthorizedRedirectContext,
  createUnauthorizedRedirect,
  watchAuthFailures,
} from "@kingsleyweb/bun-ui/docs/embed/unauthorized";
import { ToastProvider } from "../kit/components/ToastProvider";
import { ApiClientContext, UiConfigContext } from "./context";
import { MetaProvider } from "./meta/MetaProvider";
import { RouterProvider } from "./router";

/** Props of {@link AppProviders}. */
export interface AppProvidersProps {
  /** The injected configuration. */
  config: JobsUiConfig;
  /** The API client, built from `config` by `createApiClient`. */
  client: ApiClient;
  /** The query cache. */
  queryClient: QueryClient;
  /** The app. */
  children: ReactNode;
}

/**
 * Everything a screen needs above it: query cache, config, API client,
 * toasts, router, and the `/meta` bootstrap (which renders the loading and error
 * screens itself, so `children` only render once meta and permissions are
 * loaded). With `config.unauthorized`, every failed query and mutation is
 * also watched here, and the first one with a configured status sends the
 * browser to the sign-in target (`@kingsleyweb/bun-ui/docs/embed/unauthorized`).
 */
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
          <ApiClientContext value={client}>
            <ToastProvider>
              <RouterProvider basePath={config.basePath}>
                <MetaProvider>{children}</MetaProvider>
              </RouterProvider>
            </ToastProvider>
          </ApiClientContext>
        </UnauthorizedRedirectContext>
      </UiConfigContext>
    </QueryClientProvider>
  );
}
