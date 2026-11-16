/**
 * `@kingsleyweb/bun-security/intel`: IP intelligence (layers.md L5).
 *
 * - {@link ipIntel}: country and ASN from MaxMind DB files you supply, and
 *   classes (`tor`, `hosting`, …) from range feeds you configure; pass it
 *   to `createSecurity({ intel })` for the policy's `country`, `asn` and
 *   `class` conditions;
 * - {@link openMmdb}: the MaxMind DB reader, on its own;
 * - {@link rangeFeed}, {@link torExitFeed}: the feeds, fetched and verified
 *   on their intervals, the last good copy kept.
 *
 * No database or range list ships with the package.
 */
export { crawlerFeeds } from "./crawlers";
export {
  type ExtractedIntel,
  extractIntel,
  type IntelStatus,
  ipIntel,
  type IpIntel,
  type IpIntelOptions,
} from "./intel";
export {
  type MmdbMetadata,
  MmdbError,
  MmdbReader,
  type MmdbResult,
  type MmdbValue,
  openMmdb,
} from "./mmdb";
export {
  type FeedFetch,
  type FeedRefresh,
  type FeedStatus,
  rangeFeed,
  type RangeFeed,
  type RangeFeedOptions,
  type RangeFormat,
  TOR_BULK_EXIT_LIST_URL,
  torExitFeed,
} from "./ranges";
export type { IntelLookup, IntelProvides, IntelRecord } from "./types";
