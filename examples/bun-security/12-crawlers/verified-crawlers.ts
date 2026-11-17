/**
 * Verified crawlers: search engines walk dead links, old WordPress paths and
 * honeypots like a scanner does, so the engine verifies them and lets them
 * through what would ban a scanner, while a spoofed one is blocked.
 *
 * ```bash
 * bun 12-crawlers/verified-crawlers.ts
 * ```
 *
 * - A `User-Agent` with a crawler's token is only a claim. It is verified by
 *   the crawler's published ranges (here a static `crawler:google` class; in
 *   production `ipIntel({ feeds: crawlerFeeds(policy.crawlers) })`), or by
 *   reverse DNS confirmed forward (here a fixed resolver from `./testing`:
 *   no DNS is sent).
 * - The allowance lifts not-found counting, the probe set, honeypots, bot
 *   signals, challenges, per-address limits and automatic bans, for `GET`
 *   and `HEAD`. A `POST` is an ordinary client's.
 * - A claimant that fails verification is `crawler.spoofed`: blocked.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import type { Decision } from "@kingsleyweb/bun-security";
import { installSecurity } from "@kingsleyweb/bun-security/http";
import { ipIntel } from "@kingsleyweb/bun-security/intel";
import {
  CRAWLER_USER_AGENTS,
  staticCrawlerResolver,
} from "@kingsleyweb/bun-security/testing";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("verified crawlers");

const GOOGLEBOT = "66.249.66.1";
const BINGBOT = "157.55.39.10";

const decisions: Decision[] = [];
const security = createSecurity<BunRequest>({
  policy: {
    // A scanner's signature, enforced: 20 not-found answers a minute → a ban.
    countedRules: [
      {
        id: "not-found",
        event: "route.notFound",
        threshold: 20,
        window: "1m",
        duration: "1d",
      },
    ],
    requestRules: { managed: { mode: "enforce" } },
    deception: { honeypots: true },
    crawlers: { allow: ["google", "bing"] },
  },
  intel: await ipIntel({
    ranges: { "crawler:google": ["66.249.64.0/19"] },
    logger: () => {},
  }),
  resolver: staticCrawlerResolver({
    reverse: { [BINGBOT]: ["msnbot-157-55-39-10.search.msn.com"] },
    forward: { "msnbot-157-55-39-10.search.msn.com": [BINGBOT] },
  }),
  onDecision: (decision) => decisions.push(decision),
  logger: () => {},
});

const app = new BunHttpAdapter(0, { logger: () => {} });
await installSecurity(app, security, { logger: () => {} });
app.get("/", (_req, res) => res.send("home"));

/** Crawls `paths` as `crawler` from `client`; the statuses. */
async function crawl(
  client: string,
  crawler: string,
  paths: string[],
  method = "GET",
) {
  const statuses: number[] = [];
  for (const path of paths) {
    const response = await app.fetch(path, {
      method,
      remoteAddress: client,
      headers: { "user-agent": CRAWLER_USER_AGENTS[crawler] ?? crawler },
    });
    await response.body?.cancel();
    statuses.push(response.status);
  }
  return statuses;
}

const deadLinks = Array.from({ length: 60 }, (_, i) => `/blog/2019/post-${i}`);
const hazards = [...deadLinks, "/wp-admin/", "/.env", "/"];

/* ------------------------------------------------------------------ */
step(
  "Googlebot, verified by its ranges, crawls 60 dead links, /wp-admin/ and a honeypot",
);
const google = await crawl(GOOGLEBOT, "google", hazards);
show("statuses", [...new Set(google)]);
checkEqual("never refused: 404s, and the home page", google.at(-1), 200);
check("no 403 or 429", !google.some((s) => s === 403 || s === 429), google);
checkEqual("never banned", security.bans(), []);
const verified = decisions.find((d) => d.crawler?.id === "google");
show("its decisions carry", verified?.crawler);
checkEqual(
  "verified by its ranges",
  [verified?.crawler?.verified, verified?.crawler?.verifiedBy],
  [true, "ranges"],
);

/* ------------------------------------------------------------------ */
step("Bingbot, verified by reverse DNS confirmed forward");
const bing = await crawl(BINGBOT, "bing", ["/", "/blog/gone"]);
checkEqual("served", bing, [200, 404]);
checkEqual(
  "verified by rdns",
  decisions.find((d) => d.crawler?.id === "bing")?.crawler?.verifiedBy,
  "rdns",
);

/* ------------------------------------------------------------------ */
step("a spoofed Googlebot: the token, from an address that is not Google's");
const spoofed = await crawl("203.0.113.70", "google", ["/", "/pricing"]);
checkEqual("blocked", spoofed, [403, 403]);
checkEqual(
  "as crawler.spoofed",
  decisions.some(
    (d) =>
      d.crawler?.spoofed === true &&
      d.hits.some((h) => h.rule === "crawler.spoofed"),
  ),
  true,
);

/* ------------------------------------------------------------------ */
step("the same crawl as an ordinary client is banned");
const scanner = await crawl("203.0.113.80", "Mozilla/5.0", deadLinks);
show(
  "first refusal at",
  scanner.findIndex((s) => s === 403),
);
checkEqual(
  "banned at the 20th not-found",
  scanner.findIndex((s) => s === 403),
  20,
);

/* ------------------------------------------------------------------ */
step(
  "the allowance covers GET and HEAD: a crawler's POST is an ordinary client's",
);
const getProbe = decisions.find(
  (d) =>
    d.crawler?.id === "google" && d.hits.some((h) => h.rule === "probe:dotenv"),
);
show(
  "its GET /.env",
  getProbe?.hits.map((h) => `${h.rule}:${h.action}`),
);
checkEqual("the GET probe was only logged", getProbe?.action, "log");
await crawl(GOOGLEBOT, "google", ["/.env"], "POST");
const postProbe = decisions.at(-1);
show(
  "its POST /.env",
  postProbe?.hits.map((h) => `${h.rule}:${h.action}`),
);
checkEqual(
  "the POST probe is refused like anyone's",
  postProbe?.action,
  "block",
);

security.close();
summary();
