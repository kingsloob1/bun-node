/**
 * The management API's wire types (control-plane.md §2, §4): what each
 * route takes and answers, browser-safe and import-free, for the UI and
 * any typed client. The server's schemas are checked against them.
 */
import type {
  SecurityApiErrorCode,
  SecurityApiPermission,
  SecurityLiveEventName,
  SecurityRole,
} from "./constants";

/**
 * A policy's scope: `global`, `group:<id>` or `service:<id>`
 * (control-plane.md §2.2).
 */
export type PolicyScopeId = string;

/** A page of a list (ui.md §5): keyset, with an opaque cursor bound to its walk. */
export interface PageDto<T> {
  /** The items, in order. */
  readonly items: readonly T[];
  /** The next page's cursor; absent on the last. */
  readonly next?: string;
  /** About how many the walk has, where that is cheap. */
  readonly totalEstimate?: number;
}

/** A problem answer (RFC 9457), as every refusal and error is sent. */
export interface ProblemDto {
  /** `urn:bun-security:problem:<code>`. */
  readonly type: string;
  /** A short summary. */
  readonly title: string;
  /** The HTTP status. */
  readonly status: number;
  /** The machine-readable code. */
  readonly code: SecurityApiErrorCode;
  /** What went wrong, for a person. */
  readonly detail?: string;
  /** The request's issues, for `invalid_request` and `invalid_policy`. */
  readonly issues?: readonly {
    readonly message: string;
    readonly path: readonly (string | number)[];
  }[];
  /** Where to send the operator for a fresh second factor, for `step_up_required`. */
  readonly stepUpUrl?: string;
  /** The current state of what the request raced, for `conflict`. */
  readonly current?: unknown;
  /** The dangerous changes found, for `confirmation_required` and `approval_required`. */
  readonly dangerous?: readonly string[];
}

/** A service (control-plane.md §2.1). */
export interface ServiceDto {
  /** Its id: letters, digits, `_`, `.` and `-`. */
  readonly id: string;
  /** Its display name. */
  readonly name: string;
  /** The groups it belongs to, outermost policy first. */
  readonly groups: readonly string[];
  /** Its environment (`production`, `staging`, …); `production` makes some changes dangerous. */
  readonly environment: string;
  /** The hosts it answers on. */
  readonly hosts: readonly string[];
  /** Its topology (topologies.md): `a`, `b` or `c`. */
  readonly topology: "a" | "b" | "c";
  /** Free-form labels. */
  readonly labels: Readonly<Record<string, string>>;
  /** Whether every change to its policy needs a step-up (control-plane.md §5.3). */
  readonly requireStepUp: boolean;
  /** Its revision, for the next write. */
  readonly revision: number;
  /** When it was last written, epoch milliseconds. */
  readonly updatedAt: number;
}

/** What `POST /services` and `PUT /services/:id` take. */
export interface ServiceInput {
  /** The service's id (create only; the path's on update). */
  readonly id?: string;
  /** Its display name. */
  readonly name: string;
  /** Its groups. Default none. */
  readonly groups?: readonly string[];
  /** Its environment. Default `production`. */
  readonly environment?: string;
  /** Its hosts. Default none. */
  readonly hosts?: readonly string[];
  /** Its topology. Default `a`. */
  readonly topology?: "a" | "b" | "c";
  /** Its labels. Default none. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Whether its changes need a step-up. Default `false`. */
  readonly requireStepUp?: boolean;
  /** The revision read (update only); a stale one is a `409`. */
  readonly revision?: number;
}

/** A group of services (control-plane.md §2.1). */
export interface GroupDto {
  /** Its id. */
  readonly id: string;
  /** Its display name. */
  readonly name: string;
  /** Its parent group, or `null` at the top; groups nest at most 4 deep. */
  readonly parent: string | null;
  /** Free-form labels. */
  readonly labels: Readonly<Record<string, string>>;
  /** Its revision. */
  readonly revision: number;
  /** When it was last written. */
  readonly updatedAt: number;
}

/** What `POST /groups` and `PUT /groups/:id` take. */
export interface GroupInput {
  /** Its id (create only). */
  readonly id?: string;
  /** Its display name. */
  readonly name: string;
  /** Its parent. Default none. */
  readonly parent?: string | null;
  /** Its labels. */
  readonly labels?: Readonly<Record<string, string>>;
  /** The revision read (update only). */
  readonly revision?: number;
}

