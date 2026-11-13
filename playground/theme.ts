/**
 * The playground's colour theme (#779): `PLAYGROUND_THEME=<preset>` gives
 * every UI the playground serves (the jobs UI at `/jobs`, both `docsUi()`
 * viewers and `docsRouter`'s self-hosted one) the same custom palette, to see
 * a theme across every page. Unset, the built-in palette.
 *
 * ```bash
 * PLAYGROUND_THEME=teal bun playground/index.ts
 * PLAYGROUND_THEME=violet bun playground/index.ts
 * PLAYGROUND_THEME=midnight bun playground/index.ts   # starts dark, its own dark surfaces
 * PLAYGROUND_THEME=low-contrast bun playground/index.ts # prints the contrast warnings
 * ```
 *
 * Every preset but `low-contrast` passes the UIs' WCAG AA contrast checks
 * (`theme.test.ts` in bun-ui checks the same pairs).
 */
import type { UiThemeOptions } from "@kingsleyweb/bun-ui";
import process from "node:process";

/** The presets, by name. */
export const PLAYGROUND_THEMES = {
  /** A teal brand: the accent, the focus ring and the info tone, in both schemes. */
  teal: {
    light: {
      accent: "#0f766e",
      focus: "#0f766e",
      infoBg: "#ccfbf1",
      infoText: "#115e59",
    },
    dark: {
      accent: "#2dd4bf",
      focus: "#2dd4bf",
      accentContrast: "#04201c",
      infoBg: "#0f2f2c",
      infoText: "#99f6e4",
    },
  },
  /** A violet brand, with a tinted light background. */
  violet: {
    light: {
      accent: "#6d28d9",
      focus: "#6d28d9",
      bg: "#faf7ff",
      surface2: "#f3effc",
      infoBg: "#ede9fe",
      infoText: "#4c1d95",
    },
    dark: {
      accent: "#c4b5fd",
      focus: "#c4b5fd",
      accentContrast: "#1e0b46",
      infoBg: "#251a45",
      infoText: "#ddd6fe",
    },
  },
  /** Starts dark, on navy surfaces with an amber accent. */
  midnight: {
    mode: "dark",
    light: { accent: "#92400e", focus: "#92400e" },
    dark: {
      bg: "#0b1220",
      surface: "#111a2e",
      surface2: "#17223a",
      border: "#24314d",
      accent: "#f59e0b",
      focus: "#f59e0b",
      accentContrast: "#1c1203",
    },
  },
  /** Deliberately unreadable button text: the UIs log a contrast warning per pair. */
  "low-contrast": {
    light: { accent: "#8ab4f8" },
  },
} as const satisfies Record<string, UiThemeOptions>;

/** The preset `PLAYGROUND_THEME` names; `undefined` (the built-in palette) when unset. Throws on an unknown name. */
export function playgroundTheme(): UiThemeOptions | undefined {
  const name = process.env.PLAYGROUND_THEME;
  if (name === undefined || name === "") return undefined;
  if (!Object.hasOwn(PLAYGROUND_THEMES, name)) {
    throw new Error(
      `PLAYGROUND_THEME=${name}: one of ${Object.keys(PLAYGROUND_THEMES).join(", ")}`,
    );
  }
  return PLAYGROUND_THEMES[name as keyof typeof PLAYGROUND_THEMES];
}
