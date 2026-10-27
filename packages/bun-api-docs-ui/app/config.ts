import type { DocsUiConfig } from "../lib/shared/config.ts";
import { DOCS_UI_CONFIG_ELEMENT_ID } from "../lib/shared/config.ts";

/** The injected configuration was missing or malformed. */
export class DocsUiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsUiConfigError";
  }
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the fields the viewer relies on before its first request. It does
 * not re-validate everything the server resolved — only enough that a stale
 * or hand-edited shell fails with a message instead of a blank page.
 */
export function parseDocsUiConfig(value: unknown): DocsUiConfig {
  if (!isRecord(value)) {
    throw new DocsUiConfigError("The UI configuration is not an object.");
  }
  if (value.version !== 1) {
    throw new DocsUiConfigError(
      `Unsupported UI configuration version ${JSON.stringify(value.version)} (expected 1).`,
    );
  }
  for (const key of [
    "title",
    "basePath",
    "assetsPath",
    "documentUrl",
  ] as const) {
    if (typeof value[key] !== "string") {
      throw new DocsUiConfigError(
        `The UI configuration's "${key}" is not a string.`,
      );
    }
  }
  if (value.csrfHeader !== null && typeof value.csrfHeader !== "string") {
    throw new DocsUiConfigError(
      `The UI configuration's "csrfHeader" must be a string or null.`,
    );
  }
  if (
    !Array.isArray(value.extensions) ||
    !value.extensions.every((prefix) => typeof prefix === "string")
  ) {
    throw new DocsUiConfigError(
      `The UI configuration's "extensions" must be an array of strings.`,
    );
  }
  if (!["system", "light", "dark"].includes(String(value.theme))) {
    throw new DocsUiConfigError(`The UI configuration's "theme" is not valid.`);
  }
  return value as unknown as DocsUiConfig;
}

/** Reads the {@link DocsUiConfig} the server inlined as `<script type="application/json" id="bun-api-docs-ui-config">`. */
export function readDocsUiConfig(doc: Document = document): DocsUiConfig {
  const element = doc.getElementById(DOCS_UI_CONFIG_ELEMENT_ID);
  if (!element) {
    throw new DocsUiConfigError(
      `The page has no #${DOCS_UI_CONFIG_ELEMENT_ID} element: it was not served by docsUi().`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(element.textContent ?? "");
  } catch {
    throw new DocsUiConfigError("The UI configuration is not valid JSON.");
  }
  return parseDocsUiConfig(parsed);
}
