/**
 * IP intelligence (layers.md L5): country and ASN from MaxMind DB files the
 * operator supplies, and classes (`tor`, `hosting`, …) from range feeds
 * the operator configures and static ranges.
 *
 * ```ts
 * const intel = await ipIntel({
 *   databases: ["/var/lib/geo/GeoLite2-Country.mmdb", "/var/lib/geo/GeoLite2-ASN.mmdb"],
 *   feeds: [torExitFeed({ url: TOR_BULK_EXIT_LIST_URL })],
 *   dir: "/var/lib/bun-security/ranges",
 * });
 * intel.start(); // or call intel.refresh() from your scheduler
 * const security = createSecurity({ policy, intel });
 * ```
 *
 * Lookups are cached per process in an LRU (`cacheSize`, 50,000
 * addresses); a lookup that hits returns the same frozen record, so the
 * hot path allocates nothing for a cached address.
 */
import {
  ConfigError,
  createLogger,
  resolveLogger,
} from "@kingsleyweb/bun-common";
import type { Logger, LoggerLike } from "@kingsleyweb/bun-common";
import {
  isWholeFamilyRange,
  parseAddress,
  parseCidr,
  WHOLE_FAMILY_RANGE,
} from "../ip/address";
import type { ParsedAddress, ParsedCidr } from "../ip/address";
import { CidrTrie } from "../ip/trie";
import { openMmdb } from "./mmdb";
import type { MmdbMetadata, MmdbReader, MmdbValue } from "./mmdb";
import { FeedState } from "./ranges";
import type { FeedFetch, FeedRefresh, FeedStatus, RangeFeed } from "./ranges";
import type { IntelLookup, IntelProvides, IntelRecord } from "./types";

/** What a database record gives, read by {@link IpIntelOptions.extract}. */
export interface ExtractedIntel {
  /** The country, ISO 3166-1 alpha-2. */
  readonly country?: string;
  /** The ASN. */
  readonly asn?: number;
  /** The AS organisation. */
  readonly asOrganization?: string;
}

/** Options for {@link ipIntel}. */
export interface IpIntelOptions {
  /**
   * MaxMind DB files (paths, or readers from `openMmdb`): a country
   * database, an ASN database, or one with both (IPinfo Lite). Each lookup
   * reads them in order; the first to give a field gives it. None ships with
   * the package: download your own (see the README for GeoLite2, DB-IP Lite
   * and IPinfo Lite, and their licences).
   */
  readonly databases?: readonly (string | MmdbReader)[];
  /** Range feeds (`rangeFeed`, `torExitFeed`): fetched on their intervals once {@link IpIntel.start} runs. */
  readonly feeds?: readonly RangeFeed[];
  /** Static ranges per class (`{ office: ["198.51.100.0/24"] }`), never fetched. */
  readonly ranges?: Readonly<Record<string, readonly string[]>>;
  /**
   * Where each feed's last good copy is kept (`<id>.ranges`), and read back
   * at start, so a restart has its classes before the first fetch. Default:
   * memory only.
   */
  readonly dir?: string;
  /** How many addresses the lookup cache holds. Default `50_000`. */
  readonly cacheSize?: number;
  /**
   * Reads a database record; the default reads MaxMind's and DB-IP's
   * `country.iso_code` (else `registered_country.iso_code`),
   * `autonomous_system_number` and `autonomous_system_organization`, and
   * IPinfo Lite's `country_code`, `asn` (`"AS13335"`) and `as_name`.
   */
  readonly extract?: (
    record: MmdbValue,
    metadata: MmdbMetadata,
  ) => ExtractedIntel;
  /** The fetch feeds use. Default the global `fetch`. */
  readonly fetch?: FeedFetch;
  /** Where refresh failures are logged. Default a console logger named `bun-security`. */
  readonly logger?: LoggerLike;
  /** The clock, epoch ms. Default `Date.now`. */
  readonly now?: () => number;
}

/** The state of an {@link IpIntel}. */
export interface IntelStatus {
  /** Each database's metadata. */
  readonly databases: readonly MmdbMetadata[];
  /** Each feed's state. */
  readonly feeds: readonly FeedStatus[];
  /** Ranges per class in use. */
  readonly classes: Readonly<Record<string, number>>;
  /** Addresses in the lookup cache. */
  readonly cached: number;
}

/** IP intelligence: {@link lookup}, the feeds' refresh, its state. */
export interface IpIntel extends IntelLookup {
  /** The ranges in use for a class: its static ranges and its feeds' copies. */
  readonly ranges: (className: string) => readonly string[];
  /** Fetches every feed that is due (every feed with `force`), one at a time; the outcomes. Never throws. */
  readonly refresh: (options?: {
    readonly force?: boolean;
  }) => Promise<readonly FeedRefresh[]>;
  /** Refreshes the feeds on their intervals, in the background (timers that do not hold the process open). */
  readonly start: () => void;
  /** Stops the background refresh. */
  readonly stop: () => void;
  /** Re-reads the database files from their paths (after you download new ones). */
  readonly reload: () => Promise<void>;
  /** Its state. */
  readonly status: () => IntelStatus;
}

