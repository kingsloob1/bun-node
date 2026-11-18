/** The agents screens' types, keys and wording. */
import type { BadgeTone } from "../../../kit/components/Badge";
import type { Routes } from "../../api/routes.gen";

/** An agent as the API returns it. */
export type AgentDto = Routes["GET /agents"]["responses"][200]["items"][number];

/** The agents screens' query keys. */
export const agentKeys = {
  /** A page of the list. */
  list: (cursor: string | undefined, limit: number) =>
    ["agents", "list", cursor ?? null, limit] as const,
  /** One agent. */
  detail: (id: string) => ["agents", "detail", id] as const,
};

/** An agent's state, for people, and its badge's tone. */
export const STATUS: Record<
  AgentDto["status"],
  { readonly label: string; readonly tone: BadgeTone }
> = {
  "never-seen": { label: "Never seen", tone: "neutral" },
  ok: { label: "OK", tone: "success" },
  late: { label: "Late", tone: "warning" },
  offline: { label: "Offline", tone: "danger" },
  "signature-failing": { label: "Signature failing", tone: "danger" },
  revoked: { label: "Revoked", tone: "neutral" },
};

/** Whether the API answered that agents are not configured (a 404 on the route). */
export function agentsOff(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}
