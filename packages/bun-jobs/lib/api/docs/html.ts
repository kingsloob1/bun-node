import type { ResolvedJobsApiConfig } from "../config";
import type { PinnedAsset, ResolvedDocsCdn } from "./cdn";
import { assetUrl } from "./cdn";

/**
 * The two HTML viewer pages.
 *
 * Each page is generated per request, because each carries a fresh nonce: the
 * Content Security Policy allows exactly one inline script (the initialiser)
 * and the pinned CDN's origin, so neither an injected script tag nor a
 * substituted bundle can run. Everything else is denied — `default-src 'none'`
 * — and the page can only talk to its own origin.
 *
 * The pages are off by default (`docs.ui`), because they put third-party
 * script into an origin holding admin cookies and because "try it out" is a
 * mutation console. The JSON documents need none of this and are always there.
 */

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
 * - `style-src` needs `'unsafe-inline'` because both viewers set inline style
 *   attributes; scripts stay nonce-only, which is where injection matters;
 * - `connect-src 'self'` keeps the documents (and "try it out") on this origin;
 * - the rest is lockdown: no base tag, no form posts, no framing, no plugins.
 */
export function docsPageHeaders(
  cdn: ResolvedDocsCdn,
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
function assetTags(cdn: ResolvedDocsCdn, asset: PinnedAsset) {
  const integrity = asset.integrity;
  return {
    stylesheet: `<link rel="stylesheet" href="${escapeHtml(assetUrl(cdn, asset, "css"))}"${
      integrity ? ` integrity="${escapeHtml(integrity.css)}"` : ""
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

/** What a page needs to know about the API it documents. */
export interface DocsPageContext {
  /** The resolved configuration. */
  config: ResolvedJobsApiConfig;
  /** The assets to load. */
  cdn: ResolvedDocsCdn;
}

/** The API's title, for the pages. */
function title(config: ResolvedJobsApiConfig): string {
  const docs = config.docs === false ? undefined : config.docs;
  return docs?.title ?? `bun-jobs management API (${config.namespace})`;
}

/**
 * The Swagger UI page for the OpenAPI document.
 *
 * Its `requestInterceptor` sends same-origin credentials (the admin session is
 * usually a cookie) and adds the CSRF header when one is configured, so "try
 * it out" can reach mutating routes the CSRF guard would otherwise refuse.
 */
export function swaggerUiPage(context: DocsPageContext): DocsPage {
  const { config, cdn } = context;
  const nonce = makeNonce();
  const tags = assetTags(cdn, cdn.swaggerUi);
  const documentUrl = `${config.basePath}${
    config.docs === false ? "/openapi.json" : config.docs.openapiPath
  }`;
  const csrfHeader = config.csrf === false ? undefined : config.csrf.header;
  const init = `window.ui = SwaggerUIBundle({
  url: ${jsonForScript(documentUrl)},
  dom_id: "#ui",
  deepLinking: true,
  requestInterceptor: function (request) {
    request.credentials = "same-origin";${
      csrfHeader
        ? `
    request.headers[${jsonForScript(csrfHeader)}] = "1";`
        : ""
    }
    return request;
  },
});`;
  return {
    html: page({
      title: `${title(config)} — OpenAPI`,
      stylesheet: tags.stylesheet,
      script: tags.script,
      init,
      nonce,
    }),
    headers: docsPageHeaders(cdn, nonce),
    nonce,
  };
}

/** The AsyncAPI viewer page for the live-events document. */
export function asyncApiUiPage(context: DocsPageContext): DocsPage {
  const { config, cdn } = context;
  const nonce = makeNonce();
  const tags = assetTags(cdn, cdn.asyncapi);
  const documentUrl = `${config.basePath}${
    config.docs === false ? "/asyncapi.json" : config.docs.asyncapiPath
  }`;
  const init = `AsyncApiStandalone.render({
  schema: {
    url: ${jsonForScript(documentUrl)},
    options: { method: "GET", mode: "cors", credentials: "same-origin" },
  },
  config: { show: { sidebar: true, errors: true } },
}, document.getElementById("ui"));`;
  return {
    html: page({
      title: `${title(config)} — AsyncAPI`,
      stylesheet: tags.stylesheet,
      script: tags.script,
      init,
      nonce,
    }),
    headers: docsPageHeaders(cdn, nonce),
    nonce,
  };
}
