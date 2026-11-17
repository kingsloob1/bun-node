/**
 * What an operator may see of an event (control-plane.md §5.2, the user's
 * decision of 2026-11-17): under `analytics:read` alone, its time, service,
 * route, action, rule, dry run, country, ASN and address, never its request
 * sample or its user, username or API-key subjects, and a rule id that
 * names one of those (`apiKey:<key>`, `user:<id>`, `ban:user:<id>`)
 * redacted; under `events:read`, the whole event. On the live stream the
 * sample is never sent, whatever the role: the detail view fetches it.
 */
import type { SecurityEventViewDto } from "../contract/live";
import type { SecurityEvent } from "../../store/types";

/** What replaces a subject a viewer may not see. */
const REDACTED = "[redacted]";

/** The rule-id prefixes that name an account rather than an address. */
const ACCOUNT_RULE = /^((?:ban:)?(?:apiKey|user|username):)/;

/** A rule id as a viewer sees it: an account's id redacted. */
export function viewerRule(rule: string): string {
  const match = ACCOUNT_RULE.exec(rule);
  return match === null ? rule : `${match[1]}${REDACTED}`;
}

/** How much of an event to show. */
export interface ViewOptions {
  /** `events:read`: the whole event. */
  readonly detail: boolean;
  /** For the live stream: never the sample. */
  readonly live: boolean;
}

/** `event` as an operator with `options` may see it. */
export function eventView(
  event: SecurityEvent,
  options: ViewOptions,
): SecurityEventViewDto {
  const { sample, subjects, rule, rules, ...rest } = event;
  if (options.detail) {
    return {
      ...rest,
      ...(rule === undefined ? {} : { rule }),
      ...(rules === undefined ? {} : { rules }),
      ...(subjects === undefined ? {} : { subjects }),
      ...(sample === undefined || options.live ? {} : { sample }),
    };
  }
  return {
    ...rest,
    ...(rule === undefined ? {} : { rule: viewerRule(rule) }),
    ...(rules === undefined ? {} : { rules: rules.map(viewerRule) }),
    ...(subjects?.ip === undefined ? {} : { subjects: { ip: subjects.ip } }),
  };
}
