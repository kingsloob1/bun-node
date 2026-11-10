/**
 * The docs viewer's HTML shell and Content-Security-Policy: the kit's
 * (`lib/kit/shell.ts`, `lib/kit/connect.ts`) with the viewer's config
 * element. Every name this module had before the kit keeps its signature;
 * `./docs/hosted` re-exports the shell and CSP builders from here.
 */
import type { UiAssets } from "../kit/assets";
import type { ShellRenderer } from "../kit/shell";
import type { DocsUiConfig } from "./browser/config";
import { createUiShellRenderer } from "../kit/shell";
import { DOCS_UI_CONFIG_ELEMENT_ID } from "./browser/config";

export { documentOriginSource } from "../kit/connect";
export {
  createNonce,
  cspHeader,
  escapeHtml,
  jsonForScript,
} from "../kit/shell";
export type { CspOptions, ShellRenderer } from "../kit/shell";

/**
 * Prepares the shell for a mount and a bundle, its configuration in the
 * `#bun-api-docs-ui-config` element. The returned function only splices a
 * nonce in.
 */
export function createShellRenderer(
  config: DocsUiConfig,
  assets: UiAssets,
): ShellRenderer {
  return createUiShellRenderer(DOCS_UI_CONFIG_ELEMENT_ID, config, assets);
}
