/**
 * The management API's constants (control-plane.md §4, §5): browser-safe,
 * with no import, for the UI and any client.
 */

/** The management API's protocol version, reported by `GET /meta`. */
export const SECURITY_API_PROTOCOL_VERSION = 1;

/** A signed bundle's format id (control-plane.md §3.1). */
export const BUNDLE_FORMAT = "bun-security.bundle/1";

/** The header a mutation carries for the API's CSRF check, unless configured otherwise. */
export const DEFAULT_SECURITY_CSRF_HEADER = "x-bun-security-csrf";

/** A list's page size when the request names none (ui.md §5). */
export const DEFAULT_API_PAGE_LIMIT = 50;

/** The largest page a list answers (ui.md §5). */
export const MAX_API_PAGE_LIMIT = 200;

/** The deepest a group may nest (control-plane.md §2.1). */
export const MAX_GROUP_DEPTH = 4;

/**
 * Every permission the management API checks, by name (control-plane.md
 * §5.2): a host's `authorize(operator, permission, target)` receives one
 * of these, and `GET /meta/permissions` answers each.
 */
export const SECURITY_API_PERMISSIONS = /* @__PURE__ */ Object.freeze([
  "services:read",
  "services:write",
  "groups:read",
  "groups:write",
  "identities:read",
  "identities:write",
  "policy:read",
  "policy:draft",
  "policy:publish",
  "bundles:read",
  "approvals:read",
  "roles:read",
  "roles:write",
] as const);

/** A permission's name. */
export type SecurityApiPermission = (typeof SECURITY_API_PERMISSIONS)[number];

/** The built-in roles, least to most (control-plane.md §5.2). */
export const SECURITY_ROLES = /* @__PURE__ */ Object.freeze([
  "viewer",
  "analyst",
  "operator",
  "admin",
  "owner",
] as const);

/** A built-in role's name. */
export type SecurityRole = (typeof SECURITY_ROLES)[number];

/**
 * What each built-in role may do: a role holds every permission of the
 * roles before it, and these (control-plane.md §5.2; bans, lists, events,
 * agents and alerts join with their PRs).
 */
export const ROLE_PERMISSIONS: Readonly<
  Record<SecurityRole, readonly SecurityApiPermission[]>
> = /* @__PURE__ */ Object.freeze({
  viewer: /* @__PURE__ */ Object.freeze([
    "services:read",
    "groups:read",
    "policy:read",
    "bundles:read",
    "approvals:read",
  ] as const),
  analyst: /* @__PURE__ */ Object.freeze(["identities:read"] as const),
  operator: /* @__PURE__ */ Object.freeze(["policy:draft"] as const),
  admin: /* @__PURE__ */ Object.freeze([
    "services:write",
    "groups:write",
    "identities:write",
    "policy:publish",
  ] as const),
  owner: /* @__PURE__ */ Object.freeze(["roles:read", "roles:write"] as const),
});

/** The problem codes the management API answers with, beside its status. */
export const SECURITY_API_ERROR_CODES = /* @__PURE__ */ Object.freeze([
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "csrf",
  "step_up_required",
  "not_found",
  "conflict",
  "invalid_policy",
  "locked",
  "confirmation_required",
  "approval_required",
  "approval_closed",
  "self_approval",
  "not_modified",
  "internal",
] as const);

/** A problem code. */
export type SecurityApiErrorCode = (typeof SECURITY_API_ERROR_CODES)[number];

/** The events `GET /live` streams (CP2's; analytics and bans join with PR-CP5). */
export const SECURITY_LIVE_EVENTS = /* @__PURE__ */ Object.freeze([
  "policy.published",
  "bundle.compiled",
  "approval.created",
  "approval.decided",
] as const);

/** A live event's name. */
export type SecurityLiveEventName = (typeof SECURITY_LIVE_EVENTS)[number];
