/**
 * Bot and automation signals (layers.md L10.1): facts about a request that
 * add to its **risk** (per request, unlike the offence score, which is per
 * subject over time). None refuses alone: `challengeAt` is what turns a
 * risky enough request into a challenge, and it is unset by default.
 *
 * The policy's `botSignals` section turns them on; without it no signal is
 * read. They need only the request line and headers, so they run in the
 * early stage (or the single one).
 *
 * Kept beside the compiled policy (a `WeakMap`), as the request rules are,
 * so `compilePolicy` needs no change: `validateBotSignals` runs first.
 */
import type { RequestFacts } from "./facts";
import type { CompiledPolicy } from "../policy/compile";
import { compileGlob, globRefusal } from "../rules/glob";
import type { GlobMatcher } from "../rules/glob";

/** The signals bun-security reads. */
export type BotSignalName =
  | "noUserAgent"
  | "libraryUserAgent"
  | "headlessUserAgent"
  | "missingFetchMetadata"
  | "clientHintsMismatch";

/** Every signal, in the order they are read. */
export const BOT_SIGNALS: readonly BotSignalName[] = [
  "noUserAgent",
  "libraryUserAgent",
  "headlessUserAgent",
  "missingFetchMetadata",
  "clientHintsMismatch",
];

/** The policy's `botSignals` section (layers.md L10.1). */
export interface BotSignalsPolicy {
  /** `enforce` (the default) or `dryRun`: a dry run logs the challenge `challengeAt` would have made. */
  readonly mode?: "enforce" | "dryRun";
  /**
   * Each signal's risk points, `0` to turn one off. Default `1` each:
   * `noUserAgent` (none, or empty), `libraryUserAgent` (an HTTP library's or
   * a command-line tool's: curl, Wget, python-requests, Go's, Java's,
   * okhttp, axios, node-fetch, undici, Scrapy, libwww-perl),
   * `headlessUserAgent` (`HeadlessChrome`, PhantomJS),
   * `missingFetchMetadata` (a browser's `User-Agent` without the
   * `Sec-Fetch-Mode` every current browser sends, on a page request or a
   * `browserPaths` route), `clientHintsMismatch` (`Sec-CH-UA`, which only
   * Chromium sends, beside a `User-Agent` that is not Chromium's).
   */
  readonly weights?: { readonly [K in BotSignalName]?: number };
  /**
   * The risk at which the request is challenged (layers.md L10.2), a
   * positive number. Default: never; the signals only add to the
   * decision's `risk`.
   */
  readonly challengeAt?: number;
  /**
   * Path globs of browser-only routes, where a missing `Sec-Fetch-Mode`
   * counts whatever the `Accept` header says. Default none: it counts on a
   * page request (`text/html` first in `Accept`) only.
   */
  readonly browserPaths?: readonly string[];
}

/** One problem in the section: where, and what. */
export interface SignalIssue {
  /** The path below the policy's root. */
  readonly path: readonly (string | number)[];
  /** What is wrong. */
  readonly message: string;
}

/** The most `browserPaths` globs. */
const MAX_BROWSER_PATHS = 100;

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every problem in a policy's `botSignals` section (none when absent). */
export function validateBotSignals(input: unknown): SignalIssue[] {
  if (input === undefined) return [];
  const issues: SignalIssue[] = [];
  const at = (path: readonly (string | number)[], message: string) =>
    issues.push({ path: ["botSignals", ...path], message });
  if (!isRecord(input)) {
    at([], "must be an object");
    return issues;
  }
  for (const key of Object.keys(input)) {
    if (!["mode", "weights", "challengeAt", "browserPaths"].includes(key)) {
      at(
        [key],
        "is not a botSignals setting (mode, weights, challengeAt, browserPaths)",
      );
    }
  }
  if (
    input.mode !== undefined &&
    input.mode !== "enforce" &&
    input.mode !== "dryRun"
  ) {
    at(["mode"], `must be "enforce" or "dryRun"`);
  }
  if (input.weights !== undefined) {
    if (isRecord(input.weights)) {
      for (const [name, weight] of Object.entries(input.weights)) {
        if (!(BOT_SIGNALS as readonly string[]).includes(name)) {
          at(["weights", name], `is not a signal (${BOT_SIGNALS.join(", ")})`);
        } else if (
          typeof weight !== "number" ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 100
        ) {
          at(["weights", name], "must be a number from 0 to 100");
        }
      }
    } else {
      at(["weights"], "must be an object of signal weights");
    }
  }
  const challengeAt = input.challengeAt;
  if (
    challengeAt !== undefined &&
    (typeof challengeAt !== "number" ||
      !Number.isFinite(challengeAt) ||
      challengeAt <= 0)
  ) {
    at(["challengeAt"], "must be a positive number");
  }
  if (input.browserPaths !== undefined) {
    if (
      !Array.isArray(input.browserPaths) ||
      input.browserPaths.length > MAX_BROWSER_PATHS
    ) {
      at(
        ["browserPaths"],
        `must be a list of at most ${MAX_BROWSER_PATHS} path globs`,
      );
    } else {
      input.browserPaths.forEach((glob: unknown, index) => {
        const refusal =
          typeof glob !== "string" || !glob.startsWith("/")
            ? "must be a path glob starting with /"
            : globRefusal(glob);
        if (refusal !== undefined) at(["browserPaths", index], refusal);
      });
    }
  }
  return issues;
}

