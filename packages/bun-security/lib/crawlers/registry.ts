/**
 * The crawler registry (layers.md L3.2): how each search engine's crawler
 * is recognised and verified — its `User-Agent` tokens, its published
 * range file, its reverse-DNS domains — never its addresses, which come in
 * at run time (the range files, through `./intel`'s feeds; DNS).
 *
 * Every method below was read from the engine's own documentation on
 * 2026-11-16 (PR-S12):
 *
 * - Google: developers.google.com/search/docs/crawling-indexing/verifying-googlebot
 *   (rDNS `googlebot.com`, `google.com`, then a forward lookup; the range
 *   files), …/google-common-crawlers and …/google-special-case-crawlers (the
 *   tokens). The user-triggered fetchers (`googleusercontent.com`) are left
 *   out on purpose: anyone can make Google fetch a URL through them.
 * - Bing: blogs.bing.com/webmaster, "How to verify that Bingbot is Bingbot"
 *   (rDNS `search.msn.com`, then a forward lookup); `www.bing.com/toolbox/bingbot.json`.
 * - Apple: support.apple.com/en-us/119829 (rDNS `applebot.apple.com`, then
 *   a forward lookup; `search.developer.apple.com/applebot.json`).
 * - DuckDuckGo: duckduckgo.com/duckduckgo-help-pages/results/duckduckbot
 *   (the range file `duckduckgo.com/duckduckbot.json`; no reverse DNS).
 * - Yandex: yandex.com/support/webmaster/robot-workings/check-yandex-robots.html
 *   (rDNS `yandex.ru`, `yandex.net`, `yandex.com`, then a forward lookup;
 *   no address list).
 * - Baidu: help.baidu.com, Baiduspider (rDNS `baidu.com`, `baidu.jp`, then
 *   a forward lookup; no address list).
 */

/** A crawler the registry knows, or one a policy adds (`custom`). */
export interface CrawlerDefinition {
  /** Its id: `google`, `bing`, … or the policy's own. */
  readonly id: string;
  /** Tokens its `User-Agent` carries (`Googlebot`): any one makes a request a claimant. */
  readonly tokens: readonly string[];
  /** Domains its reverse DNS names end in (`googlebot.com`); none: it cannot be verified by DNS. */
  readonly rdns: readonly string[];
  /** Where its range file is published, for `crawlerFeeds()`; none: it publishes none. */
  readonly ranges?: string;
  /** The fewest ranges a good copy of its file holds. */
  readonly minEntries?: number;
}

/** The registry's ids. */
export type CrawlerId =
  | "google"
  | "google-special"
  | "bing"
  | "apple"
  | "duckduckgo"
  | "yandex"
  | "baidu";

/** The registry: methods, not data. */
export const CRAWLERS: Readonly<Record<CrawlerId, CrawlerDefinition>> =
  Object.freeze({
    google: Object.freeze({
      id: "google",
      tokens: Object.freeze([
        "Googlebot",
        "Googlebot-Image",
        "Googlebot-Video",
        "Googlebot-News",
        "Storebot-Google",
        "Google-InspectionTool",
        "GoogleOther",
        "GoogleOther-Image",
        "GoogleOther-Video",
        "Google-CloudVertexBot",
      ]),
      rdns: Object.freeze(["googlebot.com", "google.com"]),
      ranges:
        "https://developers.google.com/static/crawling/ipranges/common-crawlers.json",
      minEntries: 100,
    }),
    "google-special": Object.freeze({
      id: "google-special",
      tokens: Object.freeze([
        "APIs-Google",
        "AdsBot-Google-Mobile",
        "AdsBot-Google",
        "Mediapartners-Google",
        "Google-Safety",
      ]),
      rdns: Object.freeze(["google.com"]),
      ranges:
        "https://developers.google.com/static/crawling/ipranges/special-crawlers.json",
      minEntries: 100,
    }),
    bing: Object.freeze({
      id: "bing",
      tokens: Object.freeze(["bingbot"]),
      rdns: Object.freeze(["search.msn.com"]),
      ranges: "https://www.bing.com/toolbox/bingbot.json",
      minEntries: 10,
    }),
    apple: Object.freeze({
      id: "apple",
      tokens: Object.freeze(["Applebot"]),
      rdns: Object.freeze(["applebot.apple.com"]),
      ranges: "https://search.developer.apple.com/applebot.json",
      minEntries: 8,
    }),
    duckduckgo: Object.freeze({
      id: "duckduckgo",
      tokens: Object.freeze(["DuckDuckBot"]),
      rdns: Object.freeze([]),
      ranges: "https://duckduckgo.com/duckduckbot.json",
      minEntries: 100,
    }),
    yandex: Object.freeze({
      id: "yandex",
      tokens: Object.freeze(["YandexBot"]),
      rdns: Object.freeze(["yandex.ru", "yandex.net", "yandex.com"]),
    }),
    baidu: Object.freeze({
      id: "baidu",
      tokens: Object.freeze(["Baiduspider"]),
      rdns: Object.freeze(["baidu.com", "baidu.jp"]),
    }),
  });

/** Every registry id. */
export const CRAWLER_IDS: readonly CrawlerId[] = Object.freeze(
  Object.keys(CRAWLERS) as CrawlerId[],
);

/** The crawlers allowed by default (Q29; DuckDuckGo's source confirmed in PR-S12). */
export const DEFAULT_CRAWLERS: readonly CrawlerId[] = Object.freeze([
  "google",
  "bing",
  "apple",
  "duckduckgo",
]);

/** Whether `ua` carries `token` as a word (not inside a longer name). */
export function hasToken(ua: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const at = ua.indexOf(token, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : ua.charAt(at - 1);
    const after = ua.charAt(at + token.length);
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return true;
    from = at + 1;
  }
}

/** Whether `host` is `domain` or under it. */
export function underDomain(host: string, domain: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  const suffix = domain.toLowerCase();
  return name === suffix || name.endsWith(`.${suffix}`);
}
