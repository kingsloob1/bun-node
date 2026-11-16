/**
 * The policy's `crawlers` option (layers.md L3.2): which verified crawlers
 * get the allowance, how they are verified, where and for what methods,
 * which layers the allowance lifts, their own limit, and what a spoofed
 * claimant gets. On by default (Q29): Google, Bing, Apple and DuckDuckGo,
 * `GET` and `HEAD`, every path, every exemption, `ranges-then-rdns`.
 *
 * Kept beside the compiled policy (a `WeakMap`), as the request rules
 * are; validated through one call in `policy/schema.ts`.
 */
import { toDurationMs } from "@kingsleyweb/bun-common";
import type { Duration } from "@kingsleyweb/bun-common";
import type { CompiledPolicy } from "../policy/compile";
import type { LimitRule } from "../policy/types";
import { compileGlob, globRefusal } from "../rules/glob";
import type { GlobMatcher } from "../rules/glob";
import { CRAWLER_IDS, CRAWLERS, DEFAULT_CRAWLERS } from "./registry";
import type { CrawlerDefinition } from "./registry";

/** What the allowance can lift, for a verified crawler on its paths and methods. */
export type CrawlerExemption =
  | "notFound"
  | "probeRules"
  | "honeypots"
  | "botSignals"
  | "challenges"
  | "hostingClass"
  | "geo"
  | "perIpLimits"
  | "autoBans";

/** Every exemption, the default set. */
export const CRAWLER_EXEMPTIONS: readonly CrawlerExemption[] = Object.freeze([
  "notFound",
  "probeRules",
  "honeypots",
  "botSignals",
  "challenges",
  "hostingClass",
  "geo",
  "perIpLimits",
  "autoBans",
]);

/** How a claimant is verified. */
export type CrawlerVerifyMethod = "ranges" | "rdns" | "ranges-then-rdns";

/** A crawler of the policy's own. */
export interface CustomCrawler {
  /** Its id: letters, digits, `_`, `.` and `-`, not a registry id. */
  readonly id: string;
  /** Tokens its `User-Agent` carries. */
  readonly tokens: readonly string[];
  /** Its published range file's URL, read by `crawlerFeeds()` (`./intel`). */
  readonly ranges?: string;
  /** Domains its reverse DNS names end in. */
  readonly rdns?: readonly string[];
}

/** The `crawlers` option. */
export interface CrawlersPolicy {
  /** `enforce` (the default), `dryRun` (evaluated and recorded, nothing lifted) or `off` (no claimant is looked at). */
  readonly mode?: "enforce" | "dryRun" | "off";
  /** The crawler ids given the allowance. Default `["google", "bing", "apple", "duckduckgo"]`. */
  readonly allow?: readonly string[];
  /** How a claimant is verified. Default `"ranges-then-rdns"`. */
  readonly verify?: CrawlerVerifyMethod;
  /** The methods the allowance covers: `GET`, `HEAD`, `OPTIONS` at most. Default `["GET", "HEAD"]`. */
  readonly methods?: readonly ("GET" | "HEAD" | "OPTIONS")[];
  /** The paths it covers (globs). Default every path. */
  readonly paths?: {
    /** Covered paths. Default `["/**"]`. */
    readonly include?: readonly string[];
    /** Paths never covered, though included. Default none. */
    readonly exclude?: readonly string[];
  };
  /** What it lifts. Default every exemption. */
  readonly exempt?: readonly CrawlerExemption[];
  /**
   * Each verified crawler's own limit across its addresses, in place of the
   * per-address limits (`perIpLimits`): `"<n>/<window>"`, or `false` for
   * none. Default `"3000/1m"`. It counts even past an allow entry.
   */
  readonly limit?: string | false;
  /** What a spoofed claimant (a crawler's token, failing verification) gets. Default `{ action: "block", weight: 5 }`. */
  readonly spoofed?: {
    /** `block` (the default), `challenge`, `drop` or `log`. */
    readonly action?: "log" | "block" | "challenge" | "drop";
    /** Its offence weight for the ladder. Default `5`. */
    readonly weight?: number;
  };
  /** Crawlers of the policy's own (an AI crawler opted in, an in-house indexer). */
  readonly custom?: readonly CustomCrawler[];
}

