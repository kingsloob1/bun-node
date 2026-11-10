import type { UiTheme } from "../../lib/jobs/browser/config.ts";
import {
  initialTheme as initialKitTheme,
  readStoredTheme as readKitStoredTheme,
  storeTheme as storeKitTheme,
} from "../kit/theme";

export { applyTheme, isTheme, nextTheme, THEMES } from "../kit/theme";

/** `localStorage` key the chosen theme is remembered under. */
export const THEME_STORAGE_KEY = "bun-jobs-ui:theme";

/** The remembered theme, or `null`. Storage can be absent or throw (private mode, blocked site data). */
export function readStoredTheme(): UiTheme | null {
  return readKitStoredTheme(THEME_STORAGE_KEY);
}

/** Remembers a theme; a storage failure only means it is not remembered. */
export function storeTheme(theme: UiTheme): void {
  storeKitTheme(THEME_STORAGE_KEY, theme);
}

/** The theme to start in: the remembered choice, else the mount's default. */
export function initialTheme(configured: UiTheme): UiTheme {
  return initialKitTheme(THEME_STORAGE_KEY, configured);
}
