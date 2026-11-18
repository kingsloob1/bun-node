/** The approvals screens' types, keys and wording. */
import type { SecurityApiPermission } from "@kingsleyweb/bun-security/control/contract";
import type { BadgeTone } from "../../../kit/components/Badge";
import type { Routes } from "../../api/routes.gen";

/** An approval as the API returns it. */
export type ApprovalDto =
  Routes["GET /approvals"]["responses"][200]["items"][number];

/** The approvals screens' query keys. */
export const approvalKeys = {
  /** A page of the list. */
  list: (cursor: string | undefined, limit: number) =>
    ["approvals", "list", cursor ?? null, limit] as const,
  /** One approval. */
  detail: (id: string) => ["approvals", "detail", id] as const,
  /** Its policy change's diff. */
  diff: (id: string) => ["approvals", "diff", id] as const,
};

/** What an approval would do, for people. */
export const ACTIONS: Record<ApprovalDto["action"], string> = {
  "policy.publish": "Publish a policy",
  "policy.rollback": "Roll a policy back",
  "roleBinding.create": "Bind a role",
  "roleBinding.delete": "Remove a role binding",
  "serviceIdentity.put": "Change a service identity",
  "serviceIdentity.delete": "Remove a service identity",
  "bans.lift": "Lift matching bans",
};

/** A status, for people, and its badge's tone. */
export const STATUSES: Record<
  ApprovalDto["status"],
  { readonly label: string; readonly tone: BadgeTone }
> = {
  pending: { label: "Pending", tone: "warning" },
  review: { label: "Review (published in an emergency)", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
  stale: { label: "Stale (the policy moved on)", tone: "neutral" },
};

/** Whether an approval changes a policy (so it has a diff and an impact estimate). */
export function changesPolicy(approval: ApprovalDto): boolean {
  return approval.action.startsWith("policy.");
}

/**
 * The permission that decides `approval` on its scope: the one its change
 * needs (the control plane's `permissionFor`).
 */
export function decidingPermission(
  approval: ApprovalDto,
): SecurityApiPermission {
  if (approval.action.startsWith("policy.")) return "policy:publish";
  if (approval.action.startsWith("roleBinding.")) return "roles:write";
  if (approval.action.startsWith("bans.")) return "bans:write";
  return "identities:write";
}

/** Whether an approval may still be decided. */
export function isOpen(approval: ApprovalDto): boolean {
  return approval.status === "pending" || approval.status === "review";
}
