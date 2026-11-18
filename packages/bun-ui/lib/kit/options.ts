/**
 * The option checks every UI's server function (`jobsUi()`, `docsUi()`)
 * shares: the mount path, the theme, the layout, the CSRF header name, and the options
 * every UI takes (`title`, `middleware`, `authorize`, `dev`). Each throws the
 * caller's error ({@link ConfigFail}), so `jobsUi()` keeps throwing bun-jobs'
 * `ConfigError` and `docsUi()` bun-common's; nothing here imports a domain
 * package.
 */
import type { RouterHandler } from "@kingsleyweb/bun-common";
import type {
  UiAlign,
  UiLayout,
  UiLayoutScope,
  UiTheme,
} from "./browser/shared";
import type { UiChrome } from "./browser/mount";
import { DEFAULT_SHELL_CHROME, isUiChrome } from "./browser/mount";
import { DEFAULT_UI_LAYOUT, MIN_UI_MAX_WIDTH } from "./browser/shared";

/**
 * Makes the error a refused option throws: each UI passes its domain's
 * `ConfigError` (the shape `AssetsFail` and `UnauthorizedConfigError` have too).
 */
export type ConfigFail = (
  /** What is wrong, starting with the option's name. */
  message: string,
  /** The offending values, for the error's context. */
  context: Record<string, unknown>,
) => Error;

/** A path segment `basePath` may contain — the bun-jobs API's own rule. */
const PATH_SEGMENT = /^[\w.~-]+$/;

/** A header name (an RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^`|~\w-]+$/;

/**
 * Validates and normalises an absolute mount path, as the bun-jobs API
 * validates its `basePath`: absolute, trailing slashes dropped, not `"/"`, and
 * only segments of letters, digits, `_`, `.`, `~` and `-`. `what` names the
 * option in the message; `owner` is what would answer for every route of the
 * host at `"/"` (`"UI"`, `"viewer"`).
 */
export function normalizeMountPath(
  value: unknown,
  what: string,
  owner: string,
  fail: ConfigFail,
): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw fail(`${what} must be an absolute path starting with "/"`, {
      value,
    });
  }
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed === "") {
    throw fail(
      `${what} may not be "/": the ${owner}'s catch-all would answer for every GET route of the host`,
      { value },
    );
  }
  for (const segment of trimmed.slice(1).split("/")) {
    if (!PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw fail(
        `${what} may only contain "/"-separated segments of letters, digits, "_", ".", "~" and "-"`,
        { value },
      );
    }
  }
  return trimmed;
}

/** Validates `theme`, defaulting to `"system"`. */
export function resolveTheme(value: unknown, fail: ConfigFail): UiTheme {
  if (value === undefined) {
    return "system";
  }
  if (value === "system" || value === "light" || value === "dark") {
    return value;
  }
  throw fail(`theme must be "system", "light" or "dark"`, { value });
}

/** The keys of the `layout` option, in the order its messages list them. */
const LAYOUT_KEYS = ["align", "scope", "maxWidth"] as const;

/** Every `layout.align`. */
const ALIGNS: readonly UiAlign[] = ["left", "center", "right"];

/** Every `layout.scope`. */
const SCOPES: readonly UiLayoutScope[] = ["content", "page"];

/**
 * Validates the `layout` option (#785): unset, or an object of `align`,
 * `scope` and `maxWidth`, each defaulting to {@link DEFAULT_UI_LAYOUT}'s when
 * left out (`undefined`; an explicit `null` is refused).
 * `what` names the option in the message (bun-common's self-hosted viewer
 * prefixes its document's name).
 */
