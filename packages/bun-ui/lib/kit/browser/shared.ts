/**
 * What every UI of the package shares and a browser may import: no runtime
 * import, no domain package. The root entry (`@kingsleyweb/bun-ui`) and each
 * UI's `/<ui>/browser` entry re-export from here.
 */

/** Colour scheme a UI starts in. `"system"` follows `prefers-color-scheme`. */
export type UiTheme = "system" | "light" | "dark";

/**
 * A colour every UI draws with, by name: the CSS custom properties of the
 * kit's `tokens.css`, camelCased (`--surface-2` is `surface2`,
 * `--state-waiting-children` is `stateWaitingChildren`).
 */
export type UiColorToken =
  | "bg"
  | "surface"
  | "surface2"
  | "border"
  | "borderStrong"
  | "text"
  | "textMuted"
  | "accent"
  | "accentContrast"
  | "focus"
  | "danger"
  | "dangerContrast"
  | "warningBg"
  | "warningText"
  | "infoBg"
  | "infoText"
  | "successBg"
  | "successText"
  | "dangerBg"
  | "dangerText"
  | "neutralBg"
  | "neutralText"
  | "stateWaiting"
  | "stateDelayed"
  | "stateActive"
  | "stateCompleted"
  | "stateFailed"
  | "stateDead"
  | "stateWaitingChildren";

/**
 * Colours for one scheme: any of the tokens, each `#rgb` or `#rrggbb`. A
 * token left out keeps the built-in colour.
 */
export type UiThemeColors = Partial<Record<UiColorToken, string>>;

/**
 * A custom colour theme: the `theme` option's object form (`jobsUi()`,
 * `docsUi()`, bun-common's `docsRouter` `"self-hosted"` viewer).
 */
export interface UiThemeOptions {
  /** The scheme the UI starts in, as the string form of `theme`. Default: `"system"`. */
  mode?: UiTheme;
  /** Colours for the light scheme. Default: the built-in ones. */
  light?: UiThemeColors;
  /** Colours for the dark scheme (the OS's preference, or the toggle). Default: the built-in ones. */
  dark?: UiThemeColors;
}

/**
 * The `theme` option: a scheme (`"system"`, `"light"`, `"dark"`), or a
 * {@link UiThemeOptions} object that also sets colours.
 */
export type UiThemeInput = UiTheme | UiThemeOptions;

/** `Cache-Control` for hashed bundle files: their name changes with their content. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
