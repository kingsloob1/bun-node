/**
 * The alerts' wire types (README §9.3, PR-CP6): what a rule watches, and
 * what `/alerts/*` takes and answers. Browser-safe, with no runtime import.
 *
 * What the API never answers (the user's decisions, 2026-11-17): a
 * channel's secret (shown once, when it is made or rotated), its URL
 * beyond scheme and host, an open alert's key, and a delivery's or a dead
 * letter's content.
 */
import type { PolicyScopeId } from "./types";

/** How bad an alert is. */
export type AlertSeverity = "info" | "warning" | "critical";

/** The severities, least to most. */
export const ALERT_SEVERITIES: readonly AlertSeverity[] =
  /* @__PURE__ */ Object.freeze(["info", "warning", "critical"]);

/** A metric and the dimensions it is narrowed to. */
export interface AlertMetric {
  /** The metric (`requests`, `rules`, `top.refused`, `events.capped`). */
  readonly metric: string;
  /** Only rows with these dimensions. */
  readonly dims?: Readonly<Record<string, string>>;
}

/**
 * What a rule watches (README §9.3):
 *
 * - `threshold`: a metric's sum over `windowMs` reaches `value`; with
 *   `groupBy`, each value of that dimension on its own (a rule, a subject),
 *   `prefix` narrowing which (`canary:`);
 * - `rate`: a metric's average per minute over `windowMs` reaches `value`;
 * - `baseline`: a metric's share of `total` over `windowMs` reaches `factor`
 *   times its average share at this hour over the last `baselineDays` days
 *   (the block-rate spike), with at least `minimum` counted;
 * - `banStorm`: at least `value` bans of `source` created in `windowMs`;
 * - `agentSilent`: an agent heard from before, silent for `afterMs`;
 * - `agentWarning`: an agent whose last heartbeat (within `maxAgeMs`,
 *   default 5 minutes) reports a warning of one of `kinds` (`*` for any):
 *   the enforcement point's store down, trust misconfigured, a feed not
 *   refreshing, evictions, a login failure rate, a distinct-count fallback.
 */
export type AlertCondition =
  | (AlertMetric & {
      readonly type: "threshold";
      readonly windowMs: number;
      readonly value: number;
      readonly groupBy?: string;
      readonly prefix?: string;
    })
  | (AlertMetric & {
      readonly type: "rate";
      readonly windowMs: number;
      readonly value: number;
    })
  | (AlertMetric & {
      readonly type: "baseline";
      readonly total: AlertMetric;
      readonly windowMs: number;
      readonly baselineDays: number;
      readonly factor: number;
      readonly minimum: number;
    })
  | {
      readonly type: "banStorm";
      readonly windowMs: number;
      readonly value: number;
      readonly source?: "auto" | "manual";
    }
  | (AlertMetric & {
      /**
       * Sustained (PR-AN2): fires, per `groupBy` value (or for the rule as
       * a whole), when every one of the last `hours` complete clock hours
       * counted above zero; it clears after a complete hour with none.
       */
      readonly type: "sustained";
      /** How many complete clock hours, 1 to 168. */
      readonly hours: number;
      /** The dimension each group is (`crawler`). */
      readonly groupBy?: string;
    })
  | {
      readonly type: "agentSilent";
      readonly afterMs: number;
    }
  | {
      readonly type: "agentWarning";
      readonly kinds: readonly string[];
      readonly maxAgeMs?: number;
    };

/** An alert rule, as `/alerts/rules` answers it. */
export interface AlertRuleDto {
  /** Its id. */
  readonly id: string;
  /** What it is, for a person. */
  readonly title: string;
  /** The scope it watches, and what is under it. */
  readonly scope: PolicyScopeId;
  /** How bad its alert is. */
  readonly severity: AlertSeverity;
  /** What it watches. */
  readonly condition: AlertCondition;
  /** The channels its alerts go to, by id. */
  readonly channels: readonly string[];
  /** Whether it is evaluated. */
  readonly enabled: boolean;
  /** Its revision, for an update or a delete. */
  readonly revision: number;
}

/** `PUT /alerts/rules/:id`'s body: `revision: null` makes it. */
export interface AlertRuleInput {
  /** What it is, for a person. */
  readonly title: string;
  /** The scope it watches. */
  readonly scope: PolicyScopeId;
  /** How bad its alert is. */
  readonly severity: AlertSeverity;
  /** What it watches. */
  readonly condition: AlertCondition;
  /** The channels, by id (each must exist). */
  readonly channels: readonly string[];
  /** Off: not evaluated. Default on. */
  readonly enabled?: boolean;
  /** The revision read; `null` to make it. */
  readonly revision: number | null;
}

