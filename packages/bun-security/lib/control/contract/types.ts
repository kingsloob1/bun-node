/**
 * The management API's wire types (control-plane.md §2, §4): what each
 * route takes and answers, browser-safe and import-free, for the UI and
 * any typed client. The server's schemas are checked against them.
 */
import type {
  SecurityAlertKind,
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
  /** Whether the break-glass account is configured (`POST /break-glass/session` is served). */
  readonly breakGlass: boolean;
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

/** Who an audit entry names (control-plane.md §6.1). */
export interface AuditActorDto {
  /** The operator's id, `break-glass`, an agent's id, or `system` (a host's own call, a purge). */
  readonly id: string;
  /** What kind of actor. */
  readonly kind: "operator" | "break-glass" | "agent" | "system";
}

/** Where an intent's change was to land, so a missing "done" can be reconciled. */
export interface AuditTargetDto {
  /** A document kind (`service`, `policyDraft`, …), or `version` for a policy version. */
  readonly kind: string;
  /** Its id (a version's id for `version`). */
  readonly id: string;
  /** The scope, for a version. */
  readonly scope?: string;
  /** The revision it would have once written; absent for a delete or a version. */
  readonly revision?: number;
  /** Whether the change deletes it. */
  readonly deleted?: boolean;
}

/**
 * One audit entry (control-plane.md §6.1). A change is two: an `intent`
 * appended before it, and a `done` naming the intent after it; an `event`
 * (a break-glass login, an export, a purge) stands alone.
 */
export interface AuditEntryDto {
  /** Its number in the chain. */
  readonly n: number;
  /** When, epoch milliseconds. */
  readonly at: number;
  /** `SHA-256(prevHash || canonical JSON of entry)`, hex. */
  readonly hash: string;
  /** The entry before it's hash. */
  readonly prevHash: string;
  /** Who. */
  readonly actor: string;
  /** What (`service.put`, `policy.publish`, `approval.approve`, `breakGlass.login`, …). */
  readonly action: string;
  /** The scope it acted on. */
  readonly scope: string;
  /** `intent`, `done` or `event`. */
  readonly phase: "intent" | "done" | "event";
  /**
   * For an intent: `done` when its done entry exists; otherwise, reconciled
   * against the store, `completed-unconfirmed` (the change is there) or
   * `not-applied` (it is not). Never tampering.
   */
  readonly status?: "done" | "completed-unconfirmed" | "not-applied";
  /** The entry as hashed: actor, address, session, request id, permission, step-up, approval, target, before and after or a diff, outcome. */
  readonly entry: Readonly<Record<string, unknown>>;
}

/** A signed checkpoint of the chain. */
export interface AuditCheckpointDto {
  /** The entry it covers. */
  readonly n: number;
  /** That entry's hash. */
  readonly hash: string;
  /** When it was signed. */
  readonly at: number;
  /** The audit key's id. */
  readonly keyId: string;
  /** The Ed25519 signature, base64. */
  readonly signature: string;
}

/** Where `verify` found the chain broken. */
export interface AuditProblemDto {
  /** The first entry (or checkpoint) affected. */
  readonly n: number;
  /**
   * `hash-mismatch` (an entry edited), `gap` (one deleted), `order` (moved
   * or reordered), `anchor` (the oldest retained entry not covered by a
   * checkpoint), `truncated` (the end cut off), `checkpoint-signature` (a
   * forged checkpoint), `checkpoint-mismatch` (a checkpoint disagreeing
   * with the chain).
   */
  readonly reason:
    | "hash-mismatch"
    | "gap"
    | "order"
    | "anchor"
    | "truncated"
    | "checkpoint-signature"
    | "checkpoint-mismatch";
  /** What was found, for a person. */
  readonly detail: string;
  /** Where the checkpoint came from, for a checkpoint problem: `store` or a sink's name. */
  readonly source?: string;
}

/** `GET /audit/verify`: the chain recomputed and its checkpoints checked. */
export interface AuditVerifyDto {
  /** No problem found. */
  readonly ok: boolean;
  /** Entries checked. */
  readonly checked: number;
  /** The oldest retained entry's number, `null` with none. */
  readonly first: number | null;
  /** The last entry's number, `null` with none. */
  readonly last: number | null;
  /** Checkpoints checked, and the latest one's number. */
  readonly checkpoints: {
    readonly checked: number;
    readonly latest: number | null;
  };
  /** The external sinks: `none-configured`, `checked` (one or more read back), or `write-only` (none readable). */
  readonly external: "none-configured" | "checked" | "write-only";
  /** Every problem, the first one first. */
  readonly problems: readonly AuditProblemDto[];
  /** Intents with no done entry, reconciled against the store (never tampering). */
  readonly unconfirmed: readonly {
    readonly n: number;
    readonly action: string;
    readonly scope: string;
    readonly status: "completed-unconfirmed" | "not-applied";
  }[];
}

/** An alert raised through `onAlert` (until PR-CP6 routes them to channels). */
export interface SecurityAlertDto {
  /** Which. */
  readonly kind: SecurityAlertKind;
  /** How bad. */
  readonly severity: "info" | "warning" | "critical";
  /** What happened, for a person. */
  readonly message: string;
  /** When, epoch milliseconds. */
  readonly at: number;
  /** Details: the scope, the audit entry's number, the sink. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** What `POST /break-glass/session` takes. */
export interface BreakGlassLoginInput {
  /** The break-glass password. */
  readonly password: string;
  /** The current TOTP code. */
  readonly code: string;
}

/** What `POST /break-glass/session` answers. */
export interface BreakGlassSessionDto {
  /** The token, to send in `x-bun-security-break-glass`. */
  readonly token: string;
  /** When it expires, epoch milliseconds (15 minutes). */
  readonly expiresAt: number;
  /** The header to send it in. */
  readonly header: string;
}

/** An agent's state, as the control plane computes it (PR-CP4). */
export type AgentStatus =
  "never-seen" | "ok" | "late" | "offline" | "signature-failing" | "revoked";

/** An agent (control-plane.md §7): its key's record and its health. Never its secret. */
export interface AgentDto {
  /** Its id, sent in `x-bun-security-agent`. */
  readonly id: string;
  /** The service it serves. */
  readonly service: string;
  /** Its display name. */
  readonly name: string;
  /** When its key was made, and by whom. */
  readonly createdAt: number;
  /** The operator who made it. */
  readonly createdBy: string;
  /** When its key was last rotated. */
  readonly rotatedAt: number | null;
  /** Until when the replaced secret is still accepted (the agent's first request with the new one ends it). */
  readonly previousAcceptedUntil: number | null;
  /** When it was revoked. */
  readonly revokedAt: number | null;
  /** Its state now: `late` after 3 missed heartbeats, `offline` after 10. */
  readonly status: AgentStatus;
  /** Its last heartbeat, epoch ms. */
  readonly lastSeen: number | null;
  /** What its last heartbeat said. */
  readonly reported: {
    readonly agentVersion: string;
    readonly bundleVersion: number | null;
    readonly bundleKeyId: string | null;
    readonly bundleExpired: boolean;
    readonly banSeq: string;
    readonly banCount: number;
    readonly health: "ok" | "signature-failing";
    readonly lastError?: string;
    /** The engine's IP feeds (PR-AN): size, last refresh, last attempt, last failure; at most 32. */
    readonly intel?: {
      readonly feeds: readonly {
        readonly id: string;
        readonly size: number;
        readonly refreshedAt: number | null;
        readonly attemptedAt: number | null;
        readonly error?: string;
      }[];
    };
    /** The engine's warnings in force (PR-CP6): kind, since, share; at most 16. */
    readonly warnings?: readonly {
      readonly kind: string;
      readonly since: number;
      readonly share?: number;
    }[];
  } | null;
  /** The record's revision, for rotate and revoke. */
  readonly revision: number;
}

/** `POST /agents`'s body. */
export interface AgentCreateInput {
  /** Its id (`[\w-]{1,64}`); made up when absent. */
  readonly id?: string;
  /** The service it serves. */
  readonly service: string;
  /** A display name. Default its id. */
  readonly name?: string;
}

/** What creating or rotating answers: the agent and its secret, shown this once. */
export interface AgentSecretDto {
  /** The agent. */
  readonly agent: AgentDto;
  /** Its HMAC secret: configure the agent with it; it is never shown again. */
  readonly secret: string;
}

/** A ban (storage.md §3.1), as the API answers it. */
export interface BanDto {
  /** Its id. */
  readonly id: string;
  /** Where it applies. */
  readonly scope: PolicyScopeId;
  /** What it refuses; an API key's or a user's `value` is its HMAC under the fleet's secret, never the id. */
  readonly subject: {
    readonly type: "ip" | "cidr" | "user" | "apiKey";
    readonly value: string;
  };
  /** `ban` or `challenge`. */
  readonly action: "ban" | "challenge";
  /** Why. */
  readonly reason: string;
  /** `manual` or `auto`. */
  readonly source: "auto" | "manual";
  /** When it (last) started. */
  readonly createdAt: number;
  /** When it ends; `null` until lifted. */
  readonly expiresAt: number | null;
  /** Who wrote it. */
  readonly createdBy?: string;
  /** The rule of an automatic ban. */
  readonly rule?: string;
  /** How many times it was written. */
  readonly count: number;
  /** When it was lifted. */
  readonly liftedAt: number | null;
  /** Who lifted it. */
  readonly liftedBy?: string;
  /** Whether it is in force now. */
  readonly active: boolean;
  /** Its revision. */
  readonly revision: number;
  /** What the operator typed, in the answer to `POST /bans` only (an API key's or a user's subject is its HMAC, never the id). */
  readonly entered?: { readonly apiKey?: string; readonly user?: string };
}

/** `POST /bans`'s body. */
export interface BanCreateInput {
  /** Where it applies. Default `global`. */
  readonly scope?: PolicyScopeId;
  /** An address or CIDR range. Exactly one of `ip`, `user`, `apiKey`. */
  readonly ip?: string;
  /** A user id, as the services' `identify()` returns it (stored and sent as its HMAC). */
  readonly user?: string;
  /** An API key id (stored and sent as its HMAC). */
  readonly apiKey?: string;
  /** `ban` (the default) or `challenge`. */
  readonly action?: "ban" | "challenge";
  /** Why (shown to operators only). */
  readonly reason: string;
  /** How long (`"24h"`, the default), or `null` until lifted. */
  readonly duration?: string | null;
}
