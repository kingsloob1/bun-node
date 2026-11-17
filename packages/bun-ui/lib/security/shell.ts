/** The security UI's HTML shell: the kit's renderer, with this UI's config element. */
import type { UiAssets } from "../kit/assets";
import type { ShellRenderer } from "../kit/shell";
import type { SecurityUiConfig } from "./browser/config";
import { createUiShellRenderer } from "../kit/shell";
import { SECURITY_UI_CONFIG_ELEMENT_ID } from "./browser/config";

/** Renders the shell for `config` and `assets`. */
export function createShellRenderer(
  config: SecurityUiConfig,
  assets: UiAssets,
): ShellRenderer {
  return createUiShellRenderer(SECURITY_UI_CONFIG_ELEMENT_ID, config, assets);
}