/** One problem: where, and what. */
export interface CrawlerIssue {
  /** The path below the policy's root. */
  readonly path: readonly (string | number)[];
  /** What is wrong. */
  readonly message: string;
}

/** A crawler id. */
const ID_RE = /^[a-z0-9][\w.-]{0,63}$/i;

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `"3000/1m"` as a count and a window, or why not. */
export function parseCrawlerLimit(
  text: string,
): { limit: number; window: Duration } | string {
  const slash = text.indexOf("/");
  const count = Number(text.slice(0, slash));
  const window = text.slice(slash + 1);
  if (slash < 1 || !Number.isSafeInteger(count) || count < 1) {
    return `must be "<count>/<window>" ("3000/1m"); got ${JSON.stringify(text)}`;
  }
  try {
    if (toDurationMs(window as Duration, "crawlers.limit") < 1000) {
      return "its window must be at least a second";
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return { limit: count, window: window as Duration };
}

/** Every problem in a policy's `crawlers` option (none when absent). */
export function validateCrawlers(input: unknown): CrawlerIssue[] {
  if (input === undefined) return [];
  const issues: CrawlerIssue[] = [];
  const at = (path: readonly (string | number)[], message: string) =>
    issues.push({ path: ["crawlers", ...path], message });
  if (!isRecord(input)) {
    at([], "must be an object");
    return issues;
  }
  const keys = [
    "mode",
    "allow",
    "verify",
    "methods",
    "paths",
    "exempt",
    "limit",
    "spoofed",
    "custom",
  ];
  for (const key of Object.keys(input)) {
    if (!keys.includes(key))
      at([key], `is not a crawlers setting (${keys.join(", ")})`);
  }
  if (
    input.mode !== undefined &&
    !["enforce", "dryRun", "off"].includes(input.mode as string)
  ) {
    at(["mode"], 'must be "enforce", "dryRun" or "off"');
  }
  const customIds = new Set<string>();
  if (input.custom !== undefined) {
    if (!Array.isArray(input.custom) || input.custom.length > 64) {
      at(["custom"], "must be a list of at most 64 crawlers");
    } else {
      input.custom.forEach((crawler: unknown, i: number) => {
        if (!isRecord(crawler)) {
          at(["custom", i], "must be an object");
          return;
        }
        if (typeof crawler.id !== "string" || !ID_RE.test(crawler.id)) {
          at(
            ["custom", i, "id"],
            "must be an id (letters, digits, _, . and -)",
          );
        } else if (
          (CRAWLER_IDS as readonly string[]).includes(crawler.id) ||
          customIds.has(crawler.id)
        ) {
          at(["custom", i, "id"], `${JSON.stringify(crawler.id)} is taken`);
        } else {
          customIds.add(crawler.id);
        }
        if (
          !Array.isArray(crawler.tokens) ||
          crawler.tokens.length === 0 ||
          crawler.tokens.some(
            (t: unknown) =>
              typeof t !== "string" || t.length < 3 || t.length > 64,
          )
        ) {
          at(
            ["custom", i, "tokens"],
            "must be 1 or more tokens of 3 to 64 characters",
          );
        }
        if (crawler.ranges !== undefined) {
          let ok = false;
          try {
            ok = ["http:", "https:"].includes(
              new URL(crawler.ranges as string).protocol,
            );
          } catch {
            ok = false;
          }
          if (!ok)
            at(["custom", i, "ranges"], "must be an http: or https: URL");
        }
        if (
          crawler.rdns !== undefined &&
          (!Array.isArray(crawler.rdns) ||
            crawler.rdns.some(
              (d: unknown) =>
                typeof d !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d),
            ))
        ) {
          at(["custom", i, "rdns"], "must be a list of domains");
        }
        for (const key of Object.keys(crawler)) {
          if (!["id", "tokens", "ranges", "rdns"].includes(key))
            at(["custom", i, key], "is not a custom crawler setting");
        }
      });
    }
  }
  if (input.allow !== undefined) {
    if (!Array.isArray(input.allow))
      at(["allow"], "must be a list of crawler ids");
    else {
      input.allow.forEach((id: unknown, i: number) => {
        if (
          typeof id !== "string" ||
          (!(CRAWLER_IDS as readonly string[]).includes(id) &&
            !customIds.has(id))
        ) {
          at(
            ["allow", i],
            `must be a registry id (${CRAWLER_IDS.join(", ")}) or a custom crawler's`,
          );
        }
      });
    }
  }
  if (
    input.verify !== undefined &&
    !["ranges", "rdns", "ranges-then-rdns"].includes(input.verify as string)
  ) {
    at(["verify"], 'must be "ranges", "rdns" or "ranges-then-rdns"');
  }
  if (input.methods !== undefined) {
    if (
      !Array.isArray(input.methods) ||
      input.methods.length === 0 ||
      input.methods.some(
        (m: unknown) => !["GET", "HEAD", "OPTIONS"].includes(m as string),
      )
    ) {
      at(["methods"], "must list GET, HEAD or OPTIONS (never more)");
    }
  }
  if (input.paths !== undefined) {
    if (!isRecord(input.paths)) at(["paths"], "must be { include, exclude }");
    else {
      for (const side of ["include", "exclude"] as const) {
        const list = input.paths[side];
        if (list === undefined) continue;
        if (!Array.isArray(list) || list.length > 100) {
          at(["paths", side], "must be a list of at most 100 path globs");
          continue;
        }
        list.forEach((glob: unknown, i: number) => {
          const refusal =
            typeof glob !== "string" || !glob.startsWith("/")
              ? "must be a path glob starting with /"
              : globRefusal(glob);
          if (refusal !== undefined) at(["paths", side, i], refusal);
        });
      }
    }
  }
  if (input.exempt !== undefined) {
    if (!Array.isArray(input.exempt))
      at(["exempt"], "must be a list of exemptions");
    else {
      input.exempt.forEach((name: unknown, i: number) => {
        if (!(CRAWLER_EXEMPTIONS as readonly unknown[]).includes(name)) {
          at(["exempt", i], `must be one of ${CRAWLER_EXEMPTIONS.join(", ")}`);
        }
      });
    }
  }
  if (input.limit !== undefined && input.limit !== false) {
    const parsed =
      typeof input.limit === "string"
        ? parseCrawlerLimit(input.limit)
        : "must be a string or false";
    if (typeof parsed === "string") at(["limit"], parsed);
  }
  if (input.spoofed !== undefined) {
    if (!isRecord(input.spoofed)) at(["spoofed"], "must be { action, weight }");
    else {
      const { action, weight } = input.spoofed;
      if (
        action !== undefined &&
        !["log", "block", "challenge", "drop"].includes(action as string)
      ) {
        at(
          ["spoofed", "action"],
          'must be "log", "block", "challenge" or "drop"',
        );
      }
      if (
        weight !== undefined &&
        (typeof weight !== "number" ||
          !Number.isFinite(weight) ||
          weight < 0 ||
          weight > 100)
      ) {
        at(["spoofed", "weight"], "must be a number from 0 to 100");
      }
      for (const key of Object.keys(input.spoofed)) {
        if (key !== "action" && key !== "weight")
          at(["spoofed", key], "is not a spoofed setting");
      }
    }
  }
  return issues;
}

/** The option compiled. */
export interface CompiledCrawlers {
  /** `enforce`, `dryRun` or `off`. */
  readonly mode: "enforce" | "dryRun" | "off";
  /** The allowed crawlers. */
  readonly allowed: readonly CrawlerDefinition[];
  /** How claimants are verified. */
  readonly verify: CrawlerVerifyMethod;
  /** Covered methods. */
  readonly methods: ReadonlySet<string>;
  /** Covered paths. */
  readonly include: readonly GlobMatcher[];
  /** Excluded paths. */
  readonly exclude: readonly GlobMatcher[];
  /** What the allowance lifts. */
  readonly exempt: ReadonlySet<CrawlerExemption>;
  /** The spoofed claimant's action. */
  readonly spoofedAction: "log" | "block" | "challenge" | "drop";
  /** The spoofed claimant's offence weight. */
  readonly spoofedWeight: number;
}

/** The option compiled per policy. */
const COMPILED = new WeakMap<CompiledPolicy, CompiledCrawlers>();

/** The source option of a policy. */
function sourceOf(policy: CompiledPolicy): CrawlersPolicy | undefined {
  return (policy.source as { crawlers?: CrawlersPolicy }).crawlers;
}

/** A policy's crawler allowance, compiled once (the policy was validated). */
export function crawlersOf(policy: CompiledPolicy): CompiledCrawlers {
  let compiled = COMPILED.get(policy);
  if (compiled === undefined) {
    const source = sourceOf(policy) ?? {};
    const custom = new Map<string, CrawlerDefinition>(
      (source.custom ?? []).map((crawler) => [
        crawler.id,
        Object.freeze({
          id: crawler.id,
          tokens: Object.freeze([...crawler.tokens]),
          rdns: Object.freeze([...(crawler.rdns ?? [])]),
          ...(crawler.ranges === undefined ? {} : { ranges: crawler.ranges }),
        }),
      ]),
    );
    const allowed = (source.allow ?? DEFAULT_CRAWLERS).map(
      (id) =>
        (CRAWLERS as Record<string, CrawlerDefinition>)[id] ?? custom.get(id),
    );
    compiled = Object.freeze({
      mode: source.mode ?? "enforce",
      allowed: Object.freeze(
        allowed.filter((c): c is CrawlerDefinition => c !== undefined),
      ),
      verify: source.verify ?? "ranges-then-rdns",
      methods: new Set(source.methods ?? ["GET", "HEAD"]),
      include: (source.paths?.include ?? ["/**"]).map((glob) =>
        compileGlob(glob, true),
      ),
      exclude: (source.paths?.exclude ?? []).map((glob) =>
        compileGlob(glob, true),
      ),
      exempt: new Set(source.exempt ?? CRAWLER_EXEMPTIONS),
      spoofedAction: source.spoofed?.action ?? "block",
      spoofedWeight: source.spoofed?.weight ?? 5,
    });
    COMPILED.set(policy, compiled);
  }
  return compiled;
}

/**
 * The crawler limit as a limit rule (id `crawler`, keyed by the verified
 * crawler's id, counting past allow entries), or none: the policy compiler
 * adds it beside the presets.
 */
export function crawlerLimitRule(
  source: CrawlersPolicy | undefined,
): LimitRule | undefined {
  if (source?.mode === "off" || source?.limit === false) return undefined;
  const parsed = parseCrawlerLimit(source?.limit ?? "3000/1m");
  if (typeof parsed === "string") return undefined;
  return Object.freeze({
    id: "crawler",
    limit: parsed.limit,
    window: parsed.window,
    key: "crawler",
    evenWhenAllowed: true,
  });
}

/** Whether a request's method and path are within the allowance. */
export function covered(
  compiled: CompiledCrawlers,
  method: string,
  path: string,
): boolean {
  return (
    compiled.methods.has(method.toUpperCase()) &&
    compiled.include.some((glob) => glob(path)) &&
    !compiled.exclude.some((glob) => glob(path))
  );
}
