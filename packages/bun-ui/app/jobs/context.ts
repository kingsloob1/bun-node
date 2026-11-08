import type { JobsUiConfig } from "../../lib/jobs/browser/config.ts";
import type { ApiClient } from "./api/client";
import { createContext, use } from "react";

/** Carries the injected {@link JobsUiConfig}. */
export const UiConfigContext = createContext<JobsUiConfig | null>(null);
/** Carries the {@link ApiClient}. */
export const ApiClientContext = createContext<ApiClient | null>(null);

/** The resolved {@link JobsUiConfig} the server injected. */
export function useUiConfig(): JobsUiConfig {
  const config = use(UiConfigContext);
  if (!config) {
    throw new Error("useUiConfig must be used inside <AppProviders>");
  }
  return config;
}

/** The API client. */
export function useApiClient(): ApiClient {
  const client = use(ApiClientContext);
  if (!client) {
    throw new Error("useApiClient must be used inside <AppProviders>");
  }
  return client;
}
