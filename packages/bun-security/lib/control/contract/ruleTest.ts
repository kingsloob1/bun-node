/**
 * Test a request's wire types (ui.md §4.5, PR-CP7): what `POST /rules/test`
 * answers. Browser-safe, with no runtime import.
 *
 * What `POST /rules/test` and `POST /policies/:scope/impact` take and
 * answer (the user's decisions of 2026-11-17): a test request holds no body
 * and is never stored or logged; its account ids are keyed as the engines
 * key them, and the answer shows keys, never the ids sent.
 */
import type { PolicyScopeId } from "./types";

/** An action a decision or a hit takes (layers.md, the engine's `SecurityAction`). */
export type RuleTestAction =
  "allow" | "log" | "tag" | "delay" | "challenge" | "block" | "ban" | "drop";

/** One rule that matched. */
export interface RuleTestHitDto {
  /** The layer (`L3`, `L7`, …). */
  readonly layer: string;
  /** The rule's id (one naming an account shown as its key). */
  readonly rule: string;
  /** What it did. */
  readonly action: RuleTestAction;
  /** In dry run: what it would have done. */
  readonly wouldHaveBeen?: RuleTestAction;
  /** Why, in a few words. */
  readonly reason?: string;
}

/** One step of the evaluation, in order. */
export interface RuleTestStepDto {
  /** The layer. */
  readonly layer: string;
  /** What was checked. */
  readonly check: string;
  /** The rule, when one was. */
  readonly rule?: string;
  /** What came of it. */
  readonly outcome: string;
  /** Whether this step decided the request. */
  readonly decided?: boolean;
}

/** One hop of the forwarding chain, as the trust-proxy resolution saw it. */
export interface RuleTestHopDto {
  /** The address, as written. */
  readonly address: string;
  /** The socket peer, an `X-Forwarded-For` entry, or the client-IP header. */
  readonly source: "socket" | "x-forwarded-for" | "header";
  /** Whether it was trusted as a proxy. */
  readonly trusted: boolean;
}

/** The result of testing a request: what the policy would decide, and why. */
export interface RuleTestResultDto {
  /** The service whose effective policy decided. */
  readonly service: string;
  /** Which policy: the scope whose draft stood in for its published policy (`null`: published only), and the versions merged. */
  readonly policy: {
    /** The scope whose draft was used, or `null`. */
    readonly draft: PolicyScopeId | null;
    /** The versions merged, global first (`<scope>@draft` for the draft). */
    readonly versions: readonly string[];
  };
  /** When it was evaluated, epoch ms. */
  readonly at: number;
  /** The decision. */
  readonly decision: {
    /** The final action. */
    readonly action: RuleTestAction;
    /** The status it would answer with. */
    readonly status?: number;
    /** The problem code it would answer with. */
    readonly code?: string;
    /** A delay it would add, ms. */
    readonly delayMs?: number;
    /** The `Retry-After` it would send, seconds. */
    readonly retryAfter?: number;
    /** Every rule that matched, in order. */
    readonly hits: readonly RuleTestHitDto[];
    /** The tags it would carry. */
    readonly tags: readonly string[];
    /** Its risk score. */
    readonly risk: number;
    /** The keys it would count against (accounts as their keys, never the ids sent). */
    readonly subject: Readonly<Record<string, string>>;
    /** The claimed crawler and its verdict. */
    readonly crawler?: {
      /** The crawler's id. */
      readonly id: string;
      /** Whether it was verified. */
      readonly verified: boolean;
      /** How. */
      readonly verifiedBy?: "ranges" | "rdns" | "cache";
      /** Whether the claim was false. */
      readonly spoofed: boolean;
    };
  };
  /** Who the client was resolved to be, and through which hops. */
  readonly client: {
    /** The address. */
    readonly address?: string;
    /** Its key (an IPv6 `/64`). */
    readonly key?: string;
    /** Where it came from. */
    readonly source:
      "socket" | "trusted-proxy" | "client-ip-header" | "service" | "none";
    /** The hops. */
    readonly chain: readonly RuleTestHopDto[];
    /** The calling service, for a service identity. */
    readonly service?: string;
  };
  /** Every step, in order. */
  readonly steps: readonly RuleTestStepDto[];
  /**
   * What the test could not evaluate as an enforcement point would: no
   * reverse DNS is made for a crawler claim (`crawler.rdns`), and an
   * address's country, ASN and classes are only what the test assumed
   * (`intel`).
   */
  readonly notEvaluated: readonly string[];
}

