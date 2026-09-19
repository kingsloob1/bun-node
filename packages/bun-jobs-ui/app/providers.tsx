import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { UiConfig } from "../lib/shared/config.ts";
import type { ApiClient } from "./api/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./components/ToastProvider";
import { ApiClientContext, UiConfigContext } from "./context";
import { MetaProvider } from "./meta/MetaProvider";
import { RouterProvider } from "./router";

/** Props of {@link AppProviders}. */
export interface AppProvidersProps {
  /** The injected configuration. */
  config: UiConfig;
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
 * loaded).
 */
export function AppProviders({
  config,
  client,
  queryClient,
  children,
}: AppProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <UiConfigContext value={config}>
        <ApiClientContext value={client}>
          <ToastProvider>
            <RouterProvider basePath={config.basePath}>
              <MetaProvider>{children}</MetaProvider>
            </RouterProvider>
          </ToastProvider>
        </ApiClientContext>
      </UiConfigContext>
    </QueryClientProvider>
  );
}
