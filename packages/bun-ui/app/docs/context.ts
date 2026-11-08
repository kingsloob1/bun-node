import type { DocsUiConfig } from "../lib/shared/config.ts";
import type { DocsClient, FetchLike } from "./api/client";
import { createContext, use } from "react";

/** Carries the injected {@link DocsUiConfig}. */
export const DocsUiConfigContext = createContext<DocsUiConfig | null>(null);
/** Carries the try-it panel's client (built on the document's resolved server). */
export const DocsClientContext = createContext<DocsClient | null>(null);
/** Carries the `fetch` every client uses; tests inject one. Defaults to `globalThis.fetch`. */
export const DocsFetchContext = createContext<FetchLike | null>(null);

/** The resolved {@link DocsUiConfig} the server injected. */
export function useDocsUiConfig(): DocsUiConfig {
  const config = use(DocsUiConfigContext);
  if (!config) {
    throw new Error("useDocsUiConfig must be used inside <DocsUiProviders>");
  }
  return config;
}

/** The try-it panel's client. */
export function useDocsClient(): DocsClient {
  const client = use(DocsClientContext);
  if (!client) {
    throw new Error("useDocsClient must be used inside <DocsClientContext>");
  }
  return client;
}

/** The `fetch` the clients use, or `undefined` for `globalThis.fetch`. */
export function useDocsFetch(): FetchLike | undefined {
  return use(DocsFetchContext) ?? undefined;
}
