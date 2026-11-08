/**
 * What every UI of the package shares and a browser may import: no runtime
 * import, no domain package. The root entry (`@kingsleyweb/bun-ui`) and each
 * UI's `/<ui>/browser` entry re-export from here.
 */

/** Colour scheme a UI starts in. `"system"` follows `prefers-color-scheme`. */
export type UiTheme = "system" | "light" | "dark";

/** `Cache-Control` for hashed bundle files: their name changes with their content. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
