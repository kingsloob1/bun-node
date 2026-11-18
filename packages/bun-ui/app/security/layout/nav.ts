/**
 * The sections (ui.md §2), only those built (the user's decision): the
 * analytics page (U2, in place of U1's Overview), U4's services (and
 * groups) and policies, U5's rules, U3's lists, bans and events, U5's
 * audit, approvals, agents and alerts, and the API
 * reference; later PRs add theirs. Each names the
 * permission it needs on the scope on screen; one the operator lacks is
 * absent from the nav.
 */
import type { SecurityApiPermission } from "@kingsleyweb/bun-security/control/contract";

/** A section. */
export interface Section {
  /** Its id. */
  readonly id: string;
  /** Its label. */
  readonly label: string;
  /** Its path under the mount. */
  readonly path: string;
  /** What it needs on the scope; `null` for nothing beyond signing in. */
  readonly needs: SecurityApiPermission | null;
}

/** The built sections, in nav order. */
export const SECTIONS: readonly Section[] = [
  { id: "analytics", label: "Analytics", path: "/", needs: "analytics:read" },
  {
    id: "services",
    label: "Services",
    path: "/services",
    needs: "services:read",
  },
  {
    id: "policies",
    label: "Policies",
    path: "/policies",
    needs: "policy:read",
  },
  { id: "rules", label: "Rules", path: "/rules", needs: "policy:read" },
  { id: "lists", label: "Lists", path: "/lists", needs: "policy:read" },
  { id: "bans", label: "Bans", path: "/bans", needs: "bans:read" },
  { id: "events", label: "Events", path: "/events", needs: "analytics:read" },
  { id: "audit", label: "Audit", path: "/audit", needs: "audit:read" },
  {
    id: "approvals",
    label: "Approvals",
    path: "/approvals",
    needs: "approvals:read",
  },
  { id: "agents", label: "Agents", path: "/agents", needs: "agents:read" },
  { id: "alerts", label: "Alerts", path: "/alerts", needs: "alerts:read" },
  { id: "api", label: "API reference", path: "/api", needs: null },
];
