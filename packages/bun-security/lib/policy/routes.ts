/**
 * Route patterns for limits and counted rules (layers.md L9.1 item 3): which
 * requests a rule applies to.
 *
 * - `"POST /login"`: that method and path; `"/login"` or `"* /login"`: any
 *   method. `GET` also covers `HEAD`, which the router answers with the GET
 *   handler.
 * - `"/auth/*"`: the prefix `/auth` on whole segments (`/auth`, `/auth/x`,
 *   never `/authx`).
 * - A pattern matches the request's path, or, once routing has run, the
 *   matched route's pattern (`"GET /users/:id"`).
 *
 * Paths compare case-insensitively and without a trailing slash, as the
 * router matches them by default, so `/Login/` cannot step around a limit on
 * `/login`. Percent-encoding and dot segments are L6's canonical path
 * (PR-S3).
 */

/** A route pattern, compiled. */
export interface RoutePattern {
  /** The method, upper case; `undefined` for any. */
  readonly method: string | undefined;
  /** The path, lower case, without a trailing slash (`/` stays). */
  readonly path: string;
  /** Whether {@link path} is a prefix on whole segments. */
  readonly prefix: boolean;
}

/** A pattern's text: an optional method, then a path starting with `/`. */
const PATTERN_RE = /^(?:([A-Z]{1,32}|\*) )?(\/\S{0,1023})$/;

/** `path` lower case, without a trailing slash (`/` stays). */
export function normalizeRoutePath(path: string): string {
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 0x2f /* / */) end--;
  return (end === path.length ? path : path.slice(0, end)).toLowerCase();
}

/** Parses a route pattern; `null` when it is not one. */
export function parseRoutePattern(text: unknown): RoutePattern | null {
  if (typeof text !== "string") return null;
  const match = PATTERN_RE.exec(text);
  if (!match) return null;
  const method =
    match[1] === undefined || match[1] === "*" ? undefined : match[1];
  const raw = match[2] ?? "/";
  if (raw === "/*" || raw.endsWith("/*")) {
    return {
      method,
      path: normalizeRoutePath(raw.slice(0, -2) || "/"),
      prefix: true,
    };
  }
  if (raw.includes("*")) return null;
  return { method, path: normalizeRoutePath(raw), prefix: false };
}

/** Whether `method` satisfies the pattern's method. */
function methodMatches(pattern: RoutePattern, method: string): boolean {
  return (
    pattern.method === undefined ||
    pattern.method === method ||
    (pattern.method === "GET" && method === "HEAD")
  );
}

/** Whether normalised `path` is `prefix` or below it, on whole segments. */
function under(path: string, prefix: string): boolean {
  return (
    prefix === "/" ||
    path === prefix ||
    (path.startsWith(prefix) && path.charCodeAt(prefix.length) === 0x2f) /* / */
  );
}

/**
 * Whether a request matches any of `patterns`. `path` is the request's path
 * (already normalised with {@link normalizeRoutePath}), `routePath` the
 * matched route's pattern when routing has run.
 */
export function routeMatches(
  patterns: readonly RoutePattern[],
  method: string,
  path: string,
  routePath: string | undefined,
): boolean {
  for (const pattern of patterns) {
    if (!methodMatches(pattern, method)) continue;
    if (pattern.prefix) {
      if (under(path, pattern.path)) return true;
    } else if (pattern.path === path || pattern.path === routePath) {
      return true;
    }
  }
  return false;
}
