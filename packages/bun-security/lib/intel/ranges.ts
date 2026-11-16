/**
 * Range feeds (layers.md L5): lists of addresses and ranges, fetched from
 * URLs the operator configures, that put an address in a **class**: `tor`
 * (the Tor Project's exit list), `hosting` (a cloud provider's published
 * ranges), and later `crawler:<id>` (PR-S12's crawler range files, on the
 * same machinery).
 *
 * A feed is fetched on its interval, verified, and swapped in only when
 * good: answered `200`, no larger than `maxBytes`, parsed, and holding at
 * least `minEntries` ranges, so a truncated or empty download never empties
 * the class (T-L5-1, ConcaveHR's write-up §3). On any failure the last good
 * copy stays, and with a `dir` it survives a restart too: each good copy is
 * written there (atomically) and read back when the feed starts.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { ConfigError, toDurationMs } from "@kingsleyweb/bun-common";
import type { Duration } from "@kingsleyweb/bun-common";
import { parseCidr } from "../ip/address";
import type { ParsedCidr } from "../ip/address";

/** How a feed's body is read. */
export type RangeFormat =
  /** One address or range per line; `#` starts a comment; blank lines skipped (the Tor bulk exit list, Cloudflare's `ips-v4`). */
  | "lines"
  /** JSON: every string anywhere in it that is an address or a range (AWS `ip-ranges.json`, Google's `cloud.json` and crawler files, Azure service tags, Oracle's). */
  | "json"
  /** Your own parser: the body's text to the ranges' texts. */
  | ((body: string) => readonly string[]);

/** A feed's settings. */
export interface RangeFeedOptions {
  /** Its id: letters, digits, `_`, `.`, `-` and `:`, unique among the feeds (`"tor"`, `"aws"`). */
  readonly id: string;
  /** The class its ranges put an address in (`"tor"`, `"hosting"`). Several feeds may share one. Default its `id`. */
  readonly class?: string;
  /** Where it is fetched from: an `http:` or `https:` URL you choose. */
  readonly url: string;
  /** How its body is read. Default `"lines"`. */
  readonly format?: RangeFormat;
  /** How often it is fetched. Default `"1h"`. */
  readonly interval?: Duration;
  /** After a failure, how soon to try again (never later than `interval`). Default `"5m"`. */
  readonly retry?: Duration;
  /** The fewest ranges a good copy holds; fewer is refused and the last good copy kept. Default `1`. */
  readonly minEntries?: number;
  /** The largest body accepted, in bytes. Default 16 MiB. */
  readonly maxBytes?: number;
  /** The most ranges kept from one copy (the rest refused as a bad copy). Default `500_000`. */
  readonly maxEntries?: number;
  /** How long a fetch may take, in ms. Default `30_000`. */
  readonly timeoutMs?: number;
}

/** A feed, compiled. */
export interface RangeFeed {
  /** Its id. */
  readonly id: string;
  /** Its class. */
  readonly class: string;
  /** Where it is fetched from. */
  readonly url: string;
  /** Its parser. */
  readonly parse: (body: string) => readonly string[];
  /** Its interval, ms. */
  readonly interval: number;
  /** Its retry delay, ms. */
  readonly retry: number;
  /** The fewest ranges a good copy holds. */
  readonly minEntries: number;
  /** The largest body, bytes. */
  readonly maxBytes: number;
  /** The most ranges in a copy. */
  readonly maxEntries: number;
  /** The fetch timeout, ms. */
  readonly timeoutMs: number;
}

/** A feed's id or a class name. */
const NAME_RE = /^[a-z0-9][\w.:-]{0,63}$/i;

/** One address or range per line. */
function parseLines(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (line !== "") out.push(line);
  }
  return out;
}

/** Every string in a JSON document that is an address or a range. */
function parseJson(body: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 32) return;
    if (typeof value === "string") {
      if (value.length <= 64 && /[.:]/.test(value) && parseCidr(value) !== null)
        out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(JSON.parse(body) as unknown, 0);
  return out;
}

/** A positive whole number option, or throws. */
function positive(name: string, value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError(
      `rangeFeed(${what}): ${name} must be a positive whole number; got ${String(value)}`,
    );
  }
  return value;
}

