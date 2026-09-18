import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { UiConfig } from "../shared/config.ts";
import type { ApiClient } from "./api/client";
import { QueryClientProvider } from "@tanstack/react-query";
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
 * router, and the `/meta` bootstrap (which renders the loading and error
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
          <RouterProvider basePath={config.basePath}>
            <MetaProvider>{children}</MetaProvider>
          </RouterProvider>
        </ApiClientContext>
      </UiConfigContext>
    </QueryClientProvider>
  );
}
