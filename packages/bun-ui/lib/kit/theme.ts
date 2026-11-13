/**
 * Custom colour themes (#779): the `theme` option's object form, shared by
 * every UI (`jobsUi()`, `docsUi()`, and bun-common's `docsRouter`
 * `"self-hosted"` viewer through `/docs/hosted`).
 *
 * ```ts
 * jobsUi({ api, theme: { mode: "system", light: { accent: "#0f766e" }, dark: { accent: "#2dd4bf" } } });
 * ```
 *
 * Every colour the UIs draw is a custom property of the kit's
 * `app/kit/styles/tokens.css`, so a theme is a few overrides of those, in a
 * stylesheet the server generates and serves beside the bundle (the pages'
 * CSP allows styles from their own origin only: no inline `<style>`):
 *
 * - light overrides on `:root`, which the built-in dark blocks outrank, so
 *   they never reach the dark scheme;
 * - dark overrides in the same two blocks `tokens.css` uses (the OS's
 *   preference unless `data-theme="light"`, and `data-theme="dark"`),
 *   linked after it, so they win.
 *
 * Values are checked here (`#rgb` or `#rrggbb` only), so nothing a host
 * passes reaches the CSS unchecked. The browser needs no change: it still
 * receives only the starting scheme, and its toggle still switches
 * `data-theme`.
 */
import type { UiAssets } from "./assets";
import type { UiColorToken, UiTheme, UiThemeColors } from "./browser/shared";
import type { ConfigFail } from "./options";
import { withStylesheet } from "./assets";
import { CONTRAST_PAIRS, contrastRatio } from "./contrast";

/** Every colour token, in `tokens.css`'s order. */
export const UI_COLOR_TOKENS: readonly UiColorToken[] = [
  "bg",
  "surface",
  "surface2",
  "border",
  "borderStrong",
  "text",
  "textMuted",
  "accent",
  "accentContrast",
  "focus",
  "danger",
  "dangerContrast",
  "warningBg",
  "warningText",
  "infoBg",
  "infoText",
  "successBg",
  "successText",
  "dangerBg",
  "dangerText",
  "neutralBg",
  "neutralText",
  "stateWaiting",
  "stateDelayed",
  "stateActive",
  "stateCompleted",
  "stateFailed",
  "stateDead",
  "stateWaitingChildren",
];

/** A complete palette: every token's colour. */
export type UiPalette = Readonly<Record<UiColorToken, string>>;

/**
 * The built-in palettes, as `tokens.css` defines them. Kept equal to that
 * file by `__tests__/kit/server/theme.test.ts`, which parses it.
 */
export const DEFAULT_PALETTES: {
  /** The light scheme's colours. */
  readonly light: UiPalette;
  /** The dark scheme's colours. */
  readonly dark: UiPalette;
} = {
  light: {
    bg: "#f6f7f9",
    surface: "#ffffff",
    surface2: "#f0f2f5",
    border: "#d9dde3",
    borderStrong: "#838c99",
    text: "#1b1f24",
    textMuted: "#5b6573",
    accent: "#2957c7",
    accentContrast: "#ffffff",
    focus: "#2957c7",
    danger: "#b42318",
    dangerContrast: "#ffffff",
    warningBg: "#fff4d6",
    warningText: "#7a4b00",
    infoBg: "#e3ecff",
    infoText: "#1f3f8f",
    successBg: "#ddf5e6",
    successText: "#13603a",
    dangerBg: "#fde5e3",
    dangerText: "#92211a",
    neutralBg: "#eceff3",
    neutralText: "#3b4450",
    stateWaiting: "#2f6fdb",
    stateDelayed: "#7a4fcf",
    stateActive: "#0f8a8a",
    stateCompleted: "#238a4a",
    stateFailed: "#d4541a",
    stateDead: "#b42318",
    stateWaitingChildren: "#7a6a1f",
  },
  dark: {
    bg: "#0f1216",
    surface: "#171b21",
    surface2: "#1e232b",
    border: "#2d343e",
    borderStrong: "#65717f",
    text: "#e6e9ee",
    textMuted: "#9aa4b2",
    accent: "#7ea2ff",
    accentContrast: "#0b1020",
    focus: "#7ea2ff",
    danger: "#ff7b70",
    dangerContrast: "#1a0806",
    warningBg: "#3a2c0a",
    warningText: "#ffd27a",
    infoBg: "#182646",
    infoText: "#b7caff",
    successBg: "#11301f",
    successText: "#8fe0ad",
    dangerBg: "#3d1512",
    dangerText: "#ffb4ad",
    neutralBg: "#242a33",
    neutralText: "#c9d0da",
    stateWaiting: "#6f9ef0",
    stateDelayed: "#b08cf0",
    stateActive: "#3cc4c4",
    stateCompleted: "#52c47f",
    stateFailed: "#f08a52",
    stateDead: "#ff7b70",
    stateWaitingChildren: "#cdb64a",
  },
};

