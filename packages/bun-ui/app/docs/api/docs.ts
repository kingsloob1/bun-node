import type { DocsClient } from "./client";

/**
 * A spec document as JSON. The viewers narrow the parts they render with
 * their own models.
 */
export type SpecDocument = Record<string, unknown>;

/** Query keys of the document read, under `["docs"]`. */
export const docsKeys = {
  /** Every docs read. */
  all: ["docs"] as const,
  /** The one document at a URL. */
  document: (url: string) => ["docs", "document", url] as const,
} satisfies Record<string, unknown>;

/** The document's kind, read from its own marker field. */
export type DocumentKind = "openapi" | "asyncapi";

/** What the document is: OpenAPI 3.1 when it carries `openapi`, AsyncAPI 3.0 for `asyncapi`, `null` when neither. */
export function documentKind(doc: SpecDocument): DocumentKind | null {
  if (typeof doc.asyncapi === "string") {
    return "asyncapi";
  }
  if (typeof doc.openapi === "string") {
    return "openapi";
  }
  return null;
}

/** `GET <documentUrl>`: the one document the viewer shows. */
export function getDocument(
  client: DocsClient,
  url: string,
  signal?: AbortSignal,
): Promise<SpecDocument> {
  return client.request<SpecDocument>("GET", url, { signal });
}
