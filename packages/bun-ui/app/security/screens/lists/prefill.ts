/**
 * The new-entry form's pre-fill (ui.md §4.1): the parameters other screens
 * link to `/lists/new` with — one subject (`ip`, `country`, `asn`,
 * `userHash`, `apiKeyHash`), an optional `action` and `reason` — read into
 * the form's start, each bad value left empty and flagged (never echoed).
 */
import type { ListAction } from "./entries";
import type { EntryField, EntryInput, InputKind } from "./validate";
import { LIST_ACTIONS } from "./entries";
import { emptyInput, INPUT_KIND_LABELS, valueProblem } from "./validate";

/** The subject parameters a link may pre-fill, in the order they are read. */
export const PREFILL_SUBJECTS = [
  "ip",
  "country",
  "asn",
  "userHash",
  "apiKeyHash",
] as const satisfies readonly InputKind[];

/** Each field's problem. */
export type Problems = Partial<Record<EntryField, string>>;

/** The form's start from the link's parameters, and what the link got wrong. */
export function prefill(search: string): {
  input: EntryInput;
  problems: Problems;
} {
  const params = new URLSearchParams(search);
  const input = emptyInput();
  const problems: Problems = {};
  const named = PREFILL_SUBJECTS.filter((name) => params.has(name));
  if (named.length > 1) {
    input.kind = "";
    problems.kind = `The link named more than one subject (${named.join(", ")}): choose one`;
  } else if (named.length === 1) {
    const kind = named[0];
    const raw = params.get(kind)!.trim();
    const value = kind === "country" ? raw.toUpperCase() : raw;
    input.kind = kind;
    if (valueProblem(kind, value) === undefined) input.value = value;
    else
      problems.value = `The link's ${INPUT_KIND_LABELS[kind].toLowerCase()} was not valid: enter it again`;
  }
  const action = params.get("action");
  if (action !== null) {
    if (
      (LIST_ACTIONS as readonly string[]).includes(action) &&
      !(action === "allow" && input.kind === "country")
    ) {
      input.action = action as ListAction;
    } else {
      input.action = "";
      problems.action =
        action === "allow" && input.kind === "country"
          ? "A whole country cannot be allowed: choose another action"
          : "The link's action was not one of allow, block, challenge, drop";
    }
  }
  const reason = params.get("reason");
  if (reason !== null) input.reason = reason;
  return { input, problems };
}