/** An empty record, shared. */
const EMPTY: IntelRecord = Object.freeze({ classes: Object.freeze([]) });

/** A field of a map value, if the value is a map. */
function get(value: MmdbValue | undefined, key: string): MmdbValue | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
    ? (value as Record<string, MmdbValue>)[key]
    : undefined;
}

/** A two-letter country code, upper case, or `undefined`. */
function countryCode(value: MmdbValue | undefined): string | undefined {
  return typeof value === "string" && /^[A-Z]{2}$/i.test(value)
    ? value.toUpperCase()
    : undefined;
}

/** The default record reader: MaxMind and DB-IP, then IPinfo Lite. */
export function extractIntel(record: MmdbValue): ExtractedIntel {
  const country =
    countryCode(get(get(record, "country"), "iso_code")) ??
    countryCode(get(get(record, "registered_country"), "iso_code")) ??
    countryCode(get(record, "country_code"));
  let asn: number | undefined;
  const maxmindAsn = get(record, "autonomous_system_number");
  if (typeof maxmindAsn === "number") asn = maxmindAsn;
  else {
    const ipinfo = get(record, "asn");
    if (typeof ipinfo === "string" && /^AS\d{1,10}$/i.test(ipinfo))
      asn = Number(ipinfo.slice(2));
    else if (typeof ipinfo === "number") asn = ipinfo;
  }
  const organization =
    get(record, "autonomous_system_organization") ?? get(record, "as_name");
  return {
    ...(country === undefined ? {} : { country }),
    ...(asn === undefined || !Number.isSafeInteger(asn) ? {} : { asn }),
    ...(typeof organization === "string"
      ? { asOrganization: organization }
      : {}),
  };
}

/**
 * IP intelligence over the operator's databases and feeds. Reads the
 * databases and each feed's last good copy (from `dir`) before it
 * resolves; fetches nothing until {@link IpIntel.start} or
 * {@link IpIntel.refresh}. Throws a `ConfigError` on bad options, and
 * `MmdbError` on a database that is not one.
 */