/** The bounds of a test and an estimate (the user's decisions of 2026-11-17). */
export const RULE_TEST_LIMITS = /* @__PURE__ */ Object.freeze({
  /** Tests an operator may run a minute, across the instances. */
  testsPerMinute: 30,
  /** Estimates an operator may run a minute, across the instances. */
  estimatesPerMinute: 6,
  /** Estimates running at once per operator, across the instances. */
  estimatesPerOperator: 1,
  /** Estimates running at once on one instance. */
  estimatesPerInstance: 2,
  /** The most headers a test request carries. */
  maxHeaders: 100,
  /** The most bytes of header names and values in all. */
  maxHeaderBytes: 16_384,
  /** The most limits a test assumes counts for. */
  maxAssumedLimits: 50,
  /** The most a test may assume a limit has counted, or a score is. */
  maxAssumed: 1_000_000,
  /** An estimate's default window, ms (24 hours). */
  defaultWindowMs: 86_400_000,
  /** An estimate's longest window, ms (7 days). */
  maxWindowMs: 7 * 86_400_000,
  /** The most events an estimate reads. */
  maxEvents: 50_000,
  /** The longest an estimate runs, ms. */
  maxDurationMs: 10_000,
  /** The most services an estimate replays (a group's or global draft). */
  maxServices: 200,
  /** The most sample event ids per rule. */
  samplesPerRule: 10,
  /** The most routes an estimate lists. */
  maxRoutes: 100,
});

/** `POST /rules/test`'s body: a request described, never a body. */
export interface RuleTestInput {
  /** The service whose effective policy decides. */
  readonly service: string;
  /** A scope at or above the service whose draft stands in for its published policy. */
  readonly draft?: PolicyScopeId;
  /** The method. */
  readonly method: string;
  /** The path, with its query, starting with one `/`. */
  readonly path: string;
  /** The headers (at most 100, 16 KiB in all). */
  readonly headers?: Readonly<Record<string, string>>;
  /** The socket peer's address. */
  readonly peer: string;
  /** The service's trust-proxy setting: `true`, a hop count, or the trusted ranges. Default off. */
  readonly trustProxy?: boolean | number | readonly string[];
  /** The service's client-IP header, if it has one. */
  readonly clientIpHeader?: string;
  /** Who the app would say is calling, as ids the app knows (keyed with the fleet secret). */
  readonly identity?: {
    /** The user's id. */
    readonly user?: string;
    /** The session's id. */
    readonly session?: string;
    /** The tenant. */
    readonly tenant?: string;
    /** The API key's id (never the key). */
    readonly apiKey?: string;
    /** The API key's plan. */
    readonly apiKeyPlan?: string;
    /** The scopes the credential carries. */
    readonly scopes?: readonly string[];
    /** The login identifier attempted. */
    readonly username?: string;
    /** Where a code or link would be sent. */
    readonly destination?: string;
  };
  /** The route's key (`POST /login`). */
  readonly routeKey?: string;
  /** The route's profile (`login`, …). */
  readonly profile?: string;
  /** What to assume of the client's address (the control plane has no IP database). */
  readonly intel?: {
    /** Its country, ISO 3166-1 alpha-2. */
    readonly country?: string;
    /** Its ASN. */
    readonly asn?: number;
    /** Its classes (`tor`, `hosting`). */
    readonly classes?: readonly string[];
  };
  /** State to assume: what limits have counted for this request's keys, and the address's offence score. */
  readonly assume?: {
    /** Per limit id: what it has counted in its current window (at most 50 limits). */
    readonly limits?: Readonly<Record<string, number>>;
    /** The address's offence score before this request. */
    readonly score?: number;
  };
}

