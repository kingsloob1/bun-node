/**
 * The keys limits and counted rules count under (layers.md L2.3, L9.1 item
 * 2): one or several parts of the request's subject, joined with `|`
 * (ConcaveHR's `ip|account`), each part escaped so that two different
 * subjects can never share a key, and the whole bounded to 256 bytes.
 */
import type { CompiledKey } from "../policy/compile";
import { normalizeRoutePath, routeMatches } from "../policy/routes";
import type { RoutePattern } from "../policy/routes";
import type { SubjectKeyPart } from "../policy/types";
import type { SubjectKeys } from "./decision";
import type { RequestFacts } from "./facts";
import { boundKey } from "./identity";

/** Where a request sits, for route patterns and the `route` key part. */
export interface RequestRoute {
  /** The method. */
  readonly method: string;
  /** The path, normalised (lower case, no trailing slash). */
  readonly path: string;
  /** The matched route's pattern, normalised, when routing has run. */
  readonly routePath: string | undefined;
  /** The `route` key part: the matched route (`"POST /login"`), or the method and normalised path. */
  readonly key: string;
}

/** The route of a request's facts. */
export function requestRoute(facts: RequestFacts): RequestRoute {
  const path = normalizeRoutePath(facts.path);
  let routePath: string | undefined;
  if (facts.routeKey !== undefined) {
    const space = facts.routeKey.indexOf(" ");
    routePath = normalizeRoutePath(
      space === -1 ? facts.routeKey : facts.routeKey.slice(space + 1),
    );
  }
  return {
    method: facts.method,
    path,
    routePath,
    key: facts.routeKey ?? `${facts.method} ${path}`,
  };
}

/** Whether `route` matches `patterns` (every route when there are none). */
export function appliesTo(
  patterns: readonly RoutePattern[] | undefined,
  route: RequestRoute,
): boolean {
  return (
    patterns === undefined ||
    routeMatches(patterns, route.method, route.path, route.routePath)
  );
}

/** One part escaped: `%` and `|` percent-encoded, so `|` only ever separates parts. */
function escapePart(value: string): string {
  return value.includes("%") || value.includes("|")
    ? value.replaceAll("%", "%25").replaceAll("|", "%7C")
    : value;
}

/** The value of one key part, `undefined` when the request has none. */
function partOf(
  part: SubjectKeyPart,
  subject: SubjectKeys,
  route: RequestRoute,
): string | undefined {
  switch (part) {
    case "ip":
      return subject.ip;
    case "route":
      return route.key;
    default:
      return subject[part];
  }
}

/**
 * The key a request counts under, or `undefined` when it lacks a part (a
 * service call forwarding no address has no `ip`; an anonymous request no
 * `user`): such a request is not counted under that key.
 */
export function keyOf(
  key: CompiledKey,
  subject: SubjectKeys,
  route: RequestRoute,
): string | undefined {
  if (key.parts.length === 1) {
    const only = partOf(key.parts[0] ?? "ip", subject, route);
    return only === undefined ? undefined : boundKey(escapePart(only));
  }
  let text = "";
  for (const part of key.parts) {
    const value = partOf(part, subject, route);
    if (value === undefined) return undefined;
    text = text === "" ? escapePart(value) : `${text}|${escapePart(value)}`;
  }
  return boundKey(text);
}
