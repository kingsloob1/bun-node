/**
 * The request rules' part of the policy format (layers.md L7): rules as
 * data, a condition over a request's facts and what to do when it holds.
 *
 * ```jsonc
 * {
 *   "id": "block-sqlmap",
 *   "when": { "any": [
 *     { "path": { "glob": "/**\/.env*" } },
 *     { "header": "user-agent", "contains": "sqlmap", "ignoreCase": true }
 *   ] },
 *   "action": "block", "weight": 5
 * }
 * ```
 */
import type { Duration } from "@kingsleyweb/bun-common";

/** A comparison on a number: exactly one of its keys. */
export interface NumberMatcher {
  /** Equal to. */
  readonly equals?: number;
  /** Greater than. */
  readonly gt?: number;
  /** At least. */
  readonly gte?: number;
  /** Less than. */
  readonly lt?: number;
  /** At most. */
  readonly lte?: number;
}

/**
 * A test on a string target: exactly one of `equals`, `in`, `prefix`,
 * `suffix`, `contains`, `glob`, `regex`, `exists` or `length`, with
 * `ignoreCase` beside it.
 */
export interface StringMatcher {
  /** The whole value equals this. */
  readonly equals?: string;
  /** The whole value is one of these (at most 1,000). */
  readonly in?: readonly string[];
  /** The value starts with this. */
  readonly prefix?: string;
  /** The value ends with this. */
  readonly suffix?: string;
  /** The value contains this. */
  readonly contains?: string;
  /**
   * A glob over the value (`*`, `**`, `?`), matched without regular
   * expressions: the safe choice for paths.
   */
  readonly glob?: string;
  /**
   * A regular expression, accepted only through the validator (no
   * backreferences, lookarounds or nested quantifiers; see
   * `regexRefusal`); it reads at most the first `maxRegexInput` characters.
   */
  readonly regex?: string;
  /** The target is present (`true`) or absent (`false`). */
  readonly exists?: boolean;
  /** A comparison on the value's length, in characters. */
  readonly length?: NumberMatcher;
  /**
   * Fold case on both sides. Default `true` for `path` and `rawPath` (the
   * router matches paths case-insensitively by default), `false` elsewhere.
   */
  readonly ignoreCase?: boolean;
}

/** A test on the client's address: exactly one of its keys. */
export interface AddressMatcher {
  /** The address is in one of these ranges (`"203.0.113.0/24"`). */
  readonly cidr?: string | readonly string[];
}

/**
 * One test on one part of the request. Early-stage targets: `method`,
 * `path` (the canonical path), `rawPath`, `query` (the whole query string),
 * `queryParam` (any value of one parameter), `header` (one header),
 * `anyHeader` (any header's value), `cookie` (whether a cookie is sent:
 * `exists` only), `client` (the address), `contentLength`, `headerCount`.
 * Route-stage targets: `routeKey` (the matched route) and the caller's
 * `user`, `session`, `tenant` and `apiKey`, so a rule using them runs once
 * the route and `identify()` are known.
 */
export type RuleMatch =
  | { readonly method: StringMatcher }
  | { readonly path: StringMatcher }
  | { readonly rawPath: StringMatcher }
  | { readonly query: StringMatcher }
  | ({ readonly queryParam: string } & StringMatcher)
  | ({ readonly header: string } & StringMatcher)
  | { readonly anyHeader: StringMatcher }
  | { readonly cookie: string; readonly exists: boolean }
  | { readonly client: AddressMatcher }
  | { readonly contentLength: NumberMatcher }
  | { readonly headerCount: NumberMatcher }
  | { readonly routeKey: StringMatcher }
  | { readonly user: StringMatcher }
  | { readonly session: StringMatcher }
  | { readonly tenant: StringMatcher }
  | { readonly apiKey: StringMatcher };

/** A rule's condition: a test, or `all`, `any` and `not` over conditions. */
export type RuleCondition =
  | RuleMatch
  | { readonly all: readonly RuleCondition[] }
  | { readonly any: readonly RuleCondition[] }
  | { readonly not: RuleCondition };

/** What a rule does when its condition holds. */
export type RequestRuleAction = "log" | "block" | "challenge" | "ban" | "drop";

/** A request rule (layers.md L7). */
export interface RequestRule {
  /** Its id: 1 to 64 letters, digits, `_`, `.` and `-`; the hit's rule is `rule:<id>`. */
  readonly id: string;
  /** The condition. */
  readonly when: RuleCondition;
  /**
   * What a hit does: `log` (recorded only), `block` (refused), `challenge`
   * (refused with `block` until challenge providers exist), `ban` (refused,
   * and the client address banned for {@link duration}), `drop` (the
   * connection closed with no answer). Default `block`.
   */
  readonly action?: RequestRuleAction;
  /**
   * The offence weight a hit adds to the client address's score (the
   * ladder, layers.md §0.2), from 0 to 100. Default 1, or 0 for `log`.
   */
  readonly weight?: number;
  /** `enforce` (the default), `dryRun` (recorded as what it would do), or `off`. */
  readonly mode?: "enforce" | "dryRun" | "off";
  /** The refusal's status, from 400 to 599. Default `403`. */
  readonly status?: number;
  /** The refusal's problem code. Default `blocked` (`banned` for `ban`). */
  readonly code?: string;
  /** How long a `ban` lasts; `null` until lifted. Default the ladder's escalating length (1 h without a ladder). */
  readonly duration?: Duration | null;
  /**
   * Whether a verified crawler (layers.md L3.2, PR-S12) on its allowance's
   * paths is held to the rule: `apply` (the default for a rule of the
   * policy's own) or `skip` (its hit is logged as `crawler.probe` instead,
   * as the managed probe set's always are).
   */
  readonly crawlers?: "apply" | "skip";
}

/** The managed probe set's rules, by id (layers.md L7). */
export type ManagedRuleId =
  | "dotenv"
  | "vcs"
  | "wordpress"
  | "phpmyadmin"
  | "cgi-bin"
  | "actuator"
  | "scanner-agents"
  | "header-control-chars"
  | "oversized-cookie";

/** The managed probe set's settings. */
export interface ManagedRulesPolicy {
  /**
   * `dryRun` (the default: hits are recorded as what they would do) or
   * `enforce` (probes of paths are answered `404`, scanners `403`).
   */
  readonly mode?: "enforce" | "dryRun";
  /** Rules of the set to leave out (`wordpress` on a WordPress service). */
  readonly exclude?: readonly ManagedRuleId[];
  /** The offence weight of each hit. Default 1. */
  readonly weight?: number;
}

/** The policy's `requestRules` section. */
export interface RequestRulesPolicy {
  /** The policy's own rules, in order (at most 500). */
  readonly rules?: readonly RequestRule[];
  /**
   * The managed probe set: `true` (on, in dry run), its settings, or
   * `false`. Off by default.
   */
  readonly managed?: boolean | ManagedRulesPolicy;
  /** The most characters a `regex` reads of a target, from 16 to 8,192. Default 1,024. */
  readonly maxRegexInput?: number;
}