/** How exactly an estimate can evaluate a rule over stored events. */
export type RuleEvaluability = "exact" | "partial" | "not-evaluated";

/** A rule and how an estimate evaluates it. */
export interface RuleLabelDto {
  /** The rule (`rule:<id>`, `limit:<id>`, `lists`, `shape.body`, …). */
  readonly rule: string;
  /** `exact`, `partial` (some of what it reads is redacted in stored events) or `not-evaluated`. */
  readonly label: RuleEvaluability;
  /** Why, when not exact. */
  readonly why?: string;
}

/** `POST /policies/:scope/impact`'s body. */
export interface RuleImpactInput {
  /** The window's start, epoch ms. Default 24 hours before `to`. */
  readonly from?: number;
  /** The window's end, epoch ms. Default now. */
  readonly to?: number;
}

/** How a decision class changed between the published policy and the draft. */
export interface ImpactTransitionDto {
  /** Before: `allow` (allow, log, tag, delay), `challenge` or `refuse` (block, ban, drop). */
  readonly from: "allow" | "challenge" | "refuse";
  /** After, the same classes. */
  readonly to: "allow" | "challenge" | "refuse";
  /** Events so changed. */
  readonly count: number;
}

/** A rule whose hits the draft changes. */
export interface ImpactRuleDto {
  /** The rule (one naming an account redacted unless the caller sees events whole). */
  readonly rule: string;
  /** Events it hits under the draft and not the published policy. */
  readonly newlyHit: number;
  /** Events it hits under the published policy and not the draft. */
  readonly noLongerHit: number;
  /** Up to 10 of those events' ids. */
  readonly samples: readonly string[];
}

/** A draft's estimated impact over stored events: never stored. */
export interface RuleImpactDto {
  /** The scope whose draft was compared with its published policy. */
  readonly scope: PolicyScopeId;
  /** The window replayed. */
  readonly window: {
    /** Its start, epoch ms. */
    readonly from: number;
    /** Its end, epoch ms. */
    readonly to: number;
  };
  /** The services replayed, and those skipped (no access, the draft does not compile for it, past 200). */
  readonly services: {
    /** Replayed. */
    readonly replayed: readonly string[];
    /** Skipped, with why. */
    readonly skipped: readonly {
      /** The service. */
      readonly service: string;
      /** Why. */
      readonly reason: string;
    }[];
  };
  /** The events read; whether a bound stopped the reading early and which. */
  readonly events: {
    /** Read and replayed. */
    readonly read: number;
    /** `events` (50,000), `time` (10 s), or `null` when every event in the window was read. */
    readonly stoppedBy: "events" | "time" | null;
  };
  /**
   * Sampled allows: enforcement points keep one allow in `rate`'s share
   * (one in a thousand by default), so a change to allowed traffic is
   * counted over the allows kept, never scaled. `rates` lists the rates
   * stamped on the allows read (none on allows stored before PR-CP7).
   */
  readonly sampledAllows: {
    /** Allows read. */
    readonly read: number;
    /** The sampling rates they carry. */
    readonly rates: readonly number[];
  };
  /** Events whose decision class changed, by before and after. */
  readonly transitions: readonly ImpactTransitionDto[];
  /** Rules whose hits changed. */
  readonly rules: readonly ImpactRuleDto[];
  /** Routes with changed events, most first (at most 100). */
  readonly routes: readonly {
    /** The route's key. */
    readonly route: string;
    /** Events changed. */
    readonly changed: number;
  }[];
  /** Distinct subjects whose decisions changed, by kind (account kinds only over events the caller sees whole). */
  readonly subjects: Readonly<Record<string, number>>;
  /** Every rule of both policies, and how exactly the estimate evaluated it. */
  readonly labels: readonly RuleLabelDto[];
}