/** A token's CSS custom property name, without `--`: `surface2` → `surface-2`. */
export function cssTokenName(token: UiColorToken): string {
  return token
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    .replace(/\d+/g, (digits) => `-${digits}`);
}

/** The token a CSS custom property name is, when it is one. */
function tokenOfCss(name: string): UiColorToken | undefined {
  return UI_COLOR_TOKENS.find((token) => cssTokenName(token) === name);
}

/** The only colour syntax a theme takes: checkable, and nothing else can reach the CSS. */
const HEX_COLOUR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

/** The schemes a theme's object may set. */
const SCHEMES = ["light", "dark"] as const;

/** A theme's overrides, checked: each scheme's colours, lowercased. */
export interface UiThemeOverrides {
  /** The light scheme's overrides (possibly none). */
  readonly light: UiThemeColors;
  /** The dark scheme's overrides (possibly none). */
  readonly dark: UiThemeColors;
}

/** The `theme` option, checked. */
export interface ResolvedUiTheme {
  /** The scheme the UI starts in. */
  readonly mode: UiTheme;
  /** The colour overrides; `undefined` when the option sets none. */
  readonly colors: UiThemeOverrides | undefined;
}

/** Whether `value` is a scheme name. */
function isMode(value: unknown): value is UiTheme {
  return value === "system" || value === "light" || value === "dark";
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the `theme` option: a scheme (`"system"`, the default, `"light"`,
 * `"dark"`), or `{ mode?, light?, dark? }` whose colour maps name tokens
 * ({@link UI_COLOR_TOKENS}) and give `#rgb` or `#rrggbb`. Throws the
 * caller's error ({@link ConfigFail}) naming what is wrong.
 *
 * @param value The option as passed.
 * @param fail The UI's error factory.
 * @param what The option's name in messages. Default: `"theme"`.
 */
export function resolveThemeInput(
  value: unknown,
  fail: ConfigFail,
  what = "theme",
): ResolvedUiTheme {
  if (value === undefined) return { mode: "system", colors: undefined };
  if (isMode(value)) return { mode: value, colors: undefined };
  if (!isRecord(value)) {
    throw fail(
      `${what} must be "system", "light", "dark" or { mode?, light?, dark? }`,
      { value },
    );
  }
  const unknown = Object.keys(value).filter(
    (key) => key !== "mode" && key !== "light" && key !== "dark",
  );
  if (unknown.length > 0) {
    throw fail(
      `${what}: unknown key${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `"${key}"`).join(", ")} (known: mode, light, dark)`,
      { keys: unknown },
    );
  }
  const mode = value.mode ?? "system";
  if (!isMode(mode)) {
    throw fail(`${what}.mode must be "system", "light" or "dark"`, {
      value: value.mode,
    });
  }
  const colors: Record<"light" | "dark", UiThemeColors> = {
    light: {},
    dark: {},
  };
  for (const scheme of SCHEMES) {
    const given = value[scheme];
    if (given === undefined) continue;
    if (!isRecord(given)) {
      throw fail(
        `${what}.${scheme} must be an object of colour tokens (e.g. { accent: "#2957c7" })`,
        { value: given },
      );
    }
    const out: Partial<Record<UiColorToken, string>> = {};
    for (const [key, colour] of Object.entries(given)) {
      if (!UI_COLOR_TOKENS.includes(key as UiColorToken)) {
        throw fail(
          `${what}.${scheme}.${key} is not a colour token (known: ${UI_COLOR_TOKENS.join(", ")})`,
          { key },
        );
      }
      if (typeof colour !== "string" || !HEX_COLOUR.test(colour)) {
        throw fail(
          `${what}.${scheme}.${key} must be a colour as "#rgb" or "#rrggbb"`,
          { value: colour },
        );
      }
      out[key as UiColorToken] = colour.toLowerCase();
    }
    colors[scheme] = out;
  }
  const none =
    Object.keys(colors.light).length === 0 &&
    Object.keys(colors.dark).length === 0;
  return { mode, colors: none ? undefined : colors };
}

/** One scheme's declarations, in token order. */
function declarations(colors: UiThemeColors, indent: string): string {
  return UI_COLOR_TOKENS.filter((token) => colors[token] !== undefined)
    .map((token) => `${indent}--${cssTokenName(token)}: ${colors[token]};\n`)
    .join("");
}

/**
 * The stylesheet a theme's overrides make, linked after the bundle's own.
 * Deterministic: the same overrides give the same bytes (and file name).
 */
export function themeStylesheet(colors: UiThemeOverrides): string {
  let css =
    "/* Generated by @kingsleyweb/bun-ui from the `theme` option: overrides of tokens.css. */\n";
  const light = declarations(colors.light, "  ");
  if (light !== "") css += `:root {\n${light}}\n`;
  if (declarations(colors.dark, "") !== "") {
    css += `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${declarations(colors.dark, "    ")}  }\n}\n`;
    css += `:root[data-theme="dark"] {\n${declarations(colors.dark, "  ")}}\n`;
  }
  return css;
}

/**
 * The WCAG AA problems a theme's overrides make: each pair the UIs draw
 * ({@link CONTRAST_PAIRS}) that involves an overridden colour and falls
 * below its minimum, over the built-in palette with the overrides applied.
 * A pair of two built-in colours is never reported: the built-in palettes
 * pass (the contrast test).
 *
 * @returns One message per pair, e.g. `theme.light: accentContrast #ffffff
 *   on accent #8ab4f8 is 2.07:1, below 4.5:1 (primary buttons, accent badges)`.
 */
export function themeContrastProblems(
  colors: UiThemeOverrides,
  what = "theme",
): string[] {
  const problems: string[] = [];
  for (const scheme of SCHEMES) {
    const overrides = colors[scheme];
    if (Object.keys(overrides).length === 0) continue;
    const palette: UiPalette = { ...DEFAULT_PALETTES[scheme], ...overrides };
    for (const pair of CONTRAST_PAIRS) {
      const fg = tokenOfCss(pair.fg);
      const bg = tokenOfCss(pair.bg);
      if (fg === undefined || bg === undefined) continue;
      if (overrides[fg] === undefined && overrides[bg] === undefined) continue;
      const ratio = contrastRatio(palette[fg], palette[bg]);
      if (ratio < pair.min) {
        problems.push(
          `${what}.${scheme}: ${fg} ${palette[fg]} on ${bg} ${palette[bg]} is ${ratio.toFixed(2)}:1, below ${pair.min}:1 (${pair.use})`,
        );
      }
    }
  }
  return problems;
}

/**
 * Applies a checked theme to a UI's bundle loader: with colours, every load
 * returns the bundle plus the theme's stylesheet (`theme-<hash>.css`, linked
 * last), and `warn` receives each contrast problem once, now. Without
 * colours, the loader as it is.
 *
 * @param theme The checked `theme` option.
 * @param loadAssets The UI's bundle loader.
 * @param warn Receives one message per contrast problem (the UI logs it).
 */
export function themedAssets(
  theme: ResolvedUiTheme,
  loadAssets: () => Promise<UiAssets>,
  warn: (message: string) => void,
): () => Promise<UiAssets> {
  const colors = theme.colors;
  if (colors === undefined) return loadAssets;
  for (const problem of themeContrastProblems(colors)) warn(problem);
  const css = themeStylesheet(colors);
  // Once per bundle: a loader may be called on every request (a host's).
  const themed = new WeakMap<UiAssets, UiAssets>();
  return async () => {
    const assets = await loadAssets();
    let out = themed.get(assets);
    if (out === undefined) {
      out = withStylesheet(assets, "theme", css);
      themed.set(assets, out);
    }
    return out;
  };
}
