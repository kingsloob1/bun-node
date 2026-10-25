/**
 * The docs viewer: the pinned CDN assets and the HTML pages that load them
 * (AD (c), plan `docs/plans/api-docs-generation/` §7), moved from bun-jobs'
 * `lib/api/docs/{cdn,html}.ts` and parameterised — the pins are injected into
 * {@link resolveDocsCdn}, the pages take their `title` and `documentUrl`, and
 * bun-jobs' CSRF header line is generalised to `requestHeaders`.
 * {@link docsRouter} (`./router`) serves them; bun-jobs keeps its own pins
 * (swagger-ui-dist 5.32.15, @asyncapi/react-component 3.1.8) and re-wraps
 * these pages.
 *
 * The pages load a viewer from a CDN, which puts third-party script into an
 * origin that may hold session cookies. Three things bound that risk, and all
 * of them depend on the version being **exact**:
 *
 * - an exact version, never a range, so the bytes cannot change under the pin;
 * - a Subresource Integrity hash per asset, so a changed byte fails to load;
 * - a Content Security Policy naming this CDN's origin and nothing else.
 *
 * A mirror (or an air-gapped copy) is configured through `cdn.baseUrl`, with
 * its own hashes if the mirror re-encodes anything. The pages are off by
 * default (`docsRouter`'s `viewer`), because they put third-party script into
 * an origin holding cookies and because "try it out" is a mutation console.
 * The JSON documents need none of this.
 */
import { ConfigError } from "../errors";

/** The default CDN: jsDelivr's npm mirror. */
const DEFAULT_CDN_BASE_URL = "https://cdn.jsdelivr.net/npm";

/** SRI hashes of one viewer's assets. */
export interface AssetIntegrity {
  /** `sha384-…` of the script. */
  js: string;
  /** `sha384-…` of the stylesheet, when the asset has one. */
  css?: string;
}

/** One pinned viewer. */
export interface PinnedAsset {
  /** The npm package. */
  package: string;
  /** The exact version. */
  version: string;
  /** Path of the script within the package. */
  js: string;
  /**
   * Path of the stylesheet within the package, when the viewer ships one
   * (Swagger UI and the AsyncAPI component do; Scalar, Redoc and RapiDoc
   * bundle their styles).
   */
  css?: string;
  /** SRI hashes, or `undefined` when the operator supplied a mirror without any. */
  integrity?: AssetIntegrity;
}

/**
 * The pinned assets, one per viewer {@link docsRouter} can serve.
 *
 * Chosen on 2026-10-25 (the maintainer's pins), with the hashes computed from
 * the exact URLs below (`sha384`, base64, over what jsDelivr serves).
 *
 * `@asyncapi/react-component` 3.2.2 depends on `@asyncapi/parser@^3.6.2`, and
 * the parser's 3.x line is the one that understands AsyncAPI 3.0.0.
 * `__tests__/docs/viewer.test.ts` parses a served document with that parser
 * version to prove it. bun-jobs keeps its own copy of its own pins, netted by
 * its own network hash test — the duplication is deliberate (the maintainer's
 * decision, 2026-10-25).
 */