/** A range feed, its settings checked. Throws a `ConfigError` on a bad one. */
export function rangeFeed(options: RangeFeedOptions): RangeFeed {
  const { id } = options;
  if (typeof id !== "string" || !NAME_RE.test(id)) {
    throw new ConfigError(
      `rangeFeed(): id must be 1-64 letters, digits, "_", ".", "-" or ":"; got ${JSON.stringify(id)}`,
    );
  }
  const className = options.class ?? id;
  if (typeof className !== "string" || !NAME_RE.test(className)) {
    throw new ConfigError(
      `rangeFeed(${id}): class must be 1-64 letters, digits, "_", ".", "-" or ":"; got ${JSON.stringify(className)}`,
    );
  }
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new ConfigError(
      `rangeFeed(${id}): url is not a URL: ${JSON.stringify(options.url)}`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(
      `rangeFeed(${id}): url must be http: or https:; got ${url.protocol}`,
    );
  }
  const format = options.format ?? "lines";
  const parse =
    typeof format === "function"
      ? format
      : format === "lines"
        ? parseLines
        : format === "json"
          ? parseJson
          : undefined;
  if (parse === undefined) {
    throw new ConfigError(
      `rangeFeed(${id}): format must be "lines", "json" or a function; got ${JSON.stringify(format)}`,
    );
  }
  const interval = toDurationMs(
    options.interval ?? "1h",
    `rangeFeed(${id}).interval`,
  );
  const retry = toDurationMs(options.retry ?? "5m", `rangeFeed(${id}).retry`);
  if (interval < 1000 || retry < 1000) {
    throw new ConfigError(
      `rangeFeed(${id}): interval and retry must be at least a second`,
    );
  }
  return Object.freeze({
    id,
    class: className,
    url: url.href,
    parse,
    interval,
    retry: Math.min(retry, interval),
    minEntries: positive("minEntries", options.minEntries ?? 1, id),
    maxBytes: positive("maxBytes", options.maxBytes ?? 16 * 1024 * 1024, id),
    maxEntries: positive("maxEntries", options.maxEntries ?? 500_000, id),
    timeoutMs: positive("timeoutMs", options.timeoutMs ?? 30_000, id),
  });
}

/** The Tor Project's bulk exit list, the URL the Tor feed is usually given. */
export const TOR_BULK_EXIT_LIST_URL =
  "https://check.torproject.org/torbulkexitlist";

/**
 * The Tor exit list as a feed: class `tor`, hourly, one address per line,
 * at least 100 entries in a good copy (the list holds over a thousand).
 */
export function torExitFeed(
  options: Partial<RangeFeedOptions> & { readonly url: string },
): RangeFeed {
  return rangeFeed({
    id: "tor",
    class: "tor",
    interval: "1h",
    minEntries: 100,
    format: "lines",
    ...options,
  });
}

/** A feed's state. */
export interface FeedStatus {
  /** Its id. */
  readonly id: string;
  /** Its class. */
  readonly class: string;
  /** Ranges in the copy in use. */
  readonly entries: number;
  /** Where that copy came from: a fetch, the `dir`, or nowhere yet. */
  readonly source: "fetch" | "disk" | "none";
  /** When that copy was fetched (epoch ms), if it was. */
  readonly updatedAt: number | undefined;
  /** When it was last tried (epoch ms), if it was. */
  readonly attemptedAt: number | undefined;
  /** Why the last try failed, if it did. */
  readonly error: string | undefined;
  /** When it is next due (epoch ms). */
  readonly dueAt: number;
}

/** The outcome of one fetch. */
export interface FeedRefresh {
  /** The feed's id. */
  readonly id: string;
  /** Whether a new copy is in use. */
  readonly ok: boolean;
  /** Ranges in the copy in use after it. */
  readonly entries: number;
  /** Why it failed, if it did. */
  readonly error?: string;
}

/** The fetch a feed uses: the global one, or a test's. */
export type FeedFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

