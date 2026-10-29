/**
 * Surrogate-key headers for a CDN in front of `cacheResponse()` (plan §9.3,
 * R27): a response carries its entry's tags in the header the CDN reads, so
 * the CDN can purge by the same tags `cache.invalidateTags()` takes.
 *
 * Two formats, from the CDNs' own documentation:
 *
 * - **Fastly, `Surrogate-Key`**: keys separated by spaces, case sensitive,
 *   no duplicates; a key at most 1 KB and the header at most 16 KB, past
 *   which Fastly ignores the key being parsed and every key after it.
 *   Fastly removes the header before the response reaches the client.
 *   https://www.fastly.com/documentation/guides/full-site-delivery/purging/working-with-surrogate-keys/
 * - **Cloudflare, `Cache-Tag`**: tags separated by commas, case insensitive,
 *   printable ASCII, no spaces; the header at most 16 KB after its name, and
 *   a tag a purge call names at most 1,024 characters. Cloudflare removes
 *   the header before the response reaches the visitor.
 *   https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/
 *
 * Both are kept under the smaller reading of their limits: a tag of at most
 * {@link MAX_TAG_BYTES} visible ASCII characters (`!` to `~`) without the
 * format's separator, and a header value of at most
 * {@link MAX_HEADER_BYTES}. A tag that breaks a format is left out of the
 * header (never encoded, which would change the name a purge must use, and
 * never cut, which could make it another tag's), reported once through the
 * caller's `warn`; a request is never failed over one.
 */

/** The header a `surrogateKeys` option names. */
export type SurrogateKeysHeader = "Surrogate-Key" | "Cache-Tag";

/** The longest tag the header carries, in bytes (ASCII: one per character): Fastly's "1KB" read as 1,000, under Cloudflare's 1,024. */
export const MAX_TAG_BYTES = 1000;
/** The longest header value, in bytes: both CDNs' "16 KB", read as 16,000. */
export const MAX_HEADER_BYTES = 16_000;

/** Why a tag was left out of the header. */
export type SurrogateSkip =
  /** It holds the format's separator (a space for `Surrogate-Key`, a comma for `Cache-Tag`). */
  | "separator"
  /** It holds a character outside visible ASCII (`!` to `~`): whitespace, a control character, non-ASCII. */
  | "character"
  /** It is longer than {@link MAX_TAG_BYTES}. */
  | "too-long"
  /** It would take the header past {@link MAX_HEADER_BYTES}. */
  | "header-full";

/** A format: its header and how it separates and compares tags. */
export interface SurrogateFormat {
  /** The header name, as the option gave it. */
  header: SurrogateKeysHeader;
  /** The separator the header joins tags with. */
  separator: " " | ",";
  /** Whether tags compare case-insensitively (Cloudflare's). */
  caseInsensitive: boolean;
}

/** The format of a `surrogateKeys` header. */
export function surrogateFormat(header: SurrogateKeysHeader): SurrogateFormat {
  return header === "Surrogate-Key"
    ? { header, separator: " ", caseInsensitive: false }
    : { header, separator: ",", caseInsensitive: true };
}

/** Why `tag` cannot go into `format`'s header on its own; `undefined` when it can. */
export function surrogateTagProblem(
  format: SurrogateFormat,
  tag: string,
): Exclude<SurrogateSkip, "header-full"> | undefined {
  if (tag.length > MAX_TAG_BYTES) {
    return "too-long";
  }
  let problem: "separator" | "character" | undefined;
  for (let i = 0; i < tag.length; i++) {
    const code = tag.charCodeAt(i);
    if (tag[i] === format.separator) {
      return "separator";
    }
    if (code < 0x21 || code > 0x7e) {
      problem = "character";
    }
  }
  return problem;
}

/** The tokens of a header value the handler (or a middleware ahead) already set. */
function tokensOf(format: SurrogateFormat, value: string): string[] {
  const parts =
    format.separator === " " ? value.split(/\s+/) : value.split(",");
  const tokens: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (token !== "") {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * The header value for `tags`, merged after `existing` (what the response
 * already carries, kept first and verbatim, de-duplicated) — `undefined`
 * when there is nothing to set. Each tag that cannot go in is passed to
 * `skip` with the reason; the rest are appended in order, de-duplicated
 * (case-insensitively for `Cache-Tag`), while the value stays within
 * {@link MAX_HEADER_BYTES}.
 */
export function surrogateHeaderValue(
  format: SurrogateFormat,
  existing: string | undefined,
  tags: readonly string[],
  skip: (tag: string, reason: SurrogateSkip) => void,
): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  const identity = (token: string): string =>
    format.caseInsensitive ? token.toLowerCase() : token;
  let bytes = 0;
  const push = (token: string): void => {
    seen.add(identity(token));
    bytes += (out.length === 0 ? 0 : 1) + token.length;
    out.push(token);
  };
  for (const token of existing === undefined
    ? []
    : tokensOf(format, existing)) {
    if (!seen.has(identity(token))) {
      push(token);
    }
  }
  for (const tag of tags) {
    if (seen.has(identity(tag))) {
      continue;
    }
    const problem = surrogateTagProblem(format, tag);
    if (problem !== undefined) {
      skip(tag, problem);
      continue;
    }
    if (bytes + (out.length === 0 ? 0 : 1) + tag.length > MAX_HEADER_BYTES) {
      skip(tag, "header-full");
      continue;
    }
    push(tag);
  }
  return out.length === 0 ? undefined : out.join(format.separator);
}
