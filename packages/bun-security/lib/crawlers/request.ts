/**
 * A request's crawler claim (layers.md L3.2): which allowed crawler its
 * `User-Agent` names, what verification found, and whether the allowance
 * covers it (its method and path) — what each layer reads to decide what
 * the allowance lifts.
 */
import type { CompiledCrawlers, CrawlerExemption } from "./policy";
import type { CrawlerDefinition } from "./registry";
import { hasToken } from "./registry";
import type { CrawlerVerdict } from "./verify";

/** A claimant's state for one request. */
export interface CrawlerRequest {
  /** The crawler it claims to be. */
  readonly id: string;
  /** What verification found. */
  readonly verdict: CrawlerVerdict;
  /** Whether its method and path are within the allowance. */
  readonly covered: boolean;
  /** The allowance's mode: `enforce` lifts, `dryRun` only records. */
  readonly mode: "enforce" | "dryRun";
  /** What the allowance lifts. */
  readonly exempt: ReadonlySet<CrawlerExemption>;
}

/** The allowed crawler a `User-Agent` claims, if any. */
export function claimOf(
  compiled: CompiledCrawlers,
  userAgent: string | undefined,
): CrawlerDefinition | undefined {
  if (!userAgent || compiled.mode === "off") return undefined;
  for (const crawler of compiled.allowed) {
    for (const token of crawler.tokens) {
      if (hasToken(userAgent, token)) return crawler;
    }
  }
  return undefined;
}

/** Whether the allowance lifts `exemption` for this request: verified, covered, enforced and exempt. */
export function exempts(
  request: CrawlerRequest | undefined,
  exemption: CrawlerExemption,
): boolean {
  return (
    request !== undefined &&
    request.verdict.status === "verified" &&
    request.covered &&
    request.mode === "enforce" &&
    request.exempt.has(exemption)
  );
}
