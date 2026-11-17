/**
 * Scopes (ui.md §2): every screen shows one scope — `global`, a group
 * (`group:<id>`) or a service (`service:<id>`) — named in the URL's `scope`,
 * so a link shares exactly what the sender saw.
 */
import type { OperatorDto } from "@kingsleyweb/bun-security/control/contract";

/** The URL parameter naming the scope. */
export const SCOPE_PARAM = "scope";

/** A scope's id pattern (the API's entity ids). */
const SCOPE = /^(?:global|(?:group|service):[A-Za-z0-9][\w.-]{0,127})$/;

/** Whether `text` is a scope. */
export function isScope(text: string): boolean {
  return SCOPE.test(text);
}

/** A scope's label for people: `Global`, `Group payments`, `Service checkout`. */
export function scopeLabel(scope: string): string {
  if (scope === "global") return "Global";
  const [kind, id] = scope.split(":") as [string, string];
  return `${kind === "group" ? "Group" : "Service"} ${id}`;
}

/**
 * The scope a screen shows when the URL names none (the user's decision):
 * `global` when the operator can read it, else their first readable group,
 * then service, from their role bindings; `null` when they can read none.
 */
export function defaultScope(
  canReadGlobal: boolean,
  roles: OperatorDto["roles"],
): string | null {
  if (canReadGlobal) return "global";
  const scopes = roles.map((role) => role.scope);
  return (
    scopes.find((scope) => scope.startsWith("group:")) ??
    scopes.find((scope) => scope.startsWith("service:")) ??
    null
  );
}

/** The scopes an operator without a global read can see: those their roles are bound on, in order, once each. */
export function boundScopes(roles: OperatorDto["roles"]): string[] {
  return [
    ...new Set(
      roles.map((role) => role.scope).filter((scope) => scope !== "global"),
    ),
  ];
}
