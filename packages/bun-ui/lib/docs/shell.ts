import type { UiAssets } from "./assets";
/**
 * The HTML shell: the one page every client route answers with, and the
 * Content-Security-Policy it is served under.
 *
 * Everything in it is fixed per mount except the nonce, which is fresh per
 * request. The configuration travels as a nonce'd
 * `<script type="application/json">`, escaped for a script context, so a title
 * containing `</script>` cannot end the element early.
 */
import type { DocsUiConfig, DocsUiTheme } from "./shared/config";
import { Buffer } from "node:buffer";
import { DOCS_UI_CONFIG_ELEMENT_ID } from "./shared/config";

/** A fresh CSP nonce: 128 random bits, base64. */
export function createNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    "base64",
  );
}

/** Escapes text for an HTML text node or a quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Serialises a value as JSON that is safe inside a `<script>` element: `<`,
 * `>` and `&` become `<`/`>`/`&` (so neither `</script>` nor
 * `<!--` can appear), and U+2028/U+2029 are escaped too. The result is still
 * valid JSON that parses back to the same value.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(/\u2028/g, "\\u2028")
    .replaceAll(/\u2029/g, "\\u2029");
}

/** The `color-scheme` meta value for a theme, so the first paint matches it. */
function colorScheme(theme: DocsUiTheme): string {
  return theme === "system" ? "light dark" : theme;
}

/** Inputs to {@link cspHeader}. */
export interface CspOptions {
  /** This request's nonce. */
  nonce: string;
  /**
   * `connect-src` sources after `'self'` — for a cross-origin document URL,
   * its origin (see {@link documentOriginSource}). A source that is not a
   * single CSP token (whitespace, `;` or `,`) is dropped rather than written
   * into the header. Defaults to none.
   */
  connectSrc?: readonly string[];
}

/** One CSP source expression: no whitespace, `;` or `,` that could end it early. */
const CSP_TOKEN = /^[^\s;,]+$/;

/**
 * The shell's Content-Security-Policy. Scripts only from this origin and
 * carrying the nonce; styles only from files (no inline `<style>`, no `style`
 * attributes in markup — setting `element.style` from script is still fine);
 * connections to `'self'` plus `connectSrc`.
 */
export function cspHeader(options: CspOptions): string {
  const connect = [
    "'self'",
    ...(options.connectSrc ?? []).filter((source) => CSP_TOKEN.test(source)),
  ];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${options.nonce}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * The origin a cross-origin document URL adds to `connect-src`, or
 * `undefined` for a same-origin one (`/jobs-api/openapi.json`). The viewer
 * fetches the document from the page; a thunk is served same-origin by the
 * router itself. Anything malformed is dropped rather than written into the
 * header.
 */
export function documentOriginSource(documentUrl: string): string | undefined {
  if (!/^https?:\/\//i.test(documentUrl)) {
    return undefined;
  }
  try {
    return new URL(documentUrl).origin;
  } catch {
    return undefined;
  }
}

/** A renderer for one mount: fixed parts computed once, the nonce per call. */
export type ShellRenderer = (nonce: string) => string;

/**
 * Prepares the shell for a mount and a bundle. The returned function only
 * splices a nonce in.
 */
export function createShellRenderer(
  config: DocsUiConfig,
  assets: UiAssets,
): ShellRenderer {
  const href = (name: string): string =>
    escapeHtml(`${config.assetsPath}/${encodeURIComponent(name)}`);
  const integrity = (name: string): string =>
    escapeHtml(assets.files.get(name)?.integrity ?? "");
  const stylesheets = assets.entry.css
    .map(
      (name) =>
        `<link rel="stylesheet" href="${href(name)}" integrity="${integrity(name)}">`,
    )
    .join("\n    ");
  const title = escapeHtml(config.title);
  const json = jsonForScript(config);
  const js = assets.entry.js;
  const scheme = colorScheme(config.theme);

  return (nonce) => {
    const n = escapeHtml(nonce);
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="${scheme}">
    <meta property="csp-nonce" nonce="${n}">
    <title>${title}</title>
    <link rel="icon" href="data:,">
    ${stylesheets}
    <script type="application/json" id="${DOCS_UI_CONFIG_ELEMENT_ID}" nonce="${n}">${json}</script>
    <script type="module" src="${href(js)}" integrity="${integrity(js)}" nonce="${n}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
  };
}
