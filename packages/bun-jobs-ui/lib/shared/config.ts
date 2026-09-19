/**
 * The contract between `jobsUi()` (server, `lib/`) and the React app (`app/`).
 *
 * The server resolves this once per mount and inlines it into the HTML shell as
 * `<script type="application/json" id="bun-jobs-ui-config" nonce="…">`. The app
 * reads it before its first request. It must stay free of runtime imports: both
 * sides import it, and the app side is bundled for the browser.
 */

/** Id of the `<script type="application/json">` element carrying {@link UiConfig}. */
export const UI_CONFIG_ELEMENT_ID = "bun-jobs-ui-config";

/** Sections of the app a mount can switch off. */
export interface UiSections {
  /** Job/queue/runner management screens. Defaults to `true`. */
  manage: boolean;
  /** The OpenAPI and AsyncAPI documentation viewers. Defaults to `true`. */
  docs: boolean;
}

/** Colour scheme the app starts in. `"system"` follows `prefers-color-scheme`. */
export type UiTheme = "system" | "light" | "dark";

/** Resolved configuration handed to the browser. Never carries secrets. */
export interface UiConfig {
  /** Shape version of this object, bumped on a breaking change. Currently `1`. */
  version: 1;
  /** Page title and brand text. Defaults to `"Jobs"`. */
  title: string;
  /** Absolute path the UI is mounted at, no trailing slash (e.g. `"/jobs"`). Client routes live under it. */
  basePath: string;
  /** Path the hashed assets are served from, e.g. `"/jobs/assets"`. */
  assetsPath: string;
  /**
   * Base URL of the management API with no trailing slash: a same-origin
   * absolute path (`"/jobs-api"`) or, with `apiUrl`, a full origin-qualified URL.
   */
  apiBase: string;
  /**
   * Header every mutation must carry (any non-empty value), or `null` when the
   * API has no CSRF header configured. Mirrors the API's `csrf.header`.
   */
  csrfHeader: string | null;
  /**
   * The API's WebSocket endpoint, when it has one: `path` is the full path
   * (including the API basePath); `port` is set only for a dedicated-port
   * socket. `null` when the API has no socket. `/meta` remains the authority at
   * runtime; this lets the app connect without waiting for it.
   */
  websocket: { path: string; port: number | null } | null;
  /** Full paths of the API's spec documents, or `null` when docs are off. */
  docs: { openapi: string; asyncapi: string | null } | null;
  /** Which sections are enabled. */
  sections: UiSections;
  /** Initial colour scheme. */
  theme: UiTheme;
}
