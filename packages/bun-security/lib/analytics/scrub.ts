/**
 * Rule ids an event or a counter may keep. A list entry's default id names
 * its subject, and a ban's id is its subject: the engine reports both keyed
 * (`apiKey:<HMAC>`, `user:<HMAC>`, `ban:user:<HMAC>`), as the decision's
 * subject is. Each is still rewritten to the request's own key (the
 * decision's `subject.apiKey` or `subject.user`), or `[redacted]` without
 * one, so a rule id written into analytics can never carry more than the
 * subject does.
 *
 * An entry the operator gave its own `id` keeps it: an id is the
 * operator's name for the entry, not the subject.
 */
import type { SubjectKeys } from "../engine/decision";
import { REDACTED } from "./redact";

/** A rule id with the ids it may carry replaced by the subject's keys (see the module's description). */
export function scrubRule(rule: string, subject: SubjectKeys): string {
  if (rule.startsWith("apiKey:")) return `apiKey:${subject.apiKey ?? REDACTED}`;
  if (rule.startsWith("user:")) return `user:${subject.user ?? REDACTED}`;
  if (rule.startsWith("ban:user:")) {
    return `ban:user:${subject.user ?? REDACTED}`;
  }
  return rule;
}
