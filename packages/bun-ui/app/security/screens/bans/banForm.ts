/** The ban form's fields, pre-fill (the URL contract) and checks. */
import { parseAddressOrRange } from "../../components/addresses";

/** The subject fields the form takes, and the pre-fill parameters among them. */
export type SubjectField = "ip" | "user" | "apiKey" | "userHash" | "apiKeyHash";

/** Each field's label. */
export const FIELD_LABELS: Readonly<Record<SubjectField, string>> = {
  ip: "Address or range",
  user: "User id (keyed on save, never kept)",
  apiKey: "API key id (keyed on save, never kept)",
  userHash: "User key (as the API reports it)",
  apiKeyHash: "API key key (as the API reports it)",
};

/** The durations offered; `permanent` sends `null`. */
export const DURATIONS = ["1h", "24h", "7d", "30d", "permanent"] as const;

/** Whether `value` is valid for `field` as typed (the API checks again). */
export function validSubject(field: SubjectField, value: string): boolean {
  const text = value.trim();
  if (field === "userHash" || field === "apiKeyHash")
    return /^[\da-f]{32}$/.test(text);
  if (field === "ip") {
    // A range must be narrower than its whole family (the API refuses /0).
    const parsed = parseAddressOrRange(text);
    return parsed !== null && parsed.bits >= 1;
  }
  return text.length > 0 && text.length <= 512;
}

/** What the URL pre-fills: the subject field and value (flagged when bad), and the rest. */
export function prefillOf(search: string): {
  field: SubjectField;
  value: string;
  flagged: boolean;
  action: "ban" | "challenge";
  duration: (typeof DURATIONS)[number];
  reason: string;
} {
  const params = new URLSearchParams(search);
  const given = (["ip", "userHash", "apiKeyHash"] as const).filter((name) =>
    params.has(name),
  );
  const field: SubjectField = given[0] ?? "ip";
  const raw = given[0] === undefined ? "" : (params.get(given[0]) ?? "");
  const flagged = given.length > 1 || (raw !== "" && !validSubject(field, raw));
  const duration = params.get("duration");
  return {
    field,
    value: flagged ? "" : raw,
    flagged,
    action: params.get("action") === "challenge" ? "challenge" : "ban",
    duration: (DURATIONS as readonly string[]).includes(duration ?? "")
      ? (duration as (typeof DURATIONS)[number])
      : "24h",
    reason: (params.get("reason") ?? "").slice(0, 500),
  };
}