/** The section compiled. */
export interface CompiledBotSignals {
  /** Whether the policy turns the signals on. */
  readonly enabled: boolean;
  /** Whether a challenge is only logged. */
  readonly dryRun: boolean;
  /** Each signal's points. */
  readonly weights: Readonly<Record<BotSignalName, number>>;
  /** The risk at which the request is challenged, or `Infinity`. */
  readonly challengeAt: number;
  /** The browser-only routes. */
  readonly browserPaths: readonly GlobMatcher[];
}

/** The section compiled per policy. */
const COMPILED = new WeakMap<CompiledPolicy, CompiledBotSignals>();

/** A policy's signals, compiled once (the policy was validated). */
export function botSignalsOf(policy: CompiledPolicy): CompiledBotSignals {
  let compiled = COMPILED.get(policy);
  if (compiled === undefined) {
    const section = (policy.source as { botSignals?: BotSignalsPolicy })
      .botSignals;
    const weights = Object.fromEntries(
      BOT_SIGNALS.map((name) => [name, section?.weights?.[name] ?? 1]),
    ) as Record<BotSignalName, number>;
    compiled = {
      enabled: section !== undefined,
      dryRun: section?.mode === "dryRun",
      weights,
      challengeAt: section?.challengeAt ?? Number.POSITIVE_INFINITY,
      browserPaths: (section?.browserPaths ?? []).map((glob) =>
        compileGlob(glob),
      ),
    };
    COMPILED.set(policy, compiled);
  }
  return compiled;
}

/** HTTP libraries' and command-line tools' `User-Agent`s (prefix or token). */
const LIBRARY_UA =
  /^(?:curl|wget|python-requests|python-urllib|python-httpx|aiohttp|go-http-client|java|okhttp|axios|node-fetch|undici|got|scrapy|libwww-perl|httpie|apache-httpclient|ruby|guzzlehttp)\b/i;

/** Headless browsers' markers. */
const HEADLESS_UA = /headlesschrome|phantomjs/i;

/** A browser's `User-Agent`: `Mozilla/5.0` and an engine token. */
const BROWSER_UA = /^Mozilla\/5\.0 .*(?:AppleWebKit|Gecko)\//;

/** Chromium's tokens. */
const CHROMIUM_UA = /(?:Chrome|Chromium|CriOS|Edg|OPR)\//;

/** Whether the client asked for HTML first (a page request). */
function pageRequest(accept: string | undefined): boolean {
  if (!accept) return false;
  const html = accept.indexOf("text/html");
  return (
    html !== -1 && (!accept.includes("json") || html < accept.indexOf("json"))
  );
}

/** The signals a request shows, each with its points (only those above 0). */
export function readSignals(
  compiled: CompiledBotSignals,
  facts: RequestFacts,
): { readonly name: BotSignalName; readonly points: number }[] {
  const { weights } = compiled;
  const found: { name: BotSignalName; points: number }[] = [];
  const add = (name: BotSignalName) => {
    if (weights[name] > 0) found.push({ name, points: weights[name] });
  };
  const ua = facts.headers["user-agent"]?.trim() ?? "";
  if (ua === "") add("noUserAgent");
  else if (LIBRARY_UA.test(ua)) add("libraryUserAgent");
  if (HEADLESS_UA.test(ua)) add("headlessUserAgent");
  const browser = BROWSER_UA.test(ua) && !HEADLESS_UA.test(ua);
  if (
    browser &&
    facts.headers["sec-fetch-mode"] === undefined &&
    (pageRequest(facts.headers.accept) ||
      compiled.browserPaths.some((glob) => glob(facts.path)))
  ) {
    add("missingFetchMetadata");
  }
  if (
    facts.headers["sec-ch-ua"] !== undefined &&
    ua !== "" &&
    !CHROMIUM_UA.test(ua)
  ) {
    add("clientHintsMismatch");
  }
  return found;
}
