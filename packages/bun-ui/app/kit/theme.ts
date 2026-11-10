import type { UiTheme } from "../../lib/kit/browser/shared.ts";

/**
 * A UI's colour scheme: the toggle's cycle, the remembered choice and the
 * document attribute. Shared by every UI (the kit); each remembers its choice
 * under its own `localStorage` key, which it passes (`app/<ui>/theme.ts`).
 */

/** Every theme, in the order the toggle cycles through them. */
export const THEMES: readonly UiTheme[] = ["system", "light", "dark"];

/** Whether a value is a theme. */
export function isTheme(value: unknown): value is UiTheme {
  return THEMES.includes(value as UiTheme);
}

/** The theme after `theme` in the toggle's cycle. */
export function nextTheme(theme: UiTheme): UiTheme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

/** The theme remembered under `key`, or `null`. Storage can be absent or throw (private mode, blocked site data). */
export function readStoredTheme(key: string): UiTheme | null {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers a theme under `key`; a storage failure only means it is not remembered. */
export function storeTheme(key: string, theme: UiTheme): void {
  try {
    globalThis.localStorage?.setItem(key, theme);
  } catch {
    // Not remembered; the page still works.
  }
}

/** The theme to start in: the choice remembered under `key`, else the mount's default. */
export function initialTheme(key: string, configured: UiTheme): UiTheme {
  return readStoredTheme(key) ?? configured;
}

/**
 * Applies a theme to the document: `data-theme="light"|"dark"` forces one,
 * no attribute follows `prefers-color-scheme` (see `styles/tokens.css`).
 */
export function applyTheme(
  theme: UiTheme,
  root: HTMLElement = document.documentElement,
): void {
  if (theme === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}
