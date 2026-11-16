/**
 * The registry, the `crawlers` option and the crawler feeds (layers.md
 * L3.2): tokens matched as words in real crawlers' `User-Agent`s, domains on
 * label boundaries, the defaults (Q29), every check of the option, the
 * methods and paths covered, the crawler limit rule, and one feed per
 * allowed crawler that publishes a range file.
 */
import { describe, expect, it } from "bun:test";
import {
  CRAWLER_EXEMPTIONS,
  covered,
  crawlerLimitRule,
  crawlersOf,
  validateCrawlers,
} from "../../lib/crawlers/policy";
import {
  CRAWLER_IDS,
  CRAWLERS,
  DEFAULT_CRAWLERS,
  hasToken,
  underDomain,
} from "../../lib/crawlers/registry";
import { claimOf } from "../../lib/crawlers/request";
import { crawlerFeeds } from "../../lib/intel/crawlers";
import { compilePolicy } from "../../lib/policy/compile";
import { SecurityPolicyError } from "../../lib/policy/errors";

const UAS: [string, string | undefined][] = [
  [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "google",
  ],
  ["Googlebot-Image/1.0", "google"],
  [
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "google",
  ],
  [
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
    "bing",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
    "apple",
  ],
  ["DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)", "duckduckgo"],
  // Not in the default set: Google's special crawlers, Yandex, an AI crawler.
  ["AdsBot-Google (+http://www.google.com/adsbot.html)", undefined],
  [
    "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
    undefined,
  ],
  [
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    undefined,
  ],
  // A token inside a longer name is not the token.
  ["NotGooglebotAtAll/1.0", undefined],
  ["Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0", undefined],
];

describe("the registry", () => {
  it("knows its seven ids, and allows Google, Bing, Apple and DuckDuckGo by default", () => {
    expect(CRAWLER_IDS).toEqual([
      "google",
      "google-special",
      "bing",
      "apple",
      "duckduckgo",
      "yandex",
      "baidu",
    ]);
    expect(DEFAULT_CRAWLERS).toEqual(["google", "bing", "apple", "duckduckgo"]);
    expect(CRAWLERS.duckduckgo.rdns).toEqual([]);
    expect(CRAWLERS.yandex.ranges).toBeUndefined();
  });

  it("recognises real crawlers' User-Agents, as words, for the allowed crawlers only", () => {
    const compiled = crawlersOf(compilePolicy({}));
    for (const [ua, id] of UAS)
      expect([ua, claimOf(compiled, ua)?.id]).toEqual([ua, id]);
    const opted = crawlersOf(
      compilePolicy({ crawlers: { allow: ["yandex", "google-special"] } }),
    );
    expect(claimOf(opted, UAS[7]?.[0])?.id).toBe("yandex");
    expect(claimOf(opted, UAS[6]?.[0])?.id).toBe("google-special");
    expect(claimOf(opted, UAS[0]?.[0])).toBeUndefined();
  });

  it("matches tokens and domains on boundaries", () => {
    expect(hasToken("x Googlebot/2.1", "Googlebot")).toBe(true);
    expect(hasToken("Googlebot2", "Googlebot")).toBe(false);
    expect(underDomain("crawl-1.googlebot.com.", "googlebot.com")).toBe(true);
    expect(underDomain("googlebot.com", "googlebot.com")).toBe(true);
    expect(underDomain("evilgooglebot.com", "googlebot.com")).toBe(false);
    expect(underDomain("googlebot.com.evil.example", "googlebot.com")).toBe(
      false,
    );
  });
});

