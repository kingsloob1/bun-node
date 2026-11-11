/**
 * The browser-safe types of `lib/docs/` (AD (c), plan
 * `docs/plans/api-docs-generation/` risk 10), published as
 * `@kingsleyweb/bun-common/lib/docs/types`.
 *
 * A browser viewer needs the *document* types and nothing else; importing
 * `lib/docs` for a type would pull the generator, `refs` and every converter
 * into the bundle of any bundler that does not erase type-only imports. This
 * entry is type-only and imports nothing, so its graph is exactly this file
 * (`__tests__/docs/browserSafety.test.ts` proves it, with a negative
 * control). `AsyncApiDocument` joined it in phase (e), with its generator.
 */

/** A JSON Schema document (or fragment), as the converters produce it. */
export type JsonSchemaLike = Record<string, unknown>;

/**
 * Any OpenAPI 3.1 document, whatever its `3.1.x` patch version: what the
 * docs entry points take as input (`docsRouter`'s `openapi`, `devTypes()`'s).
 * A patch release of the specification only clarifies it, so a `3.1.0`
 * document from another generator — bun-jobs' `JobsApi.openapi()`, say —
 * is served as it is (#771). Typed loosely, as {@link OpenApiDocument} is.
 */
export interface OpenApi31Document {
  /** The OpenAPI version: any `3.1.x`. */
  openapi: `3.1.${number}`;
  /** Every other top-level field. */
  [key: string]: unknown;
}

/**
 * An OpenAPI 3.1 document, as `generateOpenApi` builds it. Typed loosely on
 * purpose: only the version is pinned, and the document is checked against
 * the OpenAPI 3.1 meta-schema in the tests rather than modelled here. An
 * {@link OpenApi31Document}, so it goes wherever one is taken.
 */
export interface OpenApiDocument extends OpenApi31Document {
  /** The OpenAPI version this generator writes. */
  openapi: "3.1.2";
}

/**
 * An AsyncAPI 3.0 document, as `generateAsyncApi` builds it (AD (e), matching
 * bun-jobs' emit — plan §9.1's 3.1.0 question was decided for 3.0.0,
 * 2026-10-26). Typed loosely on purpose, as {@link OpenApiDocument} is: only
 * the version is pinned, and the document is checked against the official
 * AsyncAPI 3.0.0 schema (`@asyncapi/specs`) in the tests.
 */
export interface AsyncApiDocument {
  /** The AsyncAPI version. */
  asyncapi: "3.0.0";
  /** Every other top-level field. */
  [key: string]: unknown;
}
