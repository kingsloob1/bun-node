/** The security app's config for a test: what `securityUi()` injects by default. */
import type { SecurityUiConfig } from "../../../lib/security/browser/config.ts";

/** The app's config for a test. */
export function securityConfig(
  overrides: Partial<SecurityUiConfig> = {},
): SecurityUiConfig {
  return {
    version: 1,
    title: "Security",
    basePath: "/security",
    assetsPath: "/security/assets",
    apiBase: "/security/api",
    csrfHeader: "x-bun-security-csrf",
    breakGlass: false,
    docs: {
      openapi: "/security/api/openapi.json",
      asyncapi: "/security/api/asyncapi.json",
    },
    live: { path: "/security/api/live" },
    theme: "system",
    layout: { align: "center", scope: "content", maxWidth: 1400 },
    unauthorized: null,
    ...overrides,
  };
}
