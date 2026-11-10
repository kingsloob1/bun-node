/**
 * The option checks every UI's server function (`jobsUi()`, `docsUi()`)
 * shares: the mount path, the theme, the CSRF header name, and the options
 * every UI takes (`title`, `middleware`, `authorize`, `dev`). Each throws the
 * caller's error ({@link ConfigFail}), so `jobsUi()` keeps throwing bun-jobs'
 * `ConfigError` and `docsUi()` bun-common's; nothing here imports a domain
 * package.
 */
import type { RouterHandler } from "@kingsleyweb/bun-common";
import type { UiTheme } from "./browser/shared";

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
