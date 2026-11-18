/**
 * The links that hand an event's subject to another screen's form, pre-
 * filled (the URL contract U2's activity feed and the events drawer share):
 * the ban form, `/bans/new?scope=<scope>&ip=<address>` (or `userHash`, or
 * `apiKeyHash`, an account's key as the API reports it), and the list-entry
 * form, `/lists/new?scope=<scope>&ip=<address>`.
 */
import type { SubjectKind } from "../../components/Subject";
import type { EventDto } from "./eventFilters";

/** A subject the ban form takes, and the parameter it is passed in. */
export interface BannableSubject {
  /** Its kind. */
  readonly kind: Extract<SubjectKind, "ip" | "user" | "apiKey">;
  /** Its value, as the API reports it (an account's key, never its id). */
  readonly value: string;
  /** The ban form's parameter. */
  readonly param: "ip" | "userHash" | "apiKeyHash";
}

/** The ban form's parameter for each kind it takes. */
const BAN_PARAMS = {
  ip: "ip",
  user: "userHash",
  apiKey: "apiKeyHash",
} as const;

/** The subjects of `event` the ban form takes, address first (a username's key is not one). */
export function bannableSubjects(
  event: Pick<EventDto, "subjects">,
): BannableSubject[] {
  const subjects = event.subjects ?? {};
  return (["ip", "user", "apiKey"] as const)
    .filter(
      (kind) => typeof subjects[kind] === "string" && subjects[kind] !== "",
    )
    .map((kind) => ({
      kind,
      value: subjects[kind]!,
      param: BAN_PARAMS[kind],
    }));
}

/** The ban form, pre-filled with `subject` on `scope`. */
export function banFormPath(scope: string, subject: BannableSubject): string {
  const params = new URLSearchParams({ scope });
  params.set(subject.param, subject.value);
  return `/bans/new?${params.toString()}`;
}

/** The list-entry form, pre-filled with the address `ip` on `scope`. */
export function listFormPath(scope: string, ip: string): string {
  const params = new URLSearchParams({ scope, ip });
  return `/lists/new?${params.toString()}`;
}