export const DOCS_CDN = Object.freeze({
  /** Scalar, the default OpenAPI viewer (`Scalar.createApiReference`). */
  scalar: Object.freeze({
    package: "@scalar/api-reference",
    version: "1.76.0",
    js: "dist/browser/standalone.js",
    integrity: Object.freeze({
      js: "sha384-oH1C0RwqcwbVXkC+r8A+4qRoyEUQdtxAzOwumkxZtQBBcsy61FOoPt7B50OVJYYQ",
    }),
  }),
  /** Swagger UI, for the OpenAPI document. */
  swaggerUi: Object.freeze({
    package: "swagger-ui-dist",
    version: "5.34.0",
    js: "swagger-ui-bundle.js",
    css: "swagger-ui.css",
    integrity: Object.freeze({
      js: "sha384-9Td7MKiIr2S83E1kZyyVi8KdJw/S8CpAvu0llLyMeg0xq/hDGiZJfVn0fV4llCmK",
      css: "sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF",
    }),
  }),
  /** Redoc, for the OpenAPI document (ESM-only since 3.0 — imported as a module). */
  redoc: Object.freeze({
    package: "redoc",
    version: "3.0.1",
    js: "bundles/redoc.standalone.js",
    integrity: Object.freeze({
      js: "sha384-j07qRKHNNmcwU1/Y1elJc7pDLHXP/QfbQXTtSkbOJ7uYGJikqAzsFVbY2zR9FqOT",
    }),
  }),
  /** RapiDoc, for the OpenAPI document (the `<rapi-doc>` custom element). */
  rapidoc: Object.freeze({
    package: "rapidoc",
    version: "11.0.1",
    js: "dist/rapidoc-min.js",
    integrity: Object.freeze({
      js: "sha384-fCYjbigC95GwGadnXpdvX5fXvlWRGMWJMOw89RxKHaGluDjZwf0Lu1KfUrE5KyfN",
    }),
  }),
  /** The AsyncAPI React component's standalone bundle, for the AsyncAPI document. */
  asyncapi: Object.freeze({
    package: "@asyncapi/react-component",
    version: "3.2.2",
    js: "browser/standalone/index.js",
    css: "styles/default.min.css",
    integrity: Object.freeze({
      js: "sha384-/OTzBCE2fCs+wXFZecqj96eHeOnof8fcoSA2OVEHTmV/BeGnpOpolyhDGduFU9xE",
      css: "sha384-oo9RoQcacP++XdMX6CjTucTvASEORHX3chFik0/V2kHcsHiVboGyWZztGeq/0bum",
    }),
  }),
}) satisfies Record<string, PinnedAsset>;

/** One asset's override: an exact version and its hashes. */
export interface DocsCdnAssetOverride {
  /** Exact semver. */
  version: string;
  /** `sha384-` hashes of the bundle and (when the asset has one) stylesheet. */
  integrity?: AssetIntegrity;
}

/**
 * CDN overrides ({@link DocsRouterOptions.cdn}): a mirror's base URL and, per
 * asset, an exact version with its own hashes.
 */
export interface DocsCdnOptions {
  /** Defaults to jsDelivr's npm mirror (`https://cdn.jsdelivr.net/npm`). */
  baseUrl?: string;
  /** Exact `@scalar/api-reference` version and its SRI hash. */
  scalar?: DocsCdnAssetOverride;
  /** Exact `swagger-ui-dist` version and SRI hashes for its bundle and CSS. */
  swaggerUi?: DocsCdnAssetOverride;
  /** Exact `redoc` version and its SRI hash. */
  redoc?: DocsCdnAssetOverride;
  /** Exact `rapidoc` version and its SRI hash. */
  rapidoc?: DocsCdnAssetOverride;
  /** Exact `@asyncapi/react-component` version and SRI hashes. */
  asyncapi?: DocsCdnAssetOverride;
}

/** An exact semver: three numbers, optionally a pre-release, and nothing else. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

/** An SRI hash of the digest the pages declare. */
const SRI_HASH = /^sha384-[\w+/]+={0,2}$/;

/**
 * One pin, resolved: the pin's own shape, with what an override may replace —
 * the version and the hashes — typed honestly (`integrity` disappears when a
 * mirror supplies a version without hashes).
 */
type ResolvedAsset<Asset extends PinnedAsset> = Omit<
  Asset,
  "version" | "integrity"
> & {
  /** The resolved exact version (an override's, when given). */
  version: string;
  /** The resolved hashes, or `undefined` for a mirror without any. */
  integrity?: Asset["integrity"];
};

/** The CDN assets in use, after the overrides — the pins' keys, resolved. */
export type ResolvedDocsCdn<
  Pins extends Readonly<Record<string, PinnedAsset>> = typeof DOCS_CDN,
> = Readonly<
  {
    /** Base URL, without a trailing slash. */
    baseUrl: string;
    /** The origin the CSP allows: the base URL's. */
    origin: string;
  } & { [Name in keyof Pins]: ResolvedAsset<Pins[Name]> }
>;