/** A sibling service's identity (layers.md L2.4): who may call with a token. */
export interface ServiceIdentityDto {
  /** The calling service's id (`pay-api`). */
  readonly id: string;
  /** The token's verifier: `sha256:<hex>`, or several during a rotation. Never the token. */
  readonly verifier: string | readonly string[];
  /** Whether its forwarded end-user address is believed. */
  readonly forwardsClientIp: boolean;
  /** What it is exempt from (`lists`, `bans`, `countedRules`, `globalLimits`). */
  readonly exempt: readonly string[];
  /** The services it may call; empty for every service. */
  readonly services: readonly string[];
  /** Its revision. */
  readonly revision: number;
  /** When it was last written. */
  readonly updatedAt: number;
}

/** What `POST /service-identities` and `PUT /service-identities/:id` take. */
export interface ServiceIdentityInput {
  /** The calling service's id (create only). */
  readonly id?: string;
  /** The verifier. */
  readonly verifier: string | readonly string[];
  /** Whether its forwarded address is believed. Default `false`. */
  readonly forwardsClientIp?: boolean;
  /** Its exemptions. Default the engine's. */
  readonly exempt?: readonly string[];
  /** The services it may call. Default every service. */
  readonly services?: readonly string[];
  /** The revision read (update only). */
  readonly revision?: number;
}

/** A scope's draft policy: edits not yet published. */
export interface PolicyDraftDto {
  /** The draft policy: a partial policy, layered over the scopes above it. */
  readonly policy: Readonly<Record<string, unknown>>;
  /** The head version it was based on (`null`: none yet). */
  readonly baseHead: string | null;
  /** Its revision, for the next save. */
  readonly revision: number;
  /** Who saved it last. */
  readonly updatedBy: string;
  /** When. */
  readonly updatedAt: number;
}

/** `GET /policies/:scope`: a scope's draft and head. */
export interface PolicyDto {
  /** The scope. */
  readonly scope: PolicyScopeId;
  /** The draft, if one is open. */
  readonly draft: PolicyDraftDto | null;
  /** The published head, if any. */
  readonly head: { readonly id: string; readonly number: number } | null;
}

/** What `PUT /policies/:scope/draft` takes. */
export interface PolicyDraftInput {
  /** The draft policy. */
  readonly policy: Readonly<Record<string, unknown>>;
  /** The draft's revision read (`null`: no draft yet); a stale one is a `409`. */
  readonly revision: number | null;
}

/** A published version of a scope's policy. */
export interface PolicyVersionDto {
  /** The scope. */
  readonly scope: PolicyScopeId;
  /** The version's id (`pv_…`). */
  readonly id: string;
  /** Its number in the scope. */
  readonly number: number;
  /** The policy as published. */
  readonly policy: Readonly<Record<string, unknown>>;
  /** When. */
  readonly createdAt: number;
  /** Who. */
  readonly createdBy: string | null;
  /** Why. */
  readonly message: string | null;
  /** `published` (the head) or `superseded`. */
  readonly status: "published" | "superseded";
}

/** One difference between two policies. */
export interface PolicyChangeDto {
  /** Where, as a path (`limits[id=per-ip].limit`). */
  readonly path: string;
  /** The value before (absent: added). */
  readonly before?: unknown;
  /** The value after (absent: removed). */
  readonly after?: unknown;
}

/** `GET /policies/:scope/diff`. */
export interface PolicyDiffDto {
  /** What the diff is from: a version id, `head` or `draft`. */
  readonly from: string;
  /** What it is to. */
  readonly to: string;
  /** The differences. */
  readonly changes: readonly PolicyChangeDto[];
}

/** What `POST /policies/:scope/publish` takes. */
export interface PublishInput {
  /** The head the draft was based on (`null`: none yet); a moved head is a `409`. */
  readonly expectedHead: string | null;
  /** Why, in a line. */
  readonly message?: string;
  /** The scope's name, typed, confirming a dangerous change when approvals are off. */
  readonly confirm?: string;
  /** Publish at once and open a mandatory review (control-plane.md §5.4). */
  readonly emergency?: boolean;
}

/** What `POST /policies/:scope/rollback` takes. */
export interface RollbackInput extends PublishInput {
  /** The version whose content is published again. */
  readonly versionId: string;
}

/** A recompiled bundle, as a publish reports it. */
export interface CompiledBundleDto {
  /** The service. */
  readonly service: string;
  /** Its new bundle version. */
  readonly version: number;
}

/** What a publish (or rollback, or an approval carrying one) answers. */
export interface PublishResultDto {
  /** The version published. */
  readonly version: PolicyVersionDto;
  /** The bundles recompiled for it. */
  readonly bundles: readonly CompiledBundleDto[];
  /** The review an emergency publish opened. */
  readonly review?: ApprovalDto;
}

