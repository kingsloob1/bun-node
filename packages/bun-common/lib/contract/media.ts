/**
 * Media-type keys (plan Q-C4, Q-C14, §4.12 m2): how a declared media map is
 * matched against the media type a message travels as.
 *
 * - Keys are **bare** `type/subtype`, matched **case-insensitively**.
 * - **Parameters are stripped on both sides**: a declared
 *   `text/plain; version=0.0.4` and a sent `text/plain;charset=utf-8` both
 *   match as `text/plain`. The declared key, parameters included, is kept as
 *   written for documents.
 * - **Wildcards** `type/*` and `*\/*` are keys too, and **the most specific
 *   key wins**: an exact `type/subtype`, then `type/*`, then `*\/*`.
 * - Two keys that are the same once bare and lower-cased (`text/plain` and
 *   `Text/Plain; charset=utf-8`) would tie, so a map holding both is refused
 *   when it is declared, as is a key that is not a media type (`json`,
 *   `*\/json`, `text/x*`).
 *
 * Nothing here imports a Bun or Node API (browser-safe, like the rest of
 * `lib/contract/`). Internal: the names are not exported from the package.
 */

/** A token of RFC 9110's `type` or `subtype` (`tchar`s), already lower-cased. */
const TOKEN = /^[!#$%&'*+.^\w`|~-]+$/;

/** A declared media key, parsed once. */
export interface MediaKey {
  /** The key as declared, parameters and case included (what documents show). */
  readonly declared: string;
  /** The bare, lower-cased `type/subtype` (`text/plain`, `text/*`, `*\/*`). */
  readonly bare: string;
  /** The lower-cased type (`text`, or `*`). */
  readonly type: string;
  /** How specific the key is: `2` exact, `1` for `type/*`, `0` for `*\/*`. */
  readonly specificity: 0 | 1 | 2;
}

/**
 * The bare, lower-cased `type/subtype` of a media type or `Content-Type`
 * value: parameters (`; charset=utf-8`) and surrounding space dropped.
 *
 * @param mediaType A media type as declared or sent.
 */
export function bareMediaType(mediaType: string): string {
  const semi = mediaType.indexOf(";");
  return (semi === -1 ? mediaType : mediaType.slice(0, semi))
    .trim()
    .toLowerCase();
}

/**
 * Parses a declared media key, or answers `undefined` when it is not a media
 * type a map can be keyed by: `type/subtype`, `type/*` or `*\/*`, with
 * optional parameters. A `*` anywhere else (`*\/json`, `text/x*`) is refused.
 *
 * @param declared The key as written in the map.
 */
export function parseMediaKey(declared: string): MediaKey | undefined {
  const bare = bareMediaType(declared);
  const slash = bare.indexOf("/");
  if (slash <= 0 || slash !== bare.lastIndexOf("/")) return undefined;
  const type = bare.slice(0, slash);
  const subtype = bare.slice(slash + 1);
  if (!TOKEN.test(type) || !TOKEN.test(subtype)) return undefined;
  if (type === "*") {
    return subtype === "*"
      ? { declared, bare, type, specificity: 0 }
      : undefined;
  }
  if (type.includes("*")) return undefined;
  if (subtype === "*") return { declared, bare, type, specificity: 1 };
  if (subtype.includes("*")) return undefined;
  return { declared, bare, type, specificity: 2 };
}

/**
 * A media map compiled for matching: one lookup per specificity, so a match
 * costs at most three `Map` reads.
 */
export interface MediaMatcher<V> {
  /**
   * The entry a message sent as `mediaType` (a full `Content-Type` value is
   * fine) falls under: the exact key, else its `type/*`, else `*\/*`; or
   * `undefined` when none is declared.
   */
  match: (mediaType: string) => [key: MediaKey, value: V] | undefined;
  /** Every declared key, as written, in declaration order (for messages). */
  readonly declared: readonly string[];
}

/**
 * Compiles a media map. Throws a `TypeError` for a key that is not a media
 * type and for two keys that tie (the same once bare and lower-cased).
 *
 * @param map   The map, media key to value.
 * @param where Names the declaration in the error (`validate().responses[200].content`).
 */
export function compileMediaMap<V>(
  map: Readonly<Record<string, V>>,
  where: string,
): MediaMatcher<V> {
  const byBare = new Map<string, [MediaKey, V]>();
  const declared: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    const parsed = parseMediaKey(key);
    if (parsed === undefined) {
      throw new TypeError(
        `${where}: ${JSON.stringify(key)} is not a media type (type/subtype, type/* or */*)`,
      );
    }
    const tie = byBare.get(parsed.bare);
    if (tie !== undefined) {
      throw new TypeError(
        `${where}: ${JSON.stringify(tie[0].declared)} and ${JSON.stringify(key)} are the same media type once parameters and case are ignored`,
      );
    }
    byBare.set(parsed.bare, [parsed, value]);
    declared.push(key);
  }
  const any = byBare.get("*/*");
  return {
    declared,
    match: (mediaType: string): [MediaKey, V] | undefined => {
      const bare = bareMediaType(mediaType);
      const exact = byBare.get(bare);
      if (exact !== undefined && exact[0].specificity === 2) return exact;
      const slash = bare.indexOf("/");
      if (slash > 0) {
        const family = byBare.get(`${bare.slice(0, slash)}/*`);
        if (family !== undefined) return family;
      }
      return any;
    },
  };
}