describe("the crawlers option", () => {
  it("compiles the defaults (Q29)", () => {
    const compiled = crawlersOf(compilePolicy({}));
    expect(compiled.mode).toBe("enforce");
    expect(compiled.allowed.map((c) => c.id)).toEqual([
      "google",
      "bing",
      "apple",
      "duckduckgo",
    ]);
    expect([...compiled.exempt]).toEqual([...CRAWLER_EXEMPTIONS]);
    expect([
      compiled.verify,
      compiled.spoofedAction,
      compiled.spoofedWeight,
    ]).toEqual(["ranges-then-rdns", "block", 5]);
    expect([
      covered(compiled, "GET", "/a"),
      covered(compiled, "HEAD", "/"),
      covered(compiled, "POST", "/a"),
    ]).toEqual([true, true, false]);
  });

  it("covers only its methods and paths", () => {
    const compiled = crawlersOf(
      compilePolicy({
        crawlers: {
          methods: ["GET"],
          paths: { include: ["/docs/**"], exclude: ["/docs/private/**"] },
        },
      }),
    );
    expect(covered(compiled, "GET", "/docs/a")).toBe(true);
    expect(covered(compiled, "HEAD", "/docs/a")).toBe(false);
    expect(covered(compiled, "GET", "/docs/private/x")).toBe(false);
    expect(covered(compiled, "GET", "/app")).toBe(false);
  });

  it("takes custom crawlers by id", () => {
    const compiled = crawlersOf(
      compilePolicy({
        crawlers: {
          allow: ["acme"],
          custom: [
            {
              id: "acme",
              tokens: ["AcmeBot"],
              rdns: ["crawl.acme.example"],
              ranges: "https://acme.example/r.json",
            },
          ],
        },
      }),
    );
    expect(
      claimOf(compiled, "Mozilla/5.0 (compatible; AcmeBot/1.0)")?.rdns,
    ).toEqual(["crawl.acme.example"]);
  });

  it("names every problem, with its path", () => {
    const paths = (input: unknown) =>
      validateCrawlers(input).map((issue) => issue.path.join("."));
    expect(
      paths({
        mode: "on",
        allow: ["altavista"],
        verify: "dns",
        methods: ["POST"],
        paths: { include: ["docs"], exclude: ["/a/***"] },
        exempt: ["everything"],
        limit: "lots",
        spoofed: { action: "ban", weight: 500, extra: 1 },
        custom: [
          { id: "google", tokens: [] },
          {
            id: "x",
            tokens: ["XBot"],
            ranges: "ftp://x",
            rdns: ["not a domain"],
          },
        ],
        other: true,
      }),
    ).toEqual([
      "crawlers.other",
      "crawlers.mode",
      "crawlers.custom.0.id",
      "crawlers.custom.0.tokens",
      "crawlers.custom.1.ranges",
      "crawlers.custom.1.rdns",
      "crawlers.allow.0",
      "crawlers.verify",
      "crawlers.methods",
      "crawlers.paths.include.0",
      "crawlers.paths.exclude.0",
      "crawlers.exempt.0",
      "crawlers.limit",
      "crawlers.spoofed.action",
      "crawlers.spoofed.weight",
      "crawlers.spoofed.extra",
    ]);
    expect(() =>
      compilePolicy({ crawlers: { verify: "dns" as never } }),
    ).toThrow(SecurityPolicyError);
    expect(validateCrawlers({ limit: "10/10ms" })[0]?.message).toBe(
      "its window must be at least a second",
    );
  });

  it("makes the crawler limit a limit rule keyed by the crawler, counting past allow entries", () => {
    expect(crawlerLimitRule(undefined)).toEqual({
      id: "crawler",
      limit: 3000,
      window: "1m",
      key: "crawler",
      evenWhenAllowed: true,
    });
    expect(crawlerLimitRule({ limit: "50/10s" })).toMatchObject({
      limit: 50,
      window: "10s",
    });
    expect(crawlerLimitRule({ limit: false })).toBeUndefined();
    expect(crawlerLimitRule({ mode: "off" })).toBeUndefined();
  });
});

describe("crawlerFeeds", () => {
  it("gives one feed per allowed crawler with a range file, class crawler:<id>, daily", () => {
    const feeds = crawlerFeeds();
    expect(
      feeds.map((feed) => [
        feed.id,
        feed.class,
        feed.url,
        feed.minEntries,
        feed.interval,
      ]),
    ).toEqual([
      [
        "crawler:google",
        "crawler:google",
        CRAWLERS.google.ranges ?? "",
        100,
        86_400_000,
      ],
      [
        "crawler:bing",
        "crawler:bing",
        CRAWLERS.bing.ranges ?? "",
        10,
        86_400_000,
      ],
      [
        "crawler:apple",
        "crawler:apple",
        CRAWLERS.apple.ranges ?? "",
        8,
        86_400_000,
      ],
      [
        "crawler:duckduckgo",
        "crawler:duckduckgo",
        CRAWLERS.duckduckgo.ranges ?? "",
        100,
        86_400_000,
      ],
    ]);
    expect(
      crawlerFeeds({
        allow: ["yandex", "acme"],
        custom: [
          {
            id: "acme",
            tokens: ["AcmeBot"],
            ranges: "https://acme.example/r.json",
          },
        ],
      }).map((feed) => feed.id),
    ).toEqual(["crawler:acme"]);
    expect(crawlerFeeds({ mode: "off" })).toEqual([]);
    expect(crawlerFeeds(undefined, { interval: "12h" })[0]?.interval).toBe(
      43_200_000,
    );
  });
});
