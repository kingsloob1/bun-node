import type { UiConfig } from "../lib/shared/config.ts";
import { UI_CONFIG_ELEMENT_ID } from "../lib/shared/config.ts";

/** The injected configuration was missing or malformed. */
export class UiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiConfigError";
  }
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the fields the app relies on before its first request. It does not
 * re-validate everything the server resolved — only enough that a stale or
 * hand-edited shell fails with a message instead of a blank page.
 */
export function parseUiConfig(value: unknown): UiConfig {
  if (!isRecord(value)) {
    throw new UiConfigError("The UI configuration is not an object.");
  }
  if (value.version !== 1) {
    throw new UiConfigError(
      `Unsupported UI configuration version ${JSON.stringify(value.version)} (expected 1).`,
    );
  }
  for (const key of ["title", "basePath", "assetsPath", "apiBase"] as const) {
    if (typeof value[key] !== "string") {
      throw new UiConfigError(
        `The UI configuration's "${key}" is not a string.`,
      );
    }
  }
  if (value.csrfHeader !== null && typeof value.csrfHeader !== "string") {
    throw new UiConfigError(
      `The UI configuration's "csrfHeader" must be a string or null.`,
    );
  }
  if (!isRecord(value.sections)) {
    throw new UiConfigError(`The UI configuration's "sections" is missing.`);
  }
  if (!["system", "light", "dark"].includes(String(value.theme))) {
    throw new UiConfigError(`The UI configuration's "theme" is not valid.`);
  }
  return value as unknown as UiConfig;
}

/** Reads the {@link UiConfig} the server inlined as `<script type="application/json" id="bun-jobs-ui-config">`. */
export function readUiConfig(doc: Document = document): UiConfig {
  const element = doc.getElementById(UI_CONFIG_ELEMENT_ID);
  if (!element) {
    throw new UiConfigError(
      `The page has no #${UI_CONFIG_ELEMENT_ID} element: it was not served by jobsUi().`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(element.textContent ?? "");
  } catch {
    throw new UiConfigError("The UI configuration is not valid JSON.");
  }
  return parseUiConfig(parsed);
}
