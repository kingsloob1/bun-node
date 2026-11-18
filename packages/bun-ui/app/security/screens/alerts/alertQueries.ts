/** The alerts screens' types and query keys. */
import type { AlertCondition } from "@kingsleyweb/bun-security/control/contract";
import type { Routes } from "../../api/routes.gen";

/** An alert rule. */
export type AlertRuleDto =
  Routes["GET /alerts/rules"]["responses"][200]["items"][number];
/** A channel (its URL as scheme and host, never its secret). */
export type AlertChannelDto =
  Routes["GET /alerts/channels"]["responses"][200]["items"][number];
/** One delivery try. */
export type AlertDeliveryDto =
  Routes["GET /alerts/deliveries"]["responses"][200]["items"][number];
/** A dead letter. */
export type AlertDeadLetterDto =
  Routes["GET /alerts/dead-letters"]["responses"][200]["items"][number];
/** An alert open now. */
export type OpenAlertDto =
  Routes["GET /alerts/open"]["responses"][200]["items"][number];
/**
 * What a rule watches: the contract's type (the document declares it as
 * an object the control plane checks, so the generated type is open).
 */
export type AlertConditionDto = AlertCondition;

/** The alerts screens' query keys (all under `alerts`). */
export const alertKeys = {
  /** The alerts open now. */
  open: () => ["alerts", "open"] as const,
  /** A page of rules. */
  rules: (cursor: string | undefined, limit: number) =>
    ["alerts", "rules", cursor ?? null, limit] as const,
  /** One rule. */
  rule: (id: string) => ["alerts", "rule", id] as const,
  /** A page of channels. */
  channels: (cursor: string | undefined, limit: number) =>
    ["alerts", "channels", cursor ?? null, limit] as const,
  /** Every channel, for a rule's picker (the first 200). */
  channelChoices: () => ["alerts", "channelChoices"] as const,
  /** One channel. */
  channel: (id: string) => ["alerts", "channel", id] as const,
  /** A page of the delivery log. */
  deliveries: (channel: string, cursor: string | undefined, limit: number) =>
    ["alerts", "deliveries", channel, cursor ?? null, limit] as const,
  /** A page of dead letters. */
  deadLetters: (channel: string, cursor: string | undefined, limit: number) =>
    ["alerts", "deadLetters", channel, cursor ?? null, limit] as const,
};

/**
 * A rule's condition as the contract types it: the API answers only
 * conditions its rule engine accepted (`checkCondition`), which the
 * document declares as an open object.
 */
export function ruleCondition(rule: AlertRuleDto): AlertConditionDto {
  return rule.condition as unknown as AlertConditionDto;
}

/** A channel's type, for people. */
export const CHANNEL_TYPES = {
  webhook: "Webhook",
  slack: "Slack-compatible webhook",
  email: "Email",
} as const;

/** A severity's badge tone. */
export const SEVERITY_TONE = {
  info: "info",
  warning: "warning",
  critical: "danger",
} as const;
