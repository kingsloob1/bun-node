/**
 * The alert rules README §9.3 names, as presets: each a rule with the
 * docs' defaults, for a scope and its channels, to store as it is or adjust.
 * The control plane's own alerts (break-glass, a failed verify, emergency
 * approvals, a dangerous change, a failing sink, an agent's failing
 * signatures) need no rule: a channel receives them by kind.
 */
import type { PolicyScopeId } from "../contract/types";
import type { AlertCondition, AlertRuleSpec, AlertSeverity } from "./types";

/** A preset's defaults. */
interface Preset {
  /** What it is. */
  readonly title: string;
  /** How bad. */
  readonly severity: AlertSeverity;
  /** What it watches. */
  readonly condition: AlertCondition;
}

/** Minutes, ms. */
const MINUTE = 60_000;

/** The presets, by name (README §9.3). */
export const ALERT_RULE_PRESETS = Object.freeze({
  /** A blocked share 3× its 7-day baseline at this hour, for 5 minutes. */
  blockRateSpike: {
    title: "Block-rate spike",
    severity: "warning",
    condition: {
      type: "baseline",
      metric: "requests",
      dims: { action: "block" },
      total: { metric: "requests" },
      windowMs: 5 * MINUTE,
      baselineDays: 7,
      factor: 3,
      minimum: 50,
    },
  },
  /** A rule hit more than 5 times in an hour, each rule on its own. */
  ruleTripped: {
    title: "A rule tripped repeatedly",
    severity: "warning",
    condition: {
      type: "threshold",
      metric: "rules",
      groupBy: "rule",
      windowMs: 60 * MINUTE,
      value: 5,
    },
  },
  /** One address refused 1,000 times in an hour. */
  subjectRefusedHeavily: {
    title: "An address refused heavily",
    severity: "info",
    condition: {
      type: "threshold",
      metric: "top.refused",
      dims: { kind: "ip" },
      groupBy: "subject",
      windowMs: 60 * MINUTE,
      value: 1_000,
    },
  },
  /** More than 1,000 automatic bans in 5 minutes. */
  banStorm: {
    title: "Ban storm",
    severity: "warning",
    condition: {
      type: "banStorm",
      windowMs: 5 * MINUTE,
      value: 1_000,
      source: "auto",
    },
  },
  /** An enforcement point reached its daily event cap. */
  eventCapReached: {
    title: "Event cap reached",
    severity: "info",
    condition: {
      type: "threshold",
      metric: "events.capped",
      dims: { cap: "day" },
      windowMs: 60 * MINUTE,
      value: 1,
    },
  },
  /** A canary credential, key or URL used (any `canary:` rule hit). */
  canaryUsed: {
    title: "Canary used",
    severity: "critical",
    condition: {
      type: "threshold",
      metric: "rules",
      groupBy: "rule",
      prefix: "canary:",
      windowMs: 5 * MINUTE,
      value: 1,
    },
  },
  /** An enforcement point's shared store failing for 30 s (it runs on its fallback). */
  storeDown: {
    title: "Store down",
    severity: "critical",
    condition: { type: "agentWarning", kinds: ["store.unavailable"] },
  },
  /** Credential stuffing: the global login failure ratio (layers.md L11.2). */
  credentialStuffing: {
    title: "Credential stuffing",
    severity: "warning",
    condition: { type: "agentWarning", kinds: ["login.failure-rate"] },
  },
  /** The trust check's detector (layers.md L2.5): clients resolve inside, or forwarding is never read. */
  trustMisconfigured: {
    title: "Trust misconfiguration",
    severity: "warning",
    condition: {
      type: "agentWarning",
      kinds: ["trust.internal", "trust.unread-forwarding"],
    },
  },
  /** An IP feed (the Tor list, an IP-intel file) whose last refresh failed. */
  feedRefreshFailed: {
    title: "Feed refresh failed",
    severity: "warning",
    condition: { type: "agentWarning", kinds: ["feed.refresh-failed"] },
  },
  /** Sustained limiter key eviction (a rotation attack). */
  limiterEvictions: {
    title: "Limiter evictions",
    severity: "warning",
    condition: { type: "agentWarning", kinds: ["state.evictions"] },
  },
  /** Distinct counts falling back from the shared store to local ones (#834). */
  distinctFallback: {
    title: "Distinct counts falling back",
    severity: "warning",
    condition: { type: "agentWarning", kinds: ["store.distinct-fallback"] },
  },
  /**
   * A verified crawler limited by its own limit (a `429`) in each of the
   * last 24 complete hours, across every agent in the scope (layers.md
   * L3.2, PR-AN2): a URL that keeps answering 429 drops out of the index.
   */
  crawlerLimited: {
    title: "Crawler limited for a day",
    severity: "warning",
    condition: {
      type: "sustained",
      metric: "crawlers",
      dims: { outcome: "limited" },
      groupBy: "crawler",
      hours: 24,
    },
  },
  /** An agent heard from before, silent for 2 minutes. */
  agentSilent: {
    title: "Agent silent",
    severity: "warning",
    condition: { type: "agentSilent", afterMs: 2 * MINUTE },
  },
} satisfies Record<string, Preset>);

/** A preset's name. */
export type AlertRulePresetName = keyof typeof ALERT_RULE_PRESETS;

/** A rule from a preset, for `scope` and `channels`. */
export function alertRulePreset(
  name: AlertRulePresetName,
  rule: {
    /** Its id. */
    readonly id: string;
    /** The scope. */
    readonly scope: PolicyScopeId;
    /** The channels, by id. */
    readonly channels: readonly string[];
  },
): AlertRuleSpec {
  const preset: Preset = ALERT_RULE_PRESETS[name];
  return {
    id: rule.id,
    title: preset.title,
    scope: rule.scope,
    severity: preset.severity,
    condition: preset.condition,
    channels: rule.channels,
  };
}