/** `GET /services/:id/effective`: the merged policy and each field's origin. */
export interface EffectivePolicyDto {
  /** The service. */
  readonly service: string;
  /** The versions merged, outermost first. */
  readonly policyVersions: readonly string[];
  /** The effective policy. */
  readonly policy: Readonly<Record<string, unknown>>;
  /** Where each field came from: a path to a scope (`limits[id=per-ip]` → `group:payments`). */
  readonly origins: Readonly<Record<string, PolicyScopeId>>;
}

/** An approval (control-plane.md §5.4): a change waiting for a second operator. */
export interface ApprovalDto {
  /** Its id. */
  readonly id: string;
  /** What it would do. */
  readonly action:
    | "policy.publish"
    | "policy.rollback"
    | "roleBinding.create"
    | "roleBinding.delete"
    | "serviceIdentity.put"
    | "serviceIdentity.delete";
  /** The scope it acts on. */
  readonly scope: PolicyScopeId;
  /** `pending`; `review` after an emergency publish; then `approved`, `rejected`, `expired` or `stale`. */
  readonly status:
    "pending" | "review" | "approved" | "rejected" | "expired" | "stale";
  /** Who asked. */
  readonly author: string;
  /** When. */
  readonly createdAt: number;
  /** When a pending approval expires (24 hours by default). */
  readonly expiresAt: number;
  /** Who decided, once decided. */
  readonly decidedBy: string | null;
  /** When. */
  readonly decidedAt: number | null;
  /** The decider's reason. */
  readonly reason: string | null;
  /** Why it needs an approval: the dangerous changes found, or `step-up unavailable`. */
  readonly dangerous: readonly string[];
  /** A summary of the change (its message, the version rolled back to, the binding). */
  readonly summary: Readonly<Record<string, unknown>>;
  /** Its revision. */
  readonly revision: number;
}

/** What `POST /approvals/:id/approve` and `/reject` take. */
export interface ApprovalDecisionInput {
  /** The approval's revision read. */
  readonly revision: number;
  /** Why. */
  readonly reason?: string;
}

/** A role bound to an operator on a scope (control-plane.md §5.2). */
export interface RoleBindingDto {
  /** Its id. */
  readonly id: string;
  /** The operator's id. */
  readonly operator: string;
  /** The role. */
  readonly role: SecurityRole;
  /** The scope it applies to (and every scope below it). */
  readonly scope: PolicyScopeId;
  /** Who bound it. */
  readonly createdBy: string;
  /** When. */
  readonly createdAt: number;
  /** Its revision. */
  readonly revision: number;
}

/** What `POST /role-bindings` takes. */
export interface RoleBindingInput {
  /** The operator's id. */
  readonly operator: string;
  /** The role. */
  readonly role: SecurityRole;
  /** The scope. */
  readonly scope: PolicyScopeId;
}

/** `GET /operators/me`. */
export interface OperatorDto {
  /** The operator's id, from `authenticate`. */
  readonly id: string;
  /** Their display name, when the host gave one. */
  readonly name: string | null;
  /** Their roles: from bindings, or `owners`. Empty under a host's own `authorize`. */
  readonly roles: readonly {
    readonly role: SecurityRole;
    readonly scope: PolicyScopeId;
    readonly source: "binding" | "owners";
  }[];
}

/** `GET /meta`. */
export interface SecurityApiMetaDto {
  /** {@link SECURITY_API_PROTOCOL_VERSION}. */
  readonly protocolVersion: number;
  /** Where the API is mounted. */
  readonly basePath: string;
  /** The CSRF header mutations carry, or `null` with the check off. */
  readonly csrfHeader: string | null;
  /** How destructive changes are guarded. */
  readonly stepUp: "hook" | "approvals" | "none";
  /** `off` or `two-person` (control-plane.md §5.4). */
  readonly approvals: "off" | "two-person";
  /** The bundle signing key in use (its id), for agents' configuration. */
  readonly signingKeyId: string;
  /** Whether role bindings are the built-in RBAC's (`false` under a host's own `authorize`). */
  readonly builtInRbac: boolean;
  /** The store's name and whether it is durable. */
  readonly store: { readonly name: string; readonly durable: boolean };
}

/** `GET /meta/permissions`: what the caller may do on a scope. */
export interface SecurityApiPermissionsDto {
  /** The scope asked about. */
  readonly scope: PolicyScopeId;
  /** Each permission, allowed or not. */
  readonly permissions: Readonly<Record<SecurityApiPermission, boolean>>;
}

/** One event on `GET /live`. */
export interface SecurityLiveEventDto {
  /** Its name. */
  readonly event: SecurityLiveEventName;
  /** The scope it concerns. */
  readonly scope: PolicyScopeId;
  /** What happened. */
  readonly data: Readonly<Record<string, unknown>>;
  /** When, epoch milliseconds. */
  readonly at: number;
}
