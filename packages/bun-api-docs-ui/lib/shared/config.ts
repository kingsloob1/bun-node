/**
 * The contract between `docsUi()` (server, `lib/`) and the React viewer
 * (`app/`).
 *
 * The server resolves this once per mount and inlines it into the HTML shell
 * as `<script type="application/json" id="bun-api-docs-ui-config" nonce="…">`.
 * The viewer reads it before its first request. It must stay free of runtime
 * imports: both sides import it, and the app side is bundled for the browser.
 */

/** Id of the `<script type="application/json">` element carrying {@link DocsUiConfig}. */
export const DOCS_UI_CONFIG_ELEMENT_ID = "bun-api-docs-ui-config";

/**
 * The specification-extension prefixes the viewers read, in priority order:
 * an extension named on an operation, channel or scheme as
 * `<prefix>-<name>` is read from the first prefix that carries it (so
 * `x-bun-common-schema` wins over `x-bun-jobs-schema` when a document has
 * both). An extension under any other prefix is ignored.
 */
export const DEFAULT_EXTENSION_PREFIXES = ["x-bun-common", "x-bun-jobs"];

/** Colour scheme the viewer starts in. `"system"` follows `prefers-color-scheme`. */
export type DocsUiTheme = "system" | "light" | "dark";

/** Resolved configuration handed to the browser. Never carries secrets. */
export interface DocsUiConfig {
  /** Shape version of this object, bumped on a breaking change. Currently `1`. */
  version: 1;
  /** Page title. Defaults to `"API docs"`. */
  title: string;
  /** Absolute path the viewer is mounted at, no trailing slash (e.g. `"/docs"`). Client routes live under it. */
  basePath: string;
  /** Path the hashed assets are served from, e.g. `"/docs/assets"`. */
  assetsPath: string;
  /**
   * Where the viewer fetches the one document it shows: `<basePath>/document.json`
   * when `docsUi()` was given a thunk (the router serves it there), else the
   * URL exactly as configured (a same-origin path or an `http(s)` URL).
   */
  documentUrl: string;
  /**
   * Header the try-it panel adds on every mutation (any non-empty value), or
   * `null` when none is configured. Mirrors the documented API's CSRF rule.
   */
  csrfHeader: string | null;
  /** The extension prefixes in effect (see {@link DEFAULT_EXTENSION_PREFIXES}). */
  extensions: readonly string[];
  /** Initial colour scheme. */
  theme: DocsUiTheme;
}
