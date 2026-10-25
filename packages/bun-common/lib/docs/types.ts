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
 * control). `AsyncApiDocument` joins it in phase (e), with its generator.
 */

/** A JSON Schema document (or fragment), as the converters produce it. */
export type JsonSchemaLike = Record<string, unknown>;

/**
 * An OpenAPI 3.1 document, as `generateOpenApi` builds it. Typed loosely on
 * purpose: only the version is pinned, and the document is checked against
 * the OpenAPI 3.1 meta-schema in the tests rather than modelled here.
 */
export interface OpenApiDocument {
  /** The OpenAPI version. */
  openapi: "3.1.2";
  /** Every other top-level field. */
  [key: string]: unknown;
}
