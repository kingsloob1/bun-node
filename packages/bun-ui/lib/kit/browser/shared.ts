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

/**
 * Where a UI's content sits on a screen wider than its width cap. `"left"`
 * was the only placement before the `layout` option (#785).
 */
export type UiAlign = "left" | "center" | "right";

/**
 * What the `layout` option's `align` moves: `"content"` keeps the side nav at
 * the window's edge and places the screen in the space beside it; `"page"`
 * places the side nav and the screen as one block, the header's items
 * following it. A UI without a side nav (the docs viewer) looks the same
 * either way.
 */
export type UiLayoutScope = "content" | "page";

/**
 * The `layout` option (`jobsUi()`, `securityUi()`, `docsUi()`, bun-common's `docsRouter`
 * `"self-hosted"` viewer): where the content sits on a wide screen. Every
 * field is optional.
 */
export interface UiLayoutOptions {
  /** Where the content sits on a screen wider than `maxWidth`. Default: `"center"`. */
  align?: UiAlign;
  /** What `align` moves. Default: `"content"`. */
  scope?: UiLayoutScope;
  /**
   * The content's width cap in CSS pixels: an integer of at least
   * {@link MIN_UI_MAX_WIDTH}. Default: {@link DEFAULT_UI_LAYOUT}'s, 1400.
   */
  maxWidth?: number;
}

/** {@link UiLayoutOptions} once checked: every field set. Part of each UI's browser config. */
export interface UiLayout {
  /** Where the content sits on a screen wider than `maxWidth`. */
  align: UiAlign;
  /** What `align` moves. */
  scope: UiLayoutScope;
  /** The content's width cap in CSS pixels. */
  maxWidth: number;
}

/** The layout a UI has when the `layout` option is unset, or a field of it is. */
export const DEFAULT_UI_LAYOUT: Readonly<UiLayout> = Object.freeze({
  align: "center",
  scope: "content",
  maxWidth: 1400,
});

/** The narrowest `maxWidth` the `layout` option takes, in CSS pixels: a small phone's width. */
export const MIN_UI_MAX_WIDTH = 320;

/**
 * Whether a value read back from a page's config is a {@link UiLayout}: what
 * each UI's app checks before applying it (`app/kit/layout.ts`).
 */
export function isUiLayout(value: unknown): value is UiLayout {
  if (typeof value !== "object" || value === null) return false;
  const layout = value as Record<string, unknown>;
  return (
    (layout.align === "left" ||
      layout.align === "center" ||
      layout.align === "right") &&
    (layout.scope === "content" || layout.scope === "page") &&
    Number.isInteger(layout.maxWidth) &&
    (layout.maxWidth as number) >= MIN_UI_MAX_WIDTH
  );
}

/** `Cache-Control` for hashed bundle files: their name changes with their content. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
