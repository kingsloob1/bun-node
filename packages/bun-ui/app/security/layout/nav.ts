/**
 * The sections (ui.md §2), only those built (the user's decision): U1 has
 * the Overview and the API reference, U3 lists, bans and events; later PRs
 * add theirs. Each names the
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
  { id: "overview", label: "Overview", path: "/", needs: "policy:read" },
  { id: "lists", label: "Lists", path: "/lists", needs: "policy:read" },
  { id: "bans", label: "Bans", path: "/bans", needs: "bans:read" },
  { id: "events", label: "Events", path: "/events", needs: "analytics:read" },
  { id: "api", label: "API reference", path: "/api", needs: null },
];
