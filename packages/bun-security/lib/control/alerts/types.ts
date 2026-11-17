/**
 * Alerts (README §9.3, PR-CP6): what a rule watches, where an alert goes,
 * and what is queued for delivery.
 */
import type { AlertCondition, AlertSeverity } from "../contract/alerts";
import type { PolicyScopeId } from "../contract/types";

export { ALERT_SEVERITIES } from "../contract/alerts";
export type {
  AlertCondition,
  AlertMetric,
  AlertSeverity,
} from "../contract/alerts";

/** An alert rule, as the store keeps it (kind `alertRule`). */
export interface AlertRuleSpec {
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
  /** Off: not evaluated. Default on. */
  readonly enabled?: boolean;
}

/** Where alerts go (kind `alertChannel`). */
export type AlertChannelSpec = {
  /** Its id. */
  readonly id: string;
  /** Its name, for a person. */
  readonly name: string;
  /** Which of the control plane's own alerts (CP3's, CP4's) it also receives: their kinds (`*` for every one) at or above a severity. Default none. */
  readonly receives?: {
    /** The kinds; `*` for every one. */
    readonly kinds: readonly string[];
    /** The least severity. Default `info`. */
    readonly minSeverity?: AlertSeverity;
  };
} & (
  | {
      /** A JSON webhook, HMAC-signed with a timestamp (`x-bun-security-timestamp`, `x-bun-security-signature: sha256=…`). */
      readonly type: "webhook";
      /** Where it posts (sealed at rest by D3's defaults). */
      readonly url: string;
      /** The signing secret, at least 32 bytes (sealed at rest). */
      readonly secret: string;
    }
  | {
      /** A Slack-compatible incoming webhook (`{ text }`). */
      readonly type: "slack";
      /** Its URL, which carries its token (sealed at rest). */
      readonly url: string;
    }
  | {
      /** Email, through the host's `send` hook (bun-security ships no SMTP client). */
      readonly type: "email";
      /** The addresses. */
      readonly to: readonly string[];
    }
);

/** One alert, raised by a rule or by the control plane itself. */
export interface AlertRecord {
  /** Its kind: the rule's id (`rule:<id>`), or a control-plane alert's (`breakGlass.login`). */
  readonly kind: string;
  /** Its key: an alert with the same key is not raised again while it is open. */
  readonly key: string;
  /** How bad. */
  readonly severity: AlertSeverity;
  /** The scope it concerns. */
  readonly scope: PolicyScopeId;
  /** What happened, for a person. */
  readonly title: string;
  /** When it was raised, epoch ms. */
  readonly at: number;
  /** The figures behind it (counts, thresholds, the window). */
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

/** A message for one channel: an alert, or a digest of those held back. */
export type AlertMessage =
  | {
      /** One alert. */
      readonly type: "alert";
      /** The alert. */
      readonly alert: AlertRecord;
    }
  | {
      /** The alerts held back since the last digest, counted. */
      readonly type: "digest";
      /** When the digest was made. */
      readonly at: number;
      /** Held back, by kind: how many, and the worst severity. */
      readonly held: readonly {
        /** The kind. */
        readonly kind: string;
        /** How many. */
        readonly count: number;
        /** The worst severity among them. */
        readonly severity: AlertSeverity;
      }[];
    };

/** One delivery of a message to a channel. */
export interface AlertDelivery {
  /** Its id. */
  readonly id: string;
  /** The channel. */
  readonly channelId: string;
  /** What it carries. */
  readonly message: AlertMessage;
  /** Attempts made so far. */
  readonly attempts: number;
  /** When it was first queued. */
  readonly queuedAt: number;
}

/** A delivery that ran out of attempts. */
export interface AlertDeadLetter extends AlertDelivery {
  /** Why the last attempt failed. */
  readonly reason: string;
  /** When it died. */
  readonly diedAt: number;
}
