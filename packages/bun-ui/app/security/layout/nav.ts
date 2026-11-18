/**
 * The sections (ui.md §2), only those built (the user's decision): the
 * analytics page (U2, in place of U1's Overview), U4's services (and
 * groups) and policies, U5's rules, U3's lists, bans and events, U5's
 * audit, approvals, agents and alerts, and the API
 * reference; later PRs add theirs. Each names the
 * permission it needs on the scope on screen; one the operator lacks is
 * absent from the nav.
 *
 * The list itself is the browser contract's `SECURITY_SECTIONS`
 * (`@kingsleyweb/bun-ui/security/browser`), so a host's side menu and this
 * nav are one list (embedding.md §2), filtered the same way
 * ({@link navSections}, the kit's `sectionsFor`).
 */
import type { SecurityApiPermission } from "@kingsleyweb/bun-security/control/contract";
import type { SecuritySection } from "../../../lib/security/browser/sections";
import { sectionsFor } from "../../../lib/kit/browser/sections";
import { SECURITY_SECTIONS } from "../../../lib/security/browser/sections";

/** A section. */
export type Section = SecuritySection;

/** The built sections, in nav order. */
export const SECTIONS: readonly Section[] = SECURITY_SECTIONS;

/** The sections the operator may use on the scope on screen, in nav order. */
export function navSections(
  scope: string | null,
  can: (permission: SecurityApiPermission) => boolean,
): Section[] {
  return sectionsFor(
    SECTIONS,
    (permission) => scope !== null && can(permission),
  );
}
