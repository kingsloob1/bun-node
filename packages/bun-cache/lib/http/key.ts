/**
 * The keys and the automatic tag of `cacheResponse()` (plan §9.1, §9.3).
 *
 * A base key is `GET` (HEAD shares GET's entry), the host when keyed, the
 * path, the normalised query and the `varyBy` headers' values — or the `key`
 * function's string in place of everything after `GET`. A variant key adds
 * the values of the headers the response's own `Vary` names. Both are JSON
 * arrays, so no value can be mistaken for a separator; the core hashes a key
 * past `maxKeyLength` (§3.7).
 */
import type { BunRequest } from "@kingsleyweb/bun-common";

/** The prefix of every key and tag `cacheResponse()` writes. */
const PREFIX = "http:";
/** Tags longer than this are hashed, as the core hashes long keys. */
const MAX_TAG_LENGTH = 200;

/** The request target's parts, from `originalUrl` (a mounted router's `req.url` is rewritten). */
export interface Target {
  /** The path, without query or fragment. */
  path: string;
  /** The query, without the `?`; `""` when absent. */
  query: string;
}

/** Splits a request target (`/path?query#hash`) into path and query. */
export function splitTarget(target: string): Target {
  let raw = target;
  const hash = raw.indexOf("#");
  if (hash !== -1) {
    raw = raw.slice(0, hash);
  }
  const mark = raw.indexOf("?");
  return mark === -1
    ? { path: raw, query: "" }
    : { path: raw.slice(0, mark), query: raw.slice(mark + 1) };
}

/** A request's target, from `originalUrl` (a mounted router's `req.url` is rewritten). */
export function targetOf(req: BunRequest): Target {
  return splitTarget(req.originalUrl);
}

/** The request's host, lower-cased, for `host: true`. */
export function hostOf(req: BunRequest): string {
  return req.host.toLowerCase();
}

/**
 * The query as the key sees it: sorted by name (stably, so repeated names
 * keep their order), filtered to `names` when given; `""` for `false`.
 */
export function normaliseQuery(
  query: string,
  option: "all" | readonly string[] | false,
): string {
  if (option === false || query === "") {
    return "";
  }
  const params = new URLSearchParams(query);
  let entries = [...params];
  if (option !== "all") {
    const allowed = new Set(option);
    entries = entries.filter(([name]) => allowed.has(name));
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new URLSearchParams(entries).toString();
}

/** The values of `names` on the request, `""` for an absent header. */
export function headerValues(
  req: BunRequest,
  names: readonly string[],
): string[] {
  return names.map((name) => req.getHeader(name) ?? "");
}

/**
 * The header names of a `Vary` value, lower-cased, sorted and unique;
 * `"*"` when it has `*` (never stored, RFC 9111 §4.1). Empty without one.
 */
export function parseVary(value: string | null): string[] | "*" {
  if (value === null || value.trim() === "") {
    return [];
  }
  const names = new Set<string>();
  for (const part of value.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "*") {
      return "*";
    }
    if (name !== "") {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** The base key's inputs. */
export interface BaseKeyInput {
  /** The host, when `host: true`. */
  host: string | undefined;
  /** The target. */
  target: Target;
  /** The `query` option. */
  query: "all" | readonly string[] | false;
  /** The `varyBy` header names, lower-cased. */
  varyBy: readonly string[];
  /** The `key` function's result, when one is given: it replaces host, path, query and `varyBy`. */
  custom: string | undefined;
}

/** The base key of a request. */
export function baseKey(req: BunRequest, input: BaseKeyInput): string {
  if (input.custom !== undefined) {
    return `${PREFIX}${JSON.stringify(["GET", "key", input.custom])}`;
  }
  const parts: unknown[] = [
    "GET",
    input.host ?? "",
    input.target.path,
    normaliseQuery(input.target.query, input.query),
  ];
  if (input.varyBy.length > 0) {
    parts.push(headerValues(req, input.varyBy));
  }
  return `${PREFIX}${JSON.stringify(parts)}`;
}

/** The variant key of a base key, for the values of the headers a response varies on. */
export function variantKey(
  base: string,
  vary: readonly string[],
  values: readonly string[],
): string {
  return `${base}${JSON.stringify(vary.map((name, i) => [name, values[i]]))}`;
}

/**
 * The tag every entry for a path carries, so an unsafe method or
 * `invalidate()` drops all of its query strings and variants at once
 * (RFC 9111 §4.4). With `host: true` the host is part of it.
 */
export function pathTag(host: string | undefined, path: string): string {
  const tag = `${PREFIX}path:${host ?? ""}${path}`;
  if (tag.length <= MAX_TAG_LENGTH) {
    return tag;
  }
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(tag);
  return `${PREFIX}path:#${hasher.digest("hex")}`;
}