/** Checks one override and merges it over the pin. */
function resolveAsset(
  pinned: PinnedAsset,
  override: DocsCdnAssetOverride | undefined,
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
        integrity[key] !== undefined &&
        (typeof integrity[key] !== "string" || !SRI_HASH.test(integrity[key]))
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
 * The assets the pages will load: `pins`, with `overrides` merged over them.
 * The pins are a parameter — bun-common's own are {@link DOCS_CDN}, and
 * bun-jobs passes its own copy.
 *
 * Throws `ConfigError` for a base URL that is not `http(s)`, a version that is
 * not exact, or a hash that is not `sha384-…`.
 */
export function resolveDocsCdn<
  Pins extends Readonly<Record<string, PinnedAsset>>,
>(pins: Pins, overrides?: DocsCdnOptions): ResolvedDocsCdn<Pins> {
  const cdn = overrides;
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
  const assets: Record<string, PinnedAsset> = {};
  for (const [name, pinned] of Object.entries(pins)) {
    assets[name] = resolveAsset(
      pinned,
      (cdn as Record<string, DocsCdnAssetOverride | undefined> | undefined)?.[
        name
      ],
      `docs.cdn.${name}`,
    );
  }
  // Each resolved asset keeps its pin's own shape (a pin with a stylesheet
  // resolves with one); the spread is exactly the pins' keys.
  return { baseUrl, origin, ...assets } as ResolvedDocsCdn<Pins>;
}

/** The URL of one of an asset's files. */
export function assetUrl(
  cdn: Readonly<{ baseUrl: string }>,
  asset: PinnedAsset,
  file: "js" | "css",
): string {
  return `${cdn.baseUrl}/${asset.package}@${asset.version}/${asset[file]}`;
}

/* ------------------------------------------------------------------ *
 * The pages (swaggerUiPage/asyncApiUiPage moved from bun-jobs'
 * `lib/api/docs/html.ts`; scalarPage/redocPage/rapidocPage are new, on the
 * same skeleton).
 *
 * Each page is generated per request, because each carries a fresh nonce: the
 * Content Security Policy allows exactly the nonce'd inline scripts (the
 * initialiser, and Redoc's import map) and the pinned CDN's origin, so
 * neither an injected script tag nor a substituted bundle can run. Everything
 * else is denied — `default-src 'none'` — and the page can only talk to its
 * own origin.
 * ------------------------------------------------------------------ */

/** A page, with the headers it must be served with. */
export interface DocsPage {
  /** The HTML. */
  html: string;
  /** Response headers, including the CSP with this page's nonce. */
  headers: Record<string, string>;
  /** The nonce the inline script carries. */
  nonce: string;
}

/** A fresh nonce: 16 random bytes, base64. */
function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The page's headers. The CSP names the CDN's origin for what the viewers
 * load, and nothing else:
 *
 * - `script-src` is the nonce plus the CDN, so only our initialiser and the
 *   pinned bundles run;
 * - `style-src` needs `'unsafe-inline'` because the viewers set inline styles
 *   (Scalar and Redoc inject `<style>` elements); scripts stay nonce-only,
 *   which is where injection matters;
 * - `connect-src 'self'` keeps the documents (and "try it out") on this origin;
 * - the rest is lockdown: no base tag, no form posts, no framing, no plugins.
 */
export function docsPageHeaders(
  cdn: Readonly<{ origin: string }>,
  nonce: string,
): Record<string, string> {
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${cdn.origin}`,
    `style-src ${cdn.origin} 'unsafe-inline'`,
    `img-src 'self' data: ${cdn.origin}`,
    `font-src ${cdn.origin}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

/** Escapes text for an HTML text node or attribute value. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Embeds a value in an inline script. `JSON.stringify` is not enough on its
 * own: a `</script` inside a string would end the element, so the slash is
 * escaped (which JSON readers and JavaScript both accept).
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("/", "\\/");
}

/** The `<link>` and `<script>` tags for one pinned asset. */
function assetTags(
  cdn: Readonly<{ baseUrl: string }>,
  asset: PinnedAsset,
): { stylesheet: string; script: string } {
  const integrity = asset.integrity;
  return {
    stylesheet:
      asset.css === undefined
        ? ""
        : `<link rel="stylesheet" href="${escapeHtml(assetUrl(cdn, asset, "css"))}"${
            integrity?.css ? ` integrity="${escapeHtml(integrity.css)}"` : ""
          } crossorigin="anonymous">`,
    script: `<script src="${escapeHtml(assetUrl(cdn, asset, "js"))}"${
      integrity ? ` integrity="${escapeHtml(integrity.js)}"` : ""
    } crossorigin="anonymous"></script>`,
  };
}

/** Wraps a page body in the shared skeleton. */
function page(options: {
  /** The document title. */
  title: string;
  /** Stylesheet tag. */
  stylesheet: string;
  /** Viewer bundle tag. */
  script: string;
  /** Extra `<head>` markup (Redoc's import map), nonce'd by the caller. */
  head?: string;
  /** The nonce'd initialiser's body. */
  init: string;
  /** This page's nonce. */
  nonce: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(options.title)}</title>
${options.stylesheet}
${options.head ?? ""}
<style nonce="${options.nonce}">body { margin: 0; }</style>
</head>
<body>
<div id="ui"></div>
${options.script}
<script nonce="${options.nonce}">
${options.init}
</script>
</body>
</html>
`;
}

/** The slice of a resolved CDN one viewer page needs. */
type ViewerCdn<Asset extends string> = Readonly<
  { baseUrl: string; origin: string } & { [Name in Asset]: PinnedAsset }
>;

/** What a page needs to know about the API it documents. */
interface DocsViewerContext<Asset extends string> {
  /** The assets to load (this page's own under `Asset`). */
  cdn: ViewerCdn<Asset>;
  /** The page's title (`<title>` gains `" — <documentKind>"`). */
  title: string;
  /** Where the page's document is served (`req.baseUrl` + its path). */
  documentUrl: string;
  /** The document's kind, for the title. Default: `"OpenAPI"`. */
  documentKind?: "OpenAPI" | "AsyncAPI";
  /**
   * The viewer's own configuration, passed through: spread into the
   * initialiser config (swagger-ui, Scalar, Redoc — Redoc's second argument),
   * assigned as element properties (RapiDoc), spread into `config` (the
   * AsyncAPI component). Default: `{}`.
   */
  options?: Record<string, unknown>;
  /**
   * Headers the viewer's own requests set, e.g. a CSRF header so "try it out"
   * reaches mutating routes. Only Swagger UI honours them (its
   * `requestInterceptor`); Scalar, Redoc, RapiDoc and the AsyncAPI component
   * have no request hook. Default: none.
   */
  requestHeaders?: Record<string, string>;
}

/** The pass-through options as `"key": value,` lines (swagger-ui, Scalar). */
function passThroughLines(options: Record<string, unknown>): string {
  return Object.entries(options)
    .map(
      ([key, value]) => `  ${JSON.stringify(key)}: ${jsonForScript(value)},\n`,
    )
    .join("");
}

/**
 * The Scalar page for a document — the default OpenAPI viewer.
 * `Scalar.createApiReference` takes the pass-through options in its
 * configuration (`theme`, `layout`, …). Its AsyncAPI rendering is upstream
 * work-in-progress; {@link docsRouter} offers it for the AsyncAPI document as
 * an opt-in.
 */
export function scalarPage(context: DocsViewerContext<"scalar">): DocsPage {
  const {
    cdn,
    title,
    documentUrl,
    documentKind = "OpenAPI",
    options,
  } = context;
  const nonce = makeNonce();
  const tags = assetTags(cdn, cdn.scalar);
  const init = `Scalar.createApiReference("#ui", {
  url: ${jsonForScript(documentUrl)},
${passThroughLines(options ?? {})}});`;
  return {
    html: page({
      title: `${title} — ${documentKind}`,
      stylesheet: tags.stylesheet,
      script: tags.script,
      init,
      nonce,
    }),
    headers: docsPageHeaders(cdn, nonce),
    nonce,
  };
}

/**
 * The Swagger UI page for the OpenAPI document.
 *
 * Its `requestInterceptor` sends same-origin credentials (the session is
 * usually a cookie) and adds each of `requestHeaders` (a CSRF header, say)
 * when one is configured, so "try it out" can reach mutating routes a guard
 * would otherwise refuse.
 */
export function swaggerUiPage(
  context: DocsViewerContext<"swaggerUi">,
): DocsPage {
  const { cdn, title, documentUrl, options, requestHeaders } = context;
  const nonce = makeNonce();
  const tags = assetTags(cdn, cdn.swaggerUi);
  const init = `window.ui = SwaggerUIBundle({
  url: ${jsonForScript(documentUrl)},
  dom_id: "#ui",
  deepLinking: true,
${passThroughLines(options ?? {})}  requestInterceptor: function (request) {
    request.credentials = "same-origin";${Object.entries(requestHeaders ?? {})
      .map(
        ([name, value]) =>
          `
    request.headers[${jsonForScript(name)}] = ${jsonForScript(value)};`,
      )
      .join("")}
    return request;
  },
});`;
  return {
    html: page({
      title: `${title} — OpenAPI`,
      stylesheet: tags.stylesheet,
      script: tags.script,
      init,
      nonce,
    }),
    headers: docsPageHeaders(cdn, nonce),
    nonce,
  };
}

/**
 * The Redoc page for the OpenAPI document.
 *
 * Redoc 3.x is ESM-only, so the bundle is imported, not scripted: an import
 * map pins its URL **and its hash** (`integrity`, enforced where import-map
 * integrity is supported), and the nonce'd module initialiser calls
 * `init(url, options, element)` — the pass-through options are that second
 * argument.
 */
export function redocPage(context: DocsViewerContext<"redoc">): DocsPage {
  const { cdn, title, documentUrl, options } = context;
  const nonce = makeNonce();
  const url = assetUrl(cdn, cdn.redoc, "js");
  const importMap = `<script type="importmap" nonce="${nonce}">
${JSON.stringify({
  imports: { redoc: url },
  ...(cdn.redoc.integrity
    ? { integrity: { [url]: cdn.redoc.integrity.js } }
    : {}),
})}
</script>`;
  const init = `import { init as redocInit } from "redoc";
redocInit(
  ${jsonForScript(documentUrl)},
  ${jsonForScript(options ?? {})},
  document.getElementById("ui"),
);`;
  return {
    html: page({
      title: `${title} — OpenAPI`,
      stylesheet: "",
      script: "",
      head: importMap,
      init,
      nonce,
    }),
    headers: docsPageHeaders(cdn, nonce),
    nonce,
  };
}

/**
 * The RapiDoc page for the OpenAPI document: the bundle defines the
 * `<rapi-doc>` custom element, and the initialiser creates it with the
 * pass-through options assigned as element properties (RapiDoc reads its
 * configuration as properties/attributes).
 */
export function rapidocPage(context: DocsViewerContext<"rapidoc">): DocsPage {
  const { cdn, title, documentUrl, options } = context;
  const nonce = makeNonce();
  const tags = assetTags(cdn, cdn.rapidoc);
  const init = `const element = document.createElement("rapi-doc");
element.setAttribute("spec-url", ${jsonForScript(documentUrl)});
element.style.height = "100vh";
${Object.entries(options ?? {})
  .map(
    ([key, value]) =>
      `element[${jsonForScript(key)}] = ${jsonForScript(value)};`,
  )
  .join("\n")}
document.getElementById("ui").replaceWith(element);`;
  return {
    html: page({
      title: `${title} — OpenAPI`,
      stylesheet: tags.stylesheet,
      script: tags.script,
      init,
      nonce,
    }),
    headers: docsPageHeaders(cdn, nonce),
    nonce,
  };
}

/** The AsyncAPI viewer page for the AsyncAPI document. */
export function asyncApiUiPage(
  context: DocsViewerContext<"asyncapi">,
): DocsPage {
  const { cdn, title, documentUrl, options } = context;
  const nonce = makeNonce();
  const tags = assetTags(cdn, cdn.asyncapi);
  const passThrough = Object.entries(options ?? {})
    .map(([key, value]) => `, ${JSON.stringify(key)}: ${jsonForScript(value)}`)
    .join("");
  const init = `AsyncApiStandalone.render({
  schema: {
    url: ${jsonForScript(documentUrl)},
    options: { method: "GET", mode: "cors", credentials: "same-origin" },
  },
  config: { show: { sidebar: true, errors: true }${passThrough} },
}, document.getElementById("ui"));`;
  return {
    html: page({
      title: `${title} — AsyncAPI`,
      stylesheet: tags.stylesheet,
      script: tags.script,
      init,
      nonce,
    }),
    headers: docsPageHeaders(cdn, nonce),
    nonce,
  };
}
