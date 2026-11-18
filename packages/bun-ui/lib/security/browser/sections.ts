/**
 * The security UI's sections (ui.md §2), the list its own nav reads
 * (`app/security/layout/nav.ts`) and a host's side menu is built from
 * (embedding.md §2). Each names the permission it needs on the scope on
 * screen, a bun-security `SecurityApiPermission` (spelled out here, so this
 * browser-safe entry imports no domain package; `app/security`'s type test
 * holds each to that union). Filter it with `sectionsFor`.
 */
import type { UiSection } from "../../kit/browser/sections";

/** The security UI's sections, in nav order. */
export const SECURITY_SECTIONS = Object.freeze([
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
] as const satisfies readonly UiSection[]);

/** One of {@link SECURITY_SECTIONS}. */
export type SecuritySection = (typeof SECURITY_SECTIONS)[number];

/** A permission one of {@link SECURITY_SECTIONS} needs. */
export type SecuritySectionPermission = NonNullable<SecuritySection["needs"]>;
