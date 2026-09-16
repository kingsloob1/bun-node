import type { JobsApiDocsOptions } from "../config";
import { ConfigError } from "../../shared/errors";

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
 */

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

/** An exact semver: three numbers, optionally a pre-release, and nothing else. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

/** An SRI hash of the digest the pages declare. */
const SRI_HASH = /^sha384-[\w+/]+={0,2}$/;

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

/** Checks one override and merges it over the pin. */
function resolveAsset(
  pinned: PinnedAsset,
  override:
    | {
        /** Exact version. */
        version: string;
        /** Its hashes. */
        integrity?: AssetIntegrity;
      }
    | undefined,
  what: string,
): PinnedAsset {
  if (!override) {
    return pinned;
  }
  if (
    typeof override.version !== "string" ||
    !EXACT_SEMVER.test(override.version)
  ) {
    throw new ConfigError(
      `${what}.version must be an exact version such as "5.32.15", not a range`,
      { version: override.version },
    );
  }
  const integrity = override.integrity;
  if (integrity !== undefined) {
    for (const key of ["js", "css"] as const) {
      if (
        typeof integrity[key] !== "string" ||
        !SRI_HASH.test(integrity[key])
      ) {
        throw new ConfigError(
          `${what}.integrity.${key} must be a "sha384-…" hash`,
          {
            value: integrity[key],
          },
        );
      }
    }
  }
  return {
    ...pinned,
    version: override.version,
    // A different version has different bytes, so the pinned hashes cannot
    // apply: the operator supplies their own, or the page loads without SRI.
    ...(integrity ? { integrity } : { integrity: undefined }),
  };
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
  const cdn = docs === false ? undefined : docs?.cdn;
  const baseUrl = (cdn?.baseUrl ?? DEFAULT_CDN_BASE_URL).replace(/\/+$/, "");
  let origin: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("not http(s)");
    }
    origin = url.origin;
  } catch {
    throw new ConfigError("docs.cdn.baseUrl must be an http(s) URL", {
      baseUrl,
    });
  }
  return {
    baseUrl,
    origin,
    swaggerUi: resolveAsset(
      DOCS_CDN.swaggerUi,
      cdn?.swaggerUi,
      "docs.cdn.swaggerUi",
    ),
    asyncapi: resolveAsset(
      DOCS_CDN.asyncapi,
      cdn?.asyncapi,
      "docs.cdn.asyncapi",
    ),
  };
}

/** The URL of one of an asset's files. */
export function assetUrl(
  cdn: ResolvedDocsCdn,
  asset: PinnedAsset,
  file: "js" | "css",
): string {
  return `${cdn.baseUrl}/${asset.package}@${asset.version}/${asset[file]}`;
}