export function resolveLayout(
  value: unknown,
  fail: ConfigFail,
  what = "layout",
): UiLayout {
  if (value === undefined) return { ...DEFAULT_UI_LAYOUT };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail(`${what} must be an object of { align?, scope?, maxWidth? }`, {
      value,
    });
  }
  const given = value as Record<string, unknown>;
  const unknown = Object.keys(given).filter(
    (key) => !(LAYOUT_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw fail(
      `${what}: unknown key${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `"${key}"`).join(", ")} (known: ${LAYOUT_KEYS.join(", ")})`,
      { keys: unknown },
    );
  }
  const align =
    given.align === undefined ? DEFAULT_UI_LAYOUT.align : given.align;
  if (!ALIGNS.includes(align as UiAlign)) {
    throw fail(`${what}.align must be "left", "center" or "right"`, {
      value: given.align,
    });
  }
  const scope =
    given.scope === undefined ? DEFAULT_UI_LAYOUT.scope : given.scope;
  if (!SCOPES.includes(scope as UiLayoutScope)) {
    throw fail(`${what}.scope must be "content" or "page"`, {
      value: given.scope,
    });
  }
  const maxWidth =
    given.maxWidth === undefined ? DEFAULT_UI_LAYOUT.maxWidth : given.maxWidth;
  if (
    typeof maxWidth !== "number" ||
    !Number.isSafeInteger(maxWidth) ||
    maxWidth < MIN_UI_MAX_WIDTH
  ) {
    throw fail(
      `${what}.maxWidth must be a whole number of CSS pixels, at least ${MIN_UI_MAX_WIDTH}`,
      { value: given.maxWidth },
    );
  }
  return {
    align: align as UiAlign,
    scope: scope as UiLayoutScope,
    maxWidth,
  };
}

/**
 * Validates the `chrome` option (embedding.md §2): how much of its own frame
 * the UI draws, `"full"` (the default: its header and side nav), `"tabs"` or
 * `"none"`.
 */
export function resolveChrome(value: unknown, fail: ConfigFail): UiChrome {
  if (value === undefined) return DEFAULT_SHELL_CHROME;
  if (isUiChrome(value)) return value;
  throw fail(`chrome must be "full", "tabs" or "none"`, { value });
}

/**
 * Validates `csrfHeader`: a header name, or `false` for none. Unset, it is
 * `fallback()` (the jobs UI asks its API; the docs viewer has none).
 */
export function resolveCsrfHeader(
  value: unknown,
  fallback: () => string | null,
  fail: ConfigFail,
): string | null {
  if (value === undefined) {
    return fallback();
  }
  if (value === false) {
    return null;
  }
  if (typeof value !== "string" || !HEADER_NAME.test(value)) {
    throw fail("csrfHeader must be a header name or false", { value });
  }
  return value;
}

/** Fails unless `options` is an object; `fn` names the function (`"jobsUi()"`). */
export function requireOptionsObject(
  options: unknown,
  fn: string,
  fail: ConfigFail,
): void {
  if (typeof options !== "object" || options === null) {
    throw fail(`${fn} needs an options object`, {});
  }
}

/** The options every UI takes, as a caller may pass them (unchecked). */
export interface CommonUiOptionsInput {
  /** The page title; must be a non-empty string. */
  title?: unknown;
  /** Handlers run before every route; must be an array of functions. */
  middleware?: unknown;
  /** The access check; must be a function when set. */
  authorize?: unknown;
  /** Where the bundle comes from; must be a boolean when set. */
  dev?: unknown;
}

/** {@link CommonUiOptionsInput} once checked. */
export interface CommonUiOptions {
  /** The page title, `defaultTitle` when unset. */
  title: string;
  /** Handlers run before every route, `[]` when unset. */
  middleware: RouterHandler[];
}

/**
 * Checks `title`, `middleware`, `authorize` and `dev`, in that order, and
 * returns the first two resolved.
 */
export function resolveCommonOptions(
  options: CommonUiOptionsInput,
  defaultTitle: string,
  fail: ConfigFail,
): CommonUiOptions {
  const title = options.title ?? defaultTitle;
  if (typeof title !== "string" || title.trim() === "") {
    throw fail("title must be a non-empty string", { title });
  }
  const middleware = options.middleware ?? [];
  if (
    !Array.isArray(middleware) ||
    !middleware.every((handler) => typeof handler === "function")
  ) {
    throw fail("middleware must be an array of functions", {});
  }
  if (
    options.authorize !== undefined &&
    typeof options.authorize !== "function"
  ) {
    throw fail("authorize must be a function", {});
  }
  if (options.dev !== undefined && typeof options.dev !== "boolean") {
    throw fail("dev must be a boolean", { dev: options.dev });
  }
  return { title, middleware: middleware as RouterHandler[] };
}

/** A frozen copy of a UI's config, nested objects included (one level, as the configs are). */
export function freezeConfig<T extends object>(config: T): Readonly<T> {
  for (const value of Object.values(config)) {
    if (typeof value === "object" && value !== null) {
      Object.freeze(value);
    }
  }
  return Object.freeze(config);
}
