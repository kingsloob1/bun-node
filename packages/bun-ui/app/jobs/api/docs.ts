import type { ApiClient } from "./client";

/**
 * A spec document as JSON. The package's `OpenApiDocument`/`AsyncApiDocument`
 * types live in its root entry, which the browser project does not compile;
 * each viewer narrows the parts it renders with its own types.
 */
export type SpecDocument = Record<string, unknown>;

/**
 * The API's own spec documents, as the docs screens read them.
 *
 * `/meta.docs` (and `UiConfig.docs`) give FULL paths, which include the API's
 * `basePath`, while the client prefixes every request with `apiBase`. So the
 * path is made relative to `apiBase`'s path before it is requested: this keeps
 * the CSRF, credentials and error handling of every other API read.
 */

/** The path of a full docs path relative to `apiBase` (`"/jobs-api/openapi.json"` → `"/openapi.json"`). */
export function docsPath(apiBase: string, fullPath: string): string {
  const basePath = /^https?:\/\//.test(apiBase)
    ? new URL(apiBase).pathname
    : apiBase;
  const base = basePath.replace(/\/+$/, "");
  return base !== "" && fullPath.startsWith(`${base}/`)
    ? fullPath.slice(base.length)
    : fullPath;
}

/** Query keys of the spec documents, under `["docs"]`. */
export const docsKeys = {
  /** Every docs read. */
  all: ["docs"] as const,
  /** The OpenAPI 3.1 document at a path. */
  openapi: (path: string) => ["docs", "openapi", path] as const,
  /** The AsyncAPI 3.0 document at a path. */
  asyncapi: (path: string) => ["docs", "asyncapi", path] as const,
} satisfies Record<string, unknown>;

/** `GET <docs.openapi>`: the API's OpenAPI 3.1 document. */
export function getOpenApiDocument(
  api: ApiClient,
  fullPath: string,
  signal?: AbortSignal,
): Promise<SpecDocument> {
  return api.request<SpecDocument>("GET", docsPath(api.base, fullPath), {
    signal,
  });
}

/** `GET <docs.asyncapi>`: the API's AsyncAPI 3.0 document. */
export function getAsyncApiDocument(
  api: ApiClient,
  fullPath: string,
  signal?: AbortSignal,
): Promise<SpecDocument> {
  return api.request<SpecDocument>("GET", docsPath(api.base, fullPath), {
    signal,
  });
}