/** One feed's live state, kept by the intel. */
export class FeedState {
  /** The copy in use, parsed. */
  ranges: readonly ParsedCidr[] = [];
  /** Where it came from. */
  source: "fetch" | "disk" | "none" = "none";
  /** When fetched. */
  updatedAt: number | undefined;
  /** When last tried. */
  attemptedAt: number | undefined;
  /** The last failure. */
  error: string | undefined;
  /** When next due. */
  dueAt = 0;
  /** The `ETag` of the copy in use, for a conditional fetch. */
  etag: string | undefined;

  constructor(
    /** The feed. */
    readonly feed: RangeFeed,
  ) {}

  /** Its status. */
  status(): FeedStatus {
    return Object.freeze({
      id: this.feed.id,
      class: this.feed.class,
      entries: this.ranges.length,
      source: this.source,
      updatedAt: this.updatedAt,
      attemptedAt: this.attemptedAt,
      error: this.error,
      dueAt: this.dueAt,
    });
  }

  /** The body's ranges, or why the copy is bad. */
  #read(body: string): ParsedCidr[] | string {
    let texts: readonly string[];
    try {
      texts = this.feed.parse(body);
    } catch (error) {
      return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (texts.length > this.feed.maxEntries) {
      return `${texts.length} ranges, more than maxEntries ${this.feed.maxEntries}`;
    }
    const ranges: ParsedCidr[] = [];
    for (const text of texts) {
      const cidr = parseCidr(text);
      if (cidr !== null) ranges.push(cidr);
    }
    if (ranges.length < this.feed.minEntries) {
      return `${ranges.length} ranges, fewer than minEntries ${this.feed.minEntries}`;
    }
    return ranges;
  }

  /** Loads the last good copy from `dir`, if one is there and good. */
  async loadFrom(dir: string): Promise<boolean> {
    const file = Bun.file(join(dir, `${this.feed.id}.ranges`));
    if (!(await file.exists())) return false;
    const read = this.#read(await file.text());
    if (typeof read === "string") {
      this.error = `the copy in ${dir} was refused: ${read}`;
      return false;
    }
    this.ranges = read;
    this.source = "disk";
    this.updatedAt = file.lastModified;
    // Due when that copy would have been: a fresh one is not fetched again at once.
    this.dueAt = file.lastModified + this.feed.interval;
    return true;
  }

  /**
   * Fetches and verifies a new copy; keeps the last good one on any
   * failure. Writes a good copy to `dir` when given.
   */
  async refresh(
    fetcher: FeedFetch,
    now: number,
    dir: string | undefined,
  ): Promise<FeedRefresh> {
    const feed = this.feed;
    this.attemptedAt = now;
    const fail = (error: string): FeedRefresh => {
      this.error = error;
      this.dueAt = now + feed.retry;
      return { id: feed.id, ok: false, entries: this.ranges.length, error };
    };
    let body: string;
    try {
      const response = await fetcher(feed.url, {
        signal: AbortSignal.timeout(feed.timeoutMs),
        headers:
          this.etag === undefined || this.source !== "fetch"
            ? {}
            : { "if-none-match": this.etag },
      });
      if (response.status === 304 && this.source === "fetch") {
        this.error = undefined;
        this.updatedAt = now;
        this.dueAt = now + feed.interval;
        return { id: feed.id, ok: true, entries: this.ranges.length };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return fail(`answered ${response.status}`);
      }
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > feed.maxBytes) {
        await response.body?.cancel();
        return fail(`${length} bytes, more than maxBytes ${feed.maxBytes}`);
      }
      body = await readCapped(response, feed.maxBytes);
      this.etag = response.headers.get("etag") ?? undefined;
    } catch (error) {
      return fail(
        `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const read = this.#read(body);
    if (typeof read === "string") return fail(read);
    this.ranges = read;
    this.source = "fetch";
    this.updatedAt = now;
    this.error = undefined;
    this.dueAt = now + feed.interval;
    if (dir !== undefined) {
      try {
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${feed.id}.ranges`);
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, read.map((range) => range.text).join("\n"));
        await rename(temporary, path);
      } catch (error) {
        this.error = `kept in memory, not written to ${dir}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return { id: feed.id, ok: true, entries: read.length };
  }
}

/** The body as text, refusing more than `max` bytes. */
async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`more than maxBytes ${max}`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
