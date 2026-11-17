/** The security app's query keys. */
import { META_KEY } from "../queryClient";

/** Every key the app uses, by what it reads. */
export const queryKeys = {
  /** `GET /meta`. */
  meta: () => [META_KEY, "meta"] as const,
  /** `GET /meta/permissions?scope=`. */
  permissions: (scope: string) => [META_KEY, "permissions", scope] as const,
  /** `GET /operators/me`. */
  me: () => [META_KEY, "me"] as const,
  /** The scope picker's groups and services. */
  scopes: () => ["scopes"] as const,
  /** The Overview's summary for a scope. */
  overview: (scope: string) => ["overview", scope] as const,
  /** The OpenAPI document. */
  openapi: () => ["docs", "openapi"] as const,
} satisfies Record<string, (...args: never[]) => readonly unknown[]>;
