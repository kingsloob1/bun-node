/** Reads the configuration `securityUi()` injected into the shell. */
import type { SecurityUiConfig } from "../../lib/security/browser/config.ts";
import { SECURITY_UI_CONFIG_ELEMENT_ID } from "../../lib/security/browser/config.ts";
import {
  DEFAULT_SHELL_CHROME,
  isUiChrome,
} from "../../lib/kit/browser/mount.ts";

/**
 * The config in `doc`'s config element; throws when it is missing, not this
 * version, or its `chrome` is not one (missing, from an older shell: the
 * shell's frame).
 */
export function readUiConfig(doc: Document = document): SecurityUiConfig {
  const element = doc.getElementById(SECURITY_UI_CONFIG_ELEMENT_ID);
  if (element === null) {
    throw new Error(
      `the page has no #${SECURITY_UI_CONFIG_ELEMENT_ID} element`,
    );
  }
  const config = JSON.parse(element.textContent ?? "") as SecurityUiConfig;
  if (config?.version !== 1) {
    throw new Error("the page's configuration is not version 1");
  }
  const chrome: unknown =
    config.chrome === undefined ? DEFAULT_SHELL_CHROME : config.chrome;
  if (!isUiChrome(chrome)) {
    throw new Error(
      `the page's configuration's "chrome" must be "full", "tabs" or "none"`,
    );
  }
  return { ...config, chrome };
}
