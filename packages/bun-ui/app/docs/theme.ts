import type { DocsUiTheme } from "../lib/shared/config.ts";

/** `localStorage` key the chosen theme is remembered under. */
export const THEME_STORAGE_KEY = "bun-api-docs-ui:theme";

/** Every theme, in the order the toggle cycles through them. */
export const THEMES: readonly DocsUiTheme[] = ["system", "light", "dark"];

/** Whether a value is a theme. */
export function isTheme(value: unknown): value is DocsUiTheme {
  return THEMES.includes(value as DocsUiTheme);
}

/** The theme after `theme` in the toggle's cycle. */
export function nextTheme(theme: DocsUiTheme): DocsUiTheme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

/** The remembered theme, or `null`. Storage can be absent or throw (private mode, blocked site data). */
export function readStoredTheme(): DocsUiTheme | null {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers a theme; a storage failure only means it is not remembered. */
export function storeTheme(theme: DocsUiTheme): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not remembered; the page still works.
  }
}

/** The theme to start in: the remembered choice, else the mount's default. */
export function initialTheme(configured: DocsUiTheme): DocsUiTheme {
  return readStoredTheme() ?? configured;
}

/**
 * Applies a theme to the document: `data-theme="light"|"dark"` forces one,
 * no attribute follows `prefers-color-scheme` (see `styles/tokens.css`).
 */
export function applyTheme(
  theme: DocsUiTheme,
  root: HTMLElement = document.documentElement,
): void {
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}
