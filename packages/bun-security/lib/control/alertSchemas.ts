/**
 * The alerts' schemas (PR-CP6): what `/alerts/*` takes and answers, in the
 * management API's documents.
 */
import type {
  AlertCondition,
  AlertChannelDto,
  AlertChannelSecretDto,
  AlertDeadLetterDto,
  AlertDeliveryLogDto,
  AlertRuleDto,
  OpenAlertDto,
} from "./contract/alerts";
import type { Schema } from "./schema";
import { ALERT_API_LIMITS, ALERT_SEVERITIES } from "./contract/alerts";
import { s } from "./schema";
import { page } from "./schemas";

/** An entity id. */
const Id = s.string({
  min: 1,
  max: 64,
  pattern: /^[a-z\d][\w.-]{0,63}$/i,
  description: "letters, digits, _, . and -",
});

/** A scope id. */
const Scope = s.string({
  min: 1,
  max: 80,
  pattern: /^(?:global|(?:group|service):[a-z\d][\w.-]{0,63})$/i,
  description: "global, group:<id> or service:<id>",
});

/** A severity. */
const Severity = s.enum(
  ALERT_SEVERITIES as readonly ("info" | "warning" | "critical")[],
);

/** A channel's type. */
const ChannelType = s.enum(["webhook", "slack", "email"] as const);

/** A condition: checked by the rule engine (`checkCondition`), documented as an object. */
const Condition = s.anyObject(
  "what the rule watches: threshold, rate, baseline, sustained, banStorm, agentSilent or agentWarning (README §9.3)",
) as Schema<unknown> as Schema<AlertCondition>;

/** A URL, write-only. */
const Url = s.string({
  min: 8,
  max: 2_000,
  description:
    "https:, or http: to a loopback host; answered as scheme and host only",
});

/** An email address. */
const Email = s.string({
  min: 3,
  max: 254,
  pattern: /^[^\s@]+@[^\s@]+$/,
  description: "an email address",
});

/** Which control-plane alerts a channel receives. */
const Receives = s.object({
  kinds: s.array(
    s.string({ min: 1, max: 60, pattern: /^(?:\*|[a-z][\w.-]{0,59})$/i }),
    50,
  ),
  minSeverity: s.optional(Severity),
});

/** An alert rule. */
export const AlertRule: Schema<AlertRuleDto> = s.object({
  id: Id,
  title: s.string(),
  scope: Scope,
  severity: Severity,
  condition: Condition,
  channels: s.array(Id, ALERT_API_LIMITS.maxRuleChannels),
  enabled: s.boolean(),
  revision: s.int({ min: 1 }),
});

/** A page of rules. */
export const AlertRules = page(AlertRule);

/** `PUT /alerts/rules/:id`'s body. */
export const AlertRuleBody = s.object({
  title: s.string({ min: 1, max: 200 }),
  scope: Scope,
  severity: Severity,
  condition: Condition,
  channels: s.array(Id, ALERT_API_LIMITS.maxRuleChannels),
  enabled: s.optional(s.boolean()),
  revision: s.nullable(
    s.int({ min: 1, description: "the revision read; null to make it" }),
  ),
});

/** A channel: its URL as scheme and host, never its secret. */
export const AlertChannel: Schema<AlertChannelDto> = s.object({
  id: Id,
  name: s.string(),
  type: ChannelType,
  url: s.optional(s.string({ description: "scheme and host only" })),
  to: s.optional(s.array(s.string(), ALERT_API_LIMITS.maxRecipients)),
  receives: s.optional(Receives),
  revision: s.int({ min: 1 }),
});

/** A page of channels. */
export const AlertChannels = page(AlertChannel);

/** A channel and its secret, shown once. */
export const AlertChannelSecret: Schema<AlertChannelSecretDto> = s.object({
  channel: AlertChannel,
  secret: s.optional(
    s.string({ description: "the webhook's signing secret: shown this once" }),
  ),
});

/** `POST /alerts/channels`'s body. */
export const AlertChannelCreateBody = s.object({
  id: Id,
  name: s.string({ min: 1, max: 200 }),
  type: ChannelType,
  url: s.optional(Url),
  to: s.optional(s.array(Email, ALERT_API_LIMITS.maxRecipients)),
  receives: s.optional(Receives),
});

/** `PUT /alerts/channels/:id`'s body. */
export const AlertChannelUpdateBody = s.object({
  name: s.optional(s.string({ min: 1, max: 200 })),
  url: s.optional(Url),
  to: s.optional(s.array(Email, ALERT_API_LIMITS.maxRecipients)),
  receives: s.optional(s.nullable(Receives)),
  revision: s.int({ min: 1, description: "the revision read" }),
});

/** `POST /alerts/channels/:id/secret`'s body. */
export const AlertChannelRevisionBody = s.object({
  revision: s.int({ min: 1, description: "the revision read" }),
});

/** One try of a delivery. */
export const AlertDeliveryLog: Schema<AlertDeliveryLogDto> = s.object({
  id: s.string(),
  channelId: s.string(),
  kind: s.string(),
  severity: s.nullable(Severity),
  outcome: s.enum(["sent", "failed", "dead"] as const),
  attempts: s.int({ min: 0 }),
  at: s.int({ min: 0 }),
  reason: s.optional(s.string()),
});

/** A page of the delivery log. */
export const AlertDeliveryLogPage = page(AlertDeliveryLog);

/** A dead letter. */
export const AlertDeadLetter: Schema<AlertDeadLetterDto> = s.object({
  id: s.string(),
  channelId: s.string(),
  kind: s.string(),
  severity: s.nullable(Severity),
  attempts: s.int({ min: 0 }),
  reason: s.string(),
  queuedAt: s.int({ min: 0 }),
  diedAt: s.int({ min: 0 }),
});

/** A page of dead letters. */
export const AlertDeadLetters = page(AlertDeadLetter);

/** An open alert. */
export const OpenAlert: Schema<OpenAlertDto> = s.object({
  rule: s.string(),
  scope: Scope,
  since: s.int({ min: 0 }),
});

/** The open alerts. */
export const OpenAlerts = s.object({ items: s.array(OpenAlert, 10_000) });

/** The delivery log's and dead letters' query. */
export const AlertLogQuery = s.query({
  channel: s.optional(Id),
  limit: s.optional(
    s.int({ min: 1, max: 200, description: "the page size (default 50)" }),
  ),
  cursor: s.optional(
    s.string({ max: 20, description: "the previous page's next" }),
  ),
});

/** A delivery's id. */
export const DeliveryIdParams = s.object({
  id: s.string({ min: 1, max: 64, pattern: /^[a-f\d]{1,64}$/ }),
});

/** Path parameters with a rule's or a channel's `id`. */
export const RuleIdParams = s.object({ id: Id });

/** `DELETE`'s query: the revision read. */
export const AlertRevisionQuery = s.query({
  revision: s.int({ min: 1, description: "the revision read" }),
});
