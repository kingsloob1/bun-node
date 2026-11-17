/**
 * Scopes (control-plane.md §2.2, §5.2): `global`, `group:<id>` and
 * `service:<id>`, the chain each has above it, and parsing them.
 */
import type { PolicyScopeId } from "./contract/types";

/** An entity id: letters, digits, `_`, `.` and `-`, starting with a letter or digit, at most 64. */
export const ENTITY_ID = /^[a-z\d][\w.-]{0,63}$/i;

/** A parsed scope. */
export type ParsedScope =
  | { readonly kind: "global" }
  | { readonly kind: "group"; readonly id: string }
  | { readonly kind: "service"; readonly id: string };

/** Parses `scope`; `undefined` when it is not one. */
export function parseScope(scope: string): ParsedScope | undefined {
  if (scope === "global") return { kind: "global" };
  const colon = scope.indexOf(":");
  if (colon < 0) return undefined;
  const kind = scope.slice(0, colon);
  const id = scope.slice(colon + 1);
  if (!ENTITY_ID.test(id)) return undefined;
  if (kind === "group" || kind === "service") return { kind, id };
  return undefined;
}

/** The scope id of a group. */
export const groupScope = (id: string): PolicyScopeId => `group:${id}`;

/** The scope id of a service. */
export const serviceScope = (id: string): PolicyScopeId => `service:${id}`;
