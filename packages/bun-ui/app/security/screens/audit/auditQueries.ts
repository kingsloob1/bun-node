/** The audit screens' types, query keys and filters (URL parameters). */
import type { Routes } from "../../api/routes.gen";
import { numberParam } from "../../components/urlParams";

/** An audit entry as the API returns it. */
export type AuditEntryDto =
  Routes["GET /audit"]["responses"][200]["items"][number];

/** `GET /audit/verify`. */
export type AuditVerifyDto = Routes["GET /audit/verify"]["responses"][200];

/** A signed checkpoint. */
export type AuditCheckpointDto =
  Routes["GET /audit/checkpoints"]["responses"][200]["items"][number];

/** The list's filters, as the URL holds them. */
export interface AuditFilters {
  /** One operator's entries, or empty. */
  readonly actor: string;
  /** One action (`policy.publish`), or empty. */
  readonly action: string;
  /** Entries at or after, epoch ms. */
  readonly since: number | undefined;
  /** Entries before, epoch ms. */
  readonly until: number | undefined;
  /** Newest first (the default) or oldest first. */
  readonly direction: "asc" | "desc";
}

/** The filters in `params`, defaulted. */
export function auditFiltersOf(params: URLSearchParams): AuditFilters {
  return {
    actor: params.get("actor") ?? "",
    action: params.get("action") ?? "",
    since: numberParam(params, "since"),
    until: numberParam(params, "until"),
    direction: params.get("direction") === "asc" ? "asc" : "desc",
  };
}

/** The list query for `filters` on `scope` (`global` reads every scope's entries). */
export function auditQuery(
  scope: string,
  filters: AuditFilters,
): {
  scope?: string;
  actor?: string;
  action?: string;
  since?: number;
  until?: number;
  direction: "asc" | "desc";
} {
  return {
    ...(scope === "global" ? {} : { scope }),
    ...(filters.actor.trim() === "" ? {} : { actor: filters.actor.trim() }),
    ...(filters.action.trim() === "" ? {} : { action: filters.action.trim() }),
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
    direction: filters.direction,
  };
}

/** The audit screens' query keys. */
export const auditKeys = {
  /** A page of the list. */
  list: (
    scope: string,
    filters: AuditFilters,
    cursor: string | undefined,
    limit: number,
  ) => ["audit", "list", scope, filters, cursor ?? null, limit] as const,
  /** One entry. */
  entry: (n: number) => ["audit", "entry", n] as const,
  /** The chain's verification (run on demand). */
  verify: () => ["audit", "verify"] as const,
  /** The latest signed checkpoint. */
  checkpoint: () => ["audit", "checkpoint"] as const,
};

/** An entry's phase and reconciled status, for people. */
export function phaseOf(entry: AuditEntryDto): string {
  if (entry.phase === "event") return "Event";
  if (entry.phase === "done") return "Done";
  switch (entry.status) {
    case "done":
      return "Intent, done";
    case "completed-unconfirmed":
      return "Intent, applied (no done entry)";
    case "not-applied":
      return "Intent, not applied";
    default:
      return "Intent";
  }
}
