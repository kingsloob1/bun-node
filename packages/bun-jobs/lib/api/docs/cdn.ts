/**
 * The docs pages' third-party assets, pinned.
 *
 * The pages load two viewers from a CDN, which puts third-party script into an
 * origin that holds admin cookies. Three things bound that risk, and all of
 * them depend on the version being **exact**:
 *
 * - an exact version, never a range, so the bytes cannot change under the pin;
 * - a Subresource Integrity hash per asset, so a changed byte fails to load;
 * - a Content Security Policy naming this CDN's origin and nothing else.
 *
 * A mirror (or an air-gapped copy) is configured through `docs.cdn.baseUrl`,
 * with its own hashes if the mirror re-encodes anything.
 *
 * The resolution machinery moved to bun-common in AD (c) (plan
 * `docs/plans/api-docs-generation/` §6.1): `resolveDocsCdn` and `assetUrl`
 * here are shims over `@kingsleyweb/bun-common/lib/docs/viewer`, translating
 * its `ConfigError` back into bun-jobs' own (a `JobsError`), like the
 * `spec/security.ts` shim. The **pins stay here** — bun-common ships its own
 * `DOCS_CDN` copy and each package's pins are netted by its own network hash
 * test (the maintainer's decision, 2026-10-25).
 */
import { ConfigError as BunCommonConfigError } from "@kingsleyweb/bun-common";
import { resolveDocsCdn as resolveDocsCdnBase } from "@kingsleyweb/bun-common/lib/docs/viewer";
import type { JobsApiDocsOptions } from "../config";
import { ConfigError } from "../../shared/errors";

export { assetUrl } from "@kingsleyweb/bun-common/lib/docs/viewer";

/** The default CDN: jsDelivr's npm mirror. */
export const DEFAULT_CDN_BASE_URL = "https://cdn.jsdelivr.net/npm";

/** SRI hashes of one viewer's two assets. */
export interface AssetIntegrity {
  /** `sha384-…` of the script. */
  js: string;
  /** `sha384-…` of the stylesheet. */
  css: string;
}

/** One pinned viewer. */
export interface PinnedAsset {
  /** The npm package. */
  package: string;
  /** The exact version. */
  version: string;
  /** Path of the script within the package. */
  js: string;
  /** Path of the stylesheet within the package. */
  css: string;
  /** SRI hashes, or `undefined` when the operator supplied a mirror without any. */
  integrity?: AssetIntegrity;
}

/**
 * The pinned assets.
 *
 * Chosen on 2026-09-16 from the registry's `latest`, with the hashes computed
 * from the exact URLs below (`sha384`, base64).
 *
 * `@asyncapi/react-component` 3.1.8 depends on `@asyncapi/parser@^3.6.2`, and
 * the parser's 3.x line is the one that understands AsyncAPI 3.0.0 — which is
 * what this API's document is. `__tests__/api/api-docs.test.ts` parses a
 * generated document with that parser version to prove it.
 */
export const DOCS_CDN = Object.freeze({
  /** Swagger UI, for the OpenAPI document. */
  swaggerUi: Object.freeze({
    package: "swagger-ui-dist",
    version: "5.32.15",
    js: "swagger-ui-bundle.js",
    css: "swagger-ui.css",
    integrity: Object.freeze({
      js: "sha384-m7zaGj7MPzU+G4lz2eyy73GxK9bbRDr9bB2CSdj8wodg2wu/Wnt6wsoLP3JD+RS9",
      css: "sha384-fgyWYkUAamzuI8mJFu/xpRP0JWCJRwkwUwsYDoOYVHUJ8NQE5cENn8ib3ppwFFSX",
    }),
  }),
  /** The AsyncAPI React component's standalone bundle, for the AsyncAPI document. */
  asyncapi: Object.freeze({
    package: "@asyncapi/react-component",
    version: "3.1.8",
    js: "browser/standalone/index.js",
    css: "styles/default.min.css",
    integrity: Object.freeze({
      js: "sha384-ozF+W9aPv+TGSkksVltqDBDAbx59o3gRmyUis3vHBxidPINvn2FuKPl12gMa80/h",
      css: "sha384-oo9RoQcacP++XdMX6CjTucTvASEORHX3chFik0/V2kHcsHiVboGyWZztGeq/0bum",
    }),
  }),
}) satisfies Record<string, PinnedAsset>;

/**
 * The `@asyncapi/parser` range the pinned component depends on. Recorded so a
 * test can check the document against the very parser the bundle carries, and
 * so a version bump that changes the parser line is visible in review.
 */
export const ASYNCAPI_PARSER_RANGE = "^3.6.2";

/** The CDN assets in use, after `docs.cdn` overrides. */
export interface ResolvedDocsCdn {
  /** Base URL, without a trailing slash. */
  baseUrl: string;
  /** The origin the CSP allows: the base URL's. */
  origin: string;
  /** Swagger UI. */
  swaggerUi: PinnedAsset;
  /** The AsyncAPI viewer. */
  asyncapi: PinnedAsset;
}

/**
 * The assets the pages will load: the pins, with `docs.cdn` merged over them.
 *
 * Throws `ConfigError` for a base URL that is not `http(s)`, a version that is
 * not exact, or a hash that is not `sha384-…`.
 */
export function resolveDocsCdn(
  docs: Pick<JobsApiDocsOptions, "cdn"> | false | undefined,
): ResolvedDocsCdn {
  try {
    return resolveDocsCdnBase(DOCS_CDN, docs === false ? undefined : docs?.cdn);
  } catch (error) {
    if (error instanceof BunCommonConfigError) {
      throw new ConfigError(error.message, error.details);
    }
    throw error;
  }
}
