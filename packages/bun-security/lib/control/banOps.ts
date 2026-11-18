/**
 * What the bans endpoints (PR-U3) work out before they touch a ban: a
 * subject from what the operator gave, the subject values a search names
 * (an address and every range holding it), and a subject's country and ASN
 * from its latest event.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type { SecurityStoreDriver, StoredBanSubject } from "../store/types";
import type { ResolvedSecurityApiOptions } from "./options";
import { boundKey } from "../engine/identity";
import { isWholeFamilyRange, parseAddress, parseCidr } from "../ip/address";
import { ApiProblem } from "./problems";

/** A ban list's query, as the plane takes it (`GET /bans`). */
export interface BanListQuery {
  /** The page size. */
  readonly limit: number;
  /** The previous page's `next`. */
  readonly cursor?: string;
  /** The scope, and what is under it. */
  readonly scope?: string;
  /** In force now, or not. */
  readonly active?: boolean;
  /** The subject's kind. */
  readonly kind?: StoredBanSubject["type"];
  /** The source. */
  readonly source?: "auto" | "manual";
  /** The rule that wrote it. */
  readonly rule?: string;
  /** An address, a range or an account key ({@link banSearchValues}). */
  readonly search?: string;
  /** The order. */
  readonly sort?: "id" | "created" | "expires";
  /** The direction. */
  readonly direction?: "asc" | "desc";
}

/** The most bans a bulk lift lifts in one call; a filter matching more is refused, to be narrowed. */
export const BULK_LIFT_LIMIT = 10_000;

/** The field a ban's subject came in: the address, the raw account id, or its key. */
export type BanSubjectField =
  "ip" | "user" | "apiKey" | "userHash" | "apiKeyHash";

/**
 * The stored subject for what the operator gave: an address or range in
 * its canonical text, a raw account id keyed as the engines key it (never
 * stored), or an account key used as it is. A `400` for anything else, or
 * for an account kind this control plane does not take.
 */
export function banSubjectOf(
  field: BanSubjectField,
  value: string,
  options: Pick<ResolvedSecurityApiOptions, "banKeys" | "banKinds">,
): StoredBanSubject {
  if (field === "ip") {
    const address = parseAddress(value);
    if (address !== null) return { type: "ip", value: address.text };
    const range = parseCidr(value);
    if (range !== null && !isWholeFamilyRange(value)) {
      return { type: "cidr", value: range.text };
    }
    throw new ApiProblem(
      400,
      "invalid_request",
      `"${value}" is not an address or a CIDR range narrower than a whole family`,
    );
  }
  const kind = field === "apiKey" || field === "apiKeyHash" ? "apiKey" : "user";
  const keys = options.banKeys;
  if (keys === undefined || !options.banKinds[kind]) {
    throw new ApiProblem(
      400,
      "invalid_request",
      kind === "apiKey"
        ? "this control plane takes no API-key bans (bans.apiKeys: false)"
        : "this control plane takes no user bans (bans.users: false)",
    );
  }
  if (field === "userHash" || field === "apiKeyHash") {
    if (!/^[\da-f]{32}$/.test(value)) {
      throw new ApiProblem(
        400,
        "invalid_request",
        `${field} must be the 32 hex characters the API reports`,
      );
    }
    return { type: kind, value };
  }
  return {
    type: kind,
    value:
      kind === "apiKey"
        ? keys.apiKey(boundKey(value))
        : keys.user(boundKey(value)),
  };
}

/**
 * The subject values a ban search names (the store matches them exactly):
 * for an address, itself (as typed and canonical) and every range holding
 * it, narrower than its whole family; for a range, itself and every wider
 * range holding it; for an account key (32 hex characters), itself. A
 * `400` for anything else: a search never takes a raw account id.
 */
export function banSearchValues(search: string): string[] {
  const text = search.trim();
  if (/^[\da-f]{32}$/.test(text)) return [text];
  const address = parseAddress(text);
  const range = address === null ? parseCidr(text) : null;
  if (address === null && range === null) {
    throw new ApiProblem(
      400,
      "invalid_request",
      "search takes an address, a CIDR range or an account key (32 hex characters)",
    );
  }
  const family = (address ?? range)!.family;
  const base = address?.text ?? range!.text.split("/")[0]!;
  const widest = address === null ? range!.bits : family === 4 ? 32 : 128;
  const values = new Set<string>([text]);
  if (address !== null) values.add(address.text);
  for (let bits = 1; bits <= widest; bits++) {
    const prefix = parseCidr(`${base}/${bits}`);
    if (prefix !== null) values.add(prefix.text);
  }
  return [...values];
}

/**
 * The subject's country and ASN from its latest event (an address, a user
 * or an API key; a range has no event of its own), to record on its ban;
 * nothing when the store keeps no events or none is known. A failing read
 * is logged and never blocks the ban.
 */
export async function subjectFacts(
  store: SecurityStoreDriver,
  subject: StoredBanSubject,
  logger: Logger,
): Promise<{ country?: string; asn?: number }> {
  const listEvents = store.listEvents;
  if (listEvents === undefined || subject.type === "cidr") return {};
  const filter =
    subject.type === "ip"
      ? { ip: subject.value }
      : subject.type === "user"
        ? { user: subject.value }
        : { apiKey: subject.value };
  try {
    const page = await listEvents({ limit: 1, direction: "desc", ...filter });
    const latest = page.items[0];
    if (latest === undefined) return {};
    return {
      ...(latest.country === undefined ? {} : { country: latest.country }),
      ...(latest.asn === undefined ? {} : { asn: latest.asn }),
    };
  } catch (error) {
    logger.warn("bun-security: a ban's country and ASN were not read", {
      error,
    });
    return {};
  }
}

/**
 * The stored subject of a reported ban (`POST /agent/ban-reports`): an
 * address or range in its canonical text (an engine's IPv6 address key is
 * its /64), or an account's key as it is; `undefined` for anything else.
 */
export function reportedSubject(subject: {
  readonly type: string;
  readonly value: string;
}): StoredBanSubject | undefined {
  if (subject.type === "user" || subject.type === "apiKey") {
    return /^[\da-f]{32}$/.test(subject.value)
      ? { type: subject.type, value: subject.value }
      : undefined;
  }
  if (subject.type !== "ip" && subject.type !== "cidr") return undefined;
  const address = parseAddress(subject.value);
  if (address !== null) return { type: "ip", value: address.text };
  const range = parseCidr(subject.value);
  if (range !== null && !isWholeFamilyRange(subject.value)) {
    return { type: "cidr", value: range.text };
  }
  return undefined;
}
