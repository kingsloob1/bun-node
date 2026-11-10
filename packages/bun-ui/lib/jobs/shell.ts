/**
 * The jobs UI's HTML shell and Content-Security-Policy: the kit's
 * (`lib/kit/shell.ts`, `lib/kit/connect.ts`) with the jobs UI's config
 * element. Every name this module had before the kit keeps its signature.
 */
import type { UiAssets } from "../kit/assets";
import type { ShellRenderer } from "../kit/shell";
import type { JobsUiConfig } from "./browser/config";
import { createUiShellRenderer } from "../kit/shell";
import { JOBS_UI_CONFIG_ELEMENT_ID } from "./browser/config";

export { connectSources } from "../kit/connect";
export type { ConnectSourcesOptions } from "../kit/connect";
export {
  createNonce,
  cspHeader,
  escapeHtml,
  jsonForScript,
} from "../kit/shell";
export type { CspOptions, ShellRenderer } from "../kit/shell";

/**
 * Prepares the shell for a mount and a bundle, its configuration in the
 * `#bun-jobs-ui-config` element. The returned function only splices a nonce in.
 */
export function createShellRenderer(
  config: JobsUiConfig,
  assets: UiAssets,
): ShellRenderer {
  return createUiShellRenderer(JOBS_UI_CONFIG_ELEMENT_ID, config, assets);
}
