/** The kit's theme, bound to the security UI's storage key. */
import type { UiTheme } from "../../lib/security/browser/config.ts";
import {
  initialTheme as initialKitTheme,
  storeTheme as storeKitTheme,
} from "../kit/theme";

export { applyTheme, nextTheme } from "../kit/theme";

/** Where the chosen theme is remembered. */
export const THEME_STORAGE_KEY = "bun-security-ui:theme";

/** Remembers `theme`. */
export function storeTheme(theme: UiTheme): void {
  storeKitTheme(THEME_STORAGE_KEY, theme);
}

/** The remembered theme, else the configured one. */
export function initialTheme(configured: UiTheme): UiTheme {
  return initialKitTheme(THEME_STORAGE_KEY, configured);
}
