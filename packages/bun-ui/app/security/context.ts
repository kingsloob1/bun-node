/** The security app's contexts: its configuration and its API client. */
import type { SecurityUiConfig } from "../../lib/security/browser/config.ts";
import type { SecurityClient } from "./api/client";
import { createContext, use } from "react";

/** The injected configuration. */
export const UiConfigContext = createContext<SecurityUiConfig | null>(null);

/** The API client. */
export const SecurityClientContext = createContext<SecurityClient | null>(null);

/** The injected configuration (inside the providers). */
export function useUiConfig(): SecurityUiConfig {
  const config = use(UiConfigContext);
  if (config === null)
    throw new Error("useUiConfig must be used inside <AppProviders>");
  return config;
}

/** The API client (inside the providers). */
export function useSecurityClient(): SecurityClient {
  const client = use(SecurityClientContext);
  if (client === null)
    throw new Error("useSecurityClient must be used inside <AppProviders>");
  return client;
}
