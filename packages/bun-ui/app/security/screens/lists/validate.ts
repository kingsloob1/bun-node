/**
 * One list entry as the operator writes it (the new-entry form, a CSV
 * row), checked the way bun-security's policy schema checks it
 * (`checkEntry` in `lib/policy/schema.ts`) before anything is sent: each
 * field's problem by name, so the form flags the field and the import names
 * the line. A malformed account key is never echoed: it may be an account
 * id typed in the wrong field.
 */
import type { ListAction, ListEntryDto, ListMode } from "./entries";
import { parseCidr, WIDEST_ALLOW } from "../../components/cidr";
import {
  ACCOUNT_ID_RE,
  ACCOUNT_KEY_RE,
  LIST_ACTIONS,
  LIST_MODES,
  TIMESTAMP_RE,
} from "./entries";

/** The subject kinds an entry may be written as. */
export type InputKind =
  "ip" | "user" | "userHash" | "apiKey" | "apiKeyHash" | "country" | "asn";

/** Every input kind, in the form's order. */
export const INPUT_KINDS: readonly InputKind[] = [
  "ip",
  "userHash",
  "user",
  "apiKeyHash",
  "apiKey",
  "country",
  "asn",
];

/** Each input kind's label. */
export const INPUT_KIND_LABELS: Readonly<Record<InputKind, string>> = {
  ip: "IP address or CIDR range",
  userHash: "User key",
  user: "User id (keyed when saved)",
  apiKeyHash: "API key's key",
  apiKey: "API key id (keyed when saved)",
  country: "Country",
  asn: "ASN",
};

/** An entry as written. */
export interface EntryInput {
  /** The subject's kind. */
  kind: InputKind | "";
  /** The subject's value. */
  value: string;
  /** The action. */
  action: ListAction | "";
  /** Win over a block in the same scope (allow only). */
  override: boolean;
  /** Lower scopes cannot override it. */
  locked: boolean;
  /** Route prefixes, separated by commas, semicolons or spaces; empty for every path. */
  paths: string;
  /** When it stops applying, ISO 8601 with its zone; empty for never. */
  expiresAt: string;
  /** Why it exists. */
  reason: string;
  /** The mode; empty for the default (`enforce`). */
  mode: ListMode | "";
}

/** The fields a problem can be about. */
export type EntryField =
  | "kind"
  | "value"
  | "action"
  | "override"
  | "paths"
  | "expiresAt"
  | "reason"
  | "mode";

/** A checked entry: the entry, or each field's problem. */
export type CheckedEntry =
  | { readonly ok: true; readonly entry: ListEntryDto }
  | {
      readonly ok: false;
      readonly errors: Partial<Record<EntryField, string>>;
    };

/** The longest reason accepted. */
export const MAX_REASON = 1024;

/** The problem with `value` for `kind`, or `undefined`. */
export function valueProblem(
  kind: InputKind,
  value: string,
): string | undefined {
  const text = value.trim();
  if (text === "") return "Required";
  switch (kind) {
    case "ip": {
      const cidr = parseCidr(text);
      if (cidr === null) return "Not an IP address or CIDR range";
      if (cidr.bits === 0)
        return "A /0 range covers every address of its family; use a request rule instead";
      return undefined;
    }
    case "userHash":
    case "apiKeyHash":
      return ACCOUNT_KEY_RE.test(text)
        ? undefined
        : `Not ${kind === "userHash" ? "a user's" : "an API key's"} key: 32 lower-case hex characters`;
    case "user":
    case "apiKey":
      return ACCOUNT_ID_RE.test(text)
        ? undefined
        : `Not ${kind === "user" ? "a user id" : "an API key id"} (1-256 characters, no spaces)`;
    case "country":
      return /^[A-Z]{2}$/.test(text)
        ? undefined
        : "Not an ISO 3166-1 alpha-2 country code in upper case (KP)";
    case "asn": {
      const digits = text.replace(/^AS/i, "");
      const asn = Number(digits);
      return /^\d{1,10}$/.test(digits) && asn <= 4_294_967_295
        ? undefined
        : "Not an autonomous system number (0 to 4294967295)";
    }
  }
}

/** The paths written in `text`. */
export function splitPaths(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((path) => path.trim())
    .filter((path) => path !== "");
}

/** Checks `input`; see the module's description. */
export function checkEntry(input: EntryInput): CheckedEntry {
  const errors: Partial<Record<EntryField, string>> = {};
  const value = input.value.trim();
  if (input.kind === "") errors.kind = "Required";
  else {
    const problem = valueProblem(input.kind, value);
    if (problem !== undefined) errors.value = problem;
  }
  if (input.action === "" || !LIST_ACTIONS.includes(input.action))
    errors.action = "Required";
  else if (input.action === "allow") {
    if (input.kind === "country")
      errors.action =
        "A whole country cannot be allowed (the policy refuses it): allow its addresses or ASNs instead";
    if (input.kind === "ip" && errors.value === undefined) {
      const cidr = parseCidr(value)!;
      if (cidr.bits < WIDEST_ALLOW[cidr.family])
        errors.value = `An allow entry wider than /${WIDEST_ALLOW[cidr.family]} is refused`;
    }
  }
  if (input.override && input.action !== "allow")
    errors.override = "Only an allow entry can override";
  const paths = splitPaths(input.paths);
  if (paths.length > 64) errors.paths = "At most 64 route prefixes";
  else if (paths.some((path) => !path.startsWith("/") || path.length > 1024))
    errors.paths = 'Each route prefix starts with "/"';
  const expiresAt = input.expiresAt.trim();
  if (
    expiresAt !== "" &&
    !(TIMESTAMP_RE.test(expiresAt) && Number.isFinite(Date.parse(expiresAt)))
  ) {
    errors.expiresAt =
      'Not an ISO 8601 timestamp with its time zone ("2026-12-01T00:00:00Z")';
  }
  if (input.reason.length > MAX_REASON)
    errors.reason = `At most ${MAX_REASON} characters`;
  if (input.mode !== "" && !LIST_MODES.includes(input.mode))
    errors.mode = `One of ${LIST_MODES.join(", ")}`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const kind = input.kind as InputKind;
  const subject =
    kind === "asn"
      ? { asn: Number(value.replace(/^AS/i, "")) }
      : { [kind]: value };
  const entry: ListEntryDto = {
    ...subject,
    action: input.action as ListAction,
    ...(input.override ? { override: true } : {}),
    ...(input.locked ? { locked: true } : {}),
    ...(paths.length === 0 ? {} : { paths }),
    ...(expiresAt === "" ? {} : { expiresAt }),
    ...(input.mode === "" || input.mode === "enforce"
      ? {}
      : { mode: input.mode }),
    ...(input.reason.trim() === "" ? {} : { reason: input.reason.trim() }),
  };
  return { ok: true, entry };
}

/** An empty input. */
export function emptyInput(): EntryInput {
  return {
    kind: "ip",
    value: "",
    action: "block",
    override: false,
    locked: false,
    paths: "",
    expiresAt: "",
    reason: "",
    mode: "",
  };
}