export async function ipIntel(options: IpIntelOptions = {}): Promise<IpIntel> {
  const cacheSize = options.cacheSize ?? 50_000;
  if (!Number.isSafeInteger(cacheSize) || cacheSize < 0) {
    throw new ConfigError(
      `ipIntel(): cacheSize must be a whole number, 0 or more; got ${String(cacheSize)}`,
    );
  }
  const logger: Logger = resolveLogger(
    options.logger,
    createLogger({ name: "bun-security" }),
  );
  const now = options.now ?? Date.now;
  const fetcher: FeedFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const extract = options.extract ?? extractIntel;
  const feeds = options.feeds ?? [];
  const ids = new Set<string>();
  for (const feed of feeds) {
    if (ids.has(feed.id))
      throw new ConfigError(
        `ipIntel(): two feeds named ${JSON.stringify(feed.id)}`,
      );
    ids.add(feed.id);
  }
  const statics: [string, ParsedCidr][] = [];
  for (const [name, list] of Object.entries(options.ranges ?? {})) {
    if (!/^[a-z0-9][\w.:-]{0,63}$/i.test(name)) {
      throw new ConfigError(
        `ipIntel(): class ${JSON.stringify(name)} must be 1-64 letters, digits, "_", ".", "-" or ":"`,
      );
    }
    for (const text of list) {
      const cidr = parseCidr(text);
      if (cidr === null)
        throw new ConfigError(
          isWholeFamilyRange(text)
            ? `ipIntel(): ranges.${name}: ${WHOLE_FAMILY_RANGE} (${JSON.stringify(text)}), so the class would name every client`
            : `ipIntel(): ranges.${name}: not an address or range: ${JSON.stringify(text)}`,
        );
      statics.push([name, cidr]);
    }
  }

  const sources = options.databases ?? [];
  let readers: MmdbReader[] = await Promise.all(
    sources.map((source) =>
      typeof source === "string" ? openMmdb(source) : source,
    ),
  );
  const states = feeds.map((feed) => new FeedState(feed));
  if (options.dir !== undefined) {
    const dir = options.dir;
    await Promise.all(states.map((state) => state.loadFrom(dir)));
  }

  /** What each database can give, from a probe of its metadata type, else assumed both. */
  const providesOf = (): IntelProvides => {
    let country = false;
    let asn = false;
    for (const reader of readers) {
      const type = reader.metadata.databaseType.toLowerCase();
      if (type.includes("asn")) asn = true;
      else if (type.includes("country") || type.includes("city"))
        country = true;
      else {
        country = true;
        asn = true;
      }
    }
    const classes = new Set<string>(statics.map(([name]) => name));
    for (const feed of feeds) classes.add(feed.class);
    return Object.freeze({ country, asn, classes });
  };
  let provided = providesOf();

  // The LRU: a Map in use order, the oldest first.
  const cache = new Map<string, IntelRecord>();
  let trie = new CidrTrie<string>();
  const counts: Record<string, number> = {};
  /** Rebuilds the class trie from the static ranges and every feed's copy in use. */
  const rebuild = () => {
    const next = new CidrTrie<string>();
    for (const key of Object.keys(counts)) delete counts[key];
    for (const [name, cidr] of statics) {
      next.insert(cidr, name);
      counts[name] = (counts[name] ?? 0) + 1;
    }
    for (const state of states) {
      for (const cidr of state.ranges) next.insert(cidr, state.feed.class);
      counts[state.feed.class] =
        (counts[state.feed.class] ?? 0) + state.ranges.length;
    }
    trie = next;
    cache.clear();
  };

  rebuild();

  /** Looks an address up, uncached. */
  const compute = (address: ParsedAddress): IntelRecord => {
    let country: string | undefined;
    let asn: number | undefined;
    let asOrganization: string | undefined;
    for (const reader of readers) {
      if (country !== undefined && asn !== undefined) break;
      let record: MmdbValue | undefined;
      try {
        record = reader.lookup(address);
      } catch (error) {
        logger.error("bun-security: an IP database lookup failed", {
          error,
          database: reader.metadata.databaseType,
        });
        continue;
      }
      if (record === undefined) continue;
      const found = extract(record, reader.metadata);
      country ??= found.country;
      if (asn === undefined && found.asn !== undefined) {
        asn = found.asn;
        asOrganization = found.asOrganization;
      }
    }
    const matched = trie.match(address);
    const classes =
      matched.length === 0
        ? EMPTY.classes
        : Object.freeze([...new Set(matched)].sort());
    if (country === undefined && asn === undefined && matched.length === 0)
      return EMPTY;
    return Object.freeze({
      classes,
      ...(country === undefined ? {} : { country }),
      ...(asn === undefined ? {} : { asn }),
      ...(asOrganization === undefined ? {} : { asOrganization }),
    });
  };

  const lookup = (input: ParsedAddress | string): IntelRecord => {
    const address = typeof input === "string" ? parseAddress(input) : input;
    if (address === null) return EMPTY;
    if (cacheSize === 0) return compute(address);
    const key = address.text;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const record = compute(address);
    cache.set(key, record);
    if (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return record;
  };

  let running = false;
  const refresh = async (
    refreshOptions: { readonly force?: boolean } = {},
  ): Promise<readonly FeedRefresh[]> => {
    const results: FeedRefresh[] = [];
    let changed = false;
    for (const state of states) {
      const time = now();
      if (!refreshOptions.force && state.dueAt > time) continue;
      const before = state.ranges;
      const result = await state.refresh(fetcher, time, options.dir);
      if (!result.ok) {
        logger.warn(
          `bun-security: range feed "${state.feed.id}" not refreshed; the last good copy is kept`,
          {
            feed: state.feed.id,
            reason: result.error,
            entries: result.entries,
          },
        );
      }
      if (state.ranges !== before) changed = true;
      results.push(result);
    }
    if (changed) rebuild();
    return results;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!running) return;
    const time = now();
    const next = states.reduce(
      (soonest, state) => Math.min(soonest, state.dueAt),
      Number.POSITIVE_INFINITY,
    );
    if (next === Number.POSITIVE_INFINITY) return;
    timer = setTimeout(
      () => {
        void refresh().finally(schedule);
      },
      Math.max(0, Math.min(next - time, 2_147_483_647)),
    );
    timer.unref?.();
  };

  return Object.freeze({
    lookup,
    provides: () => provided,
    ranges(className: string): readonly string[] {
      const out: string[] = [];
      for (const [name, cidr] of statics)
        if (name === className) out.push(cidr.text);
      for (const state of states) {
        if (state.feed.class === className)
          for (const cidr of state.ranges) out.push(cidr.text);
      }
      return out;
    },
    refresh,
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    async reload() {
      readers = await Promise.all(
        sources.map((source) =>
          typeof source === "string" ? openMmdb(source) : source,
        ),
      );
      provided = providesOf();
      cache.clear();
    },
    status: (): IntelStatus =>
      Object.freeze({
        databases: Object.freeze(readers.map((reader) => reader.metadata)),
        feeds: Object.freeze(states.map((state) => state.status())),
        classes: Object.freeze({ ...counts }),
        cached: cache.size,
      }),
  });
}
