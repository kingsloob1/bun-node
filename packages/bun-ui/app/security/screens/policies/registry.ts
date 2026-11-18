/**
 * What the policy screens know of bun-security's crawler allowance without
 * importing it (the app may import its contract only): the registry's ids,
 * the default allowed set and the series' outcomes. A bun-ui test checks
 * each against bun-security's own (`CRAWLER_IDS`, `DEFAULT_CRAWLERS`,
 * `CRAWLER_OUTCOMES`).
 */

/** The crawler registry's ids, in bun-security's order (`CRAWLER_IDS`). */
export const CRAWLER_REGISTRY = [
  "google",
  "google-special",
  "bing",
  "apple",
  "duckduckgo",
  "yandex",
  "baidu",
] as const;

/** The crawlers allowed when a policy names none (`DEFAULT_CRAWLERS`). */
export const DEFAULT_ALLOWED = [
  "google",
  "bing",
  "apple",
  "duckduckgo",
] as const;

/** The outcomes the series counts, in a table's column order. */
export const CRAWLER_OUTCOMES = [
  "request",
  "not-found",
  "limited",
  "probe",
  "honeypot",
  "spoofed",
] as const;
