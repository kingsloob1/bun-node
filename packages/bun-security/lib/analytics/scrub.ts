/**
 * Rule ids an event or a counter may keep. A list entry's default id is its
 * subject (`policy/schema.ts`'s `defaultEntryId`), so an API key's entry is
 * `apiKey:<the key's id>` and a user's `user:<the user id>`, and a ban on
 * a user is `ban:user:<the user id>`: written into analytics as they are,
 * they would keep the raw ids S11 keys by HMAC everywhere else. Each is
 * rewritten to the request's own key (the decision's `subject.apiKey`, the
 * HMAC; the user's key from `userKey`), or `[redacted]` without one.
 *
 * An entry the operator gave its own `id` keeps it: an id is the
 * operator's name for the entry, not the subject.
 */
import type { SubjectKeys } from "../engine/decision";
import { REDACTED } from "./redact";

/** A rule id with the raw ids it may carry replaced (see the module's description). */
export function scrubRule(
  rule: string,
  subject: SubjectKeys,
  userKey: ((user: string) => string) | undefined,
): string {
  const user = (): string =>
    subject.user !== undefined && userKey !== undefined
      ? userKey(subject.user)
      : REDACTED;
  if (rule.startsWith("apiKey:")) return `apiKey:${subject.apiKey ?? REDACTED}`;
  if (rule.startsWith("user:")) return `user:${user()}`;
  if (rule.startsWith("ban:user:")) return `ban:user:${user()}`;
  return rule;
}
