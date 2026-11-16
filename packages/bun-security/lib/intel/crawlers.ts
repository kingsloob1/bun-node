/**
 * The verified crawlers' range files as feeds (layers.md L3.2): one
 * `rangeFeed` per allowed crawler that publishes a file, class
 * `crawler:<id>`, fetched daily, the last good copy kept, refused when it
 * holds fewer than the crawler's minimum entries. Give them to `ipIntel()`
 * beside your other feeds, and the same `intel` to `createSecurity()`.
 *
 * ```ts
 * const intel = await ipIntel({ feeds: crawlerFeeds(policy.crawlers), dir });
 * ```
 */
import type { CrawlersPolicy } from "../crawlers/policy";
import { CRAWLERS, DEFAULT_CRAWLERS } from "../crawlers/registry";
import type { CrawlerDefinition } from "../crawlers/registry";
import { rangeFeed } from "./ranges";
import type { RangeFeed, RangeFeedOptions } from "./ranges";

/**
 * The range feeds of a policy's allowed crawlers (its `crawlers` option;
 * the default set without one): each crawler that publishes a range file,
 * the registry's or a `custom` one's. `overrides` apply to every feed (an
 * `interval`, a `timeoutMs`).
 */
export function crawlerFeeds(
  crawlers?: CrawlersPolicy,
  overrides: Partial<Omit<RangeFeedOptions, "id" | "class" | "url">> = {},
): RangeFeed[] {
  if (crawlers?.mode === "off") return [];
  const custom = new Map<string, CrawlerDefinition>(
    (crawlers?.custom ?? []).map((crawler) => [
      crawler.id,
      {
        id: crawler.id,
        tokens: crawler.tokens,
        rdns: crawler.rdns ?? [],
        ...(crawler.ranges === undefined ? {} : { ranges: crawler.ranges }),
      },
    ]),
  );
  const feeds: RangeFeed[] = [];
  for (const id of crawlers?.allow ?? DEFAULT_CRAWLERS) {
    const crawler =
      (CRAWLERS as Record<string, CrawlerDefinition>)[id] ?? custom.get(id);
    if (crawler?.ranges === undefined) continue;
    feeds.push(
      rangeFeed({
        id: `crawler:${crawler.id}`,
        class: `crawler:${crawler.id}`,
        url: crawler.ranges,
        format: "json",
        interval: "1d",
        minEntries: crawler.minEntries ?? 1,
        ...overrides,
      }),
    );
  }
  return feeds;
}