/** Which of the control plane's own alerts a channel also receives. */
export interface AlertChannelReceives {
  /** The kinds (`breakGlass.login`, …); `*` for every one. */
  readonly kinds: readonly string[];
  /** The least severity. Default `info`. */
  readonly minSeverity?: AlertSeverity;
}

/** A channel, as `/alerts/channels` answers it: its URL as scheme and host, never its secret. */
export interface AlertChannelDto {
  /** Its id. */
  readonly id: string;
  /** Its name, for a person. */
  readonly name: string;
  /** `webhook`, `slack` or `email`. */
  readonly type: "webhook" | "slack" | "email";
  /** Where it posts, as scheme and host only (`https://hooks.example.com`); webhook and Slack. */
  readonly url?: string;
  /** The addresses; email. */
  readonly to?: readonly string[];
  /** Which control-plane alerts it receives. */
  readonly receives?: AlertChannelReceives;
  /** Its revision, for an update or a delete. */
  readonly revision: number;
}

/** `POST /alerts/channels`'s body. */
export interface AlertChannelCreateInput {
  /** Its id. */
  readonly id: string;
  /** Its name. */
  readonly name: string;
  /** `webhook`, `slack` or `email`. */
  readonly type: "webhook" | "slack" | "email";
  /** Where it posts (webhook, Slack): `https:`, or `http:` to a loopback host. */
  readonly url?: string;
  /** The addresses (email). */
  readonly to?: readonly string[];
  /** Which control-plane alerts it receives. */
  readonly receives?: AlertChannelReceives;
}

/** `PUT /alerts/channels/:id`'s body: what is absent is kept (the URL is write-only). */
export interface AlertChannelUpdateInput {
  /** Its name. */
  readonly name?: string;
  /** A new URL (webhook, Slack). */
  readonly url?: string;
  /** New addresses (email). */
  readonly to?: readonly string[];
  /** Which control-plane alerts it receives; `null` for none. */
  readonly receives?: AlertChannelReceives | null;
  /** The revision read. */
  readonly revision: number;
}

/** A channel and its webhook secret, shown this once (made or rotated). */
export interface AlertChannelSecretDto {
  /** The channel. */
  readonly channel: AlertChannelDto;
  /** The signing secret; absent for Slack and email. */
  readonly secret?: string;
}

/** One try of a delivery, as the delivery log keeps it (never the message). */
export interface AlertDeliveryLogDto {
  /** The delivery's id. */
  readonly id: string;
  /** The channel. */
  readonly channelId: string;
  /** The alert's kind, or `digest`. */
  readonly kind: string;
  /** Its severity; `null` for a digest. */
  readonly severity: AlertSeverity | null;
  /** `sent`, `failed` (tried again) or `dead` (a dead letter). */
  readonly outcome: "sent" | "failed" | "dead";
  /** The tries so far. */
  readonly attempts: number;
  /** When, epoch ms. */
  readonly at: number;
  /** Why it failed. */
  readonly reason?: string;
}

/** A dead letter: a delivery out of tries (never its message). */
export interface AlertDeadLetterDto {
  /** Its id (the delivery's). */
  readonly id: string;
  /** The channel. */
  readonly channelId: string;
  /** The alert's kind, or `digest`. */
  readonly kind: string;
  /** Its severity; `null` for a digest. */
  readonly severity: AlertSeverity | null;
  /** The tries made. */
  readonly attempts: number;
  /** The last failure. */
  readonly reason: string;
  /** When it was queued, epoch ms. */
  readonly queuedAt: number;
  /** When it ran out of tries, epoch ms. */
  readonly diedAt: number;
}

/** An alert open now (its key is not answered: it may name a subject). */
export interface OpenAlertDto {
  /** The rule that raised it. */
  readonly rule: string;
  /** The rule's scope. */
  readonly scope: PolicyScopeId;
  /** Since when, epoch ms. */
  readonly since: number;
}

/** The limits and retention `/alerts/*` works under. */
export const ALERT_API_LIMITS = /* @__PURE__ */ Object.freeze({
  /** The most rules. */
  maxRules: 1_000,
  /** The most channels. */
  maxChannels: 1_000,
  /** The most addresses an email channel sends to. */
  maxRecipients: 20,
  /** The most channels a rule sends to. */
  maxRuleChannels: 20,
});
