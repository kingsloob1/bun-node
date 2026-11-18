/**
 * The security UI's browser-safe configuration contract (ui.md §1): what
 * `securityUi()` injects into the shell and the app reads at boot.
 * Published as `@kingsleyweb/bun-ui/security/browser`; no runtime import
 * beyond constants.
 */
import type { UiChrome } from "../../kit/browser/mount";
import type { UiLayout, UiTheme } from "../../kit/browser/shared";
import type { UiUnauthorized } from "../../kit/browser/unauthorized";

export type { UiTheme };

/** The id of the `<script type="application/json">` element holding the config. */
export const SECURITY_UI_CONFIG_ELEMENT_ID = "bun-security-ui-config";

/** The configuration the security UI's app is given. */
export interface SecurityUiConfig {
  /** Shape version of this object, bumped on a breaking change. Currently `1`. */
  version: 1;
  /** Page title and brand text. Defaults to `"Security"`. */
  title: string;
  /** Absolute path the UI is mounted at, no trailing slash (`"/security"`). Client routes live under it. */
  basePath: string;
  /** Path the hashed assets are served from, e.g. `"/security/assets"`. */
  assetsPath: string;
  /**
   * Base URL of the management API (`createSecurityApi`) with no trailing
   * slash: a same-origin path (`"/security/api"`) or, with `apiUrl`, an
   * origin-qualified URL.
   */
  apiBase: string;
  /** The header every mutation carries (the API's CSRF header); `/meta` reports it too once signed in. */
  csrfHeader: string;
  /** Whether the API's break-glass account is configured: the sign-in form is offered only then. */
  breakGlass: boolean;
  /** The API's documents, for the API reference. */
  docs: { openapi: string; asyncapi: string };
  /** The live stream's path (`GET <apiBase>/live`). */
  live: { path: string };
  /** Initial colour scheme. */
  theme: UiTheme;
  /** Where the content sits on a wide screen (the `layout` option, checked). */
  layout: UiLayout;
  /** How much of its own frame the UI draws (the `chrome` option, checked; `"full"` when unset). */
  chrome: UiChrome;
  /** Where an authorization failure sends the browser, or `null` when off. */
  unauthorized: UiUnauthorized | null;
}
