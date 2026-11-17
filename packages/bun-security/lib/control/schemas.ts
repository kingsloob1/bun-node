/**
 * The management API's request and response schemas: what each route's
 * `validate()` checks and the OpenAPI document publishes. Each is typed
 * against the contract's wire type (`./contract/types`), so the two cannot
 * drift.
 */
import type { Schema } from "./schema";
import type {
  AgentCreateInput,
  AgentDto,
  AgentSecretDto,
  BanCreateInput,
  BanDto,
  ApprovalDecisionInput,
  AuditCheckpointDto,
  AuditEntryDto,
  AuditVerifyDto,
  BreakGlassLoginInput,
  BreakGlassSessionDto,
  ApprovalDto,
  EffectivePolicyDto,
  GroupDto,
  GroupInput,
  OperatorDto,
  PolicyDiffDto,
  PolicyDraftDto,
  PolicyDraftInput,
  PolicyDto,
  PolicyVersionDto,
  ProblemDto,
  PublishInput,
  PublishResultDto,
  RoleBindingDto,
  RoleBindingInput,
  RollbackInput,
  SecurityApiMetaDto,
  SecurityApiPermissionsDto,
  ServiceDto,
  ServiceIdentityDto,
  ServiceIdentityInput,
  ServiceInput,
} from "./contract/types";
import {
  MAX_API_PAGE_LIMIT,
  SECURITY_API_ERROR_CODES,
  SECURITY_API_PERMISSIONS,
  SECURITY_ROLES,
} from "./contract/constants";
import { s } from "./schema";

/** An entity id. */
const Id = s.string({
  min: 1,
  max: 64,
  pattern: /^[a-z\d][\w.-]{0,63}$/i,
  description: "letters, digits, _, . and -",
});

/** A scope id. */
const Scope = s.string({
  min: 1,
  max: 80,
  pattern: /^(?:global|(?:group|service):[a-z\d][\w.-]{0,63})$/i,
  description: "global, group:<id> or service:<id>",
});

/** Labels. */
const Labels = s.record(s.string({ max: 200 }), 50);

/** A policy (partial, layered), documented as an object: its own validator checks it (securityPolicySchema). */
const PolicyObject = s.anyObject(
  "a bun-security policy (a partial one at a scope, layered over the scopes above it)",
);

/** Path parameters with an `id`. */
export const IdParams = s.object({ id: Id });

/** Path parameters with a `scope`. */
export const ScopeParams = s.object({ scope: Scope });

/** Path parameters with a `scope` and a version `id`. */
export const ScopeVersionParams = s.object({
  scope: Scope,
  id: s.string({ min: 1, max: 200 }),
});

/** A list's query. */
export const PageQuery = s.query({
  limit: s.optional(
    s.int({
      min: 1,
      max: MAX_API_PAGE_LIMIT,
      description: "the page size (default 50)",
    }),
  ),
  cursor: s.optional(
    s.string({ max: 2_000, description: "the previous page's next" }),
  ),
});

/** `DELETE`'s query: the revision read. */
export const RevisionQuery = s.query({
  revision: s.int({ min: 1, description: "the revision read" }),
});

/** `GET /meta/permissions`'s query. */
export const PermissionsQuery = s.query({ scope: s.optional(Scope) });

/** `GET /policies/:scope/diff`'s query. */
export const DiffQuery = s.query({
  from: s.optional(
    s.string({
      min: 1,
      max: 200,
      description: "a version id, head or draft (default head)",
    }),
  ),
  to: s.optional(
    s.string({
      min: 1,
      max: 200,
      description: "a version id, head or draft (default draft)",
    }),
  ),
});

/** A page of `item`. */
function page<T>(item: Schema<T>): Schema<{
  readonly items: T[];
  readonly next?: string;
  readonly totalEstimate?: number;
}> {
  return s.object({
    items: s.array(item, MAX_API_PAGE_LIMIT),
    next: s.optional(s.string()),
    totalEstimate: s.optional(s.int({ min: 0 })),
  });
}

/** A problem. */
export const Problem: Schema<ProblemDto> = s.object({
  type: s.string(),
  title: s.string(),
  status: s.int({ min: 100, max: 599 }),
  code: s.enum(SECURITY_API_ERROR_CODES),
  detail: s.optional(s.string()),
  issues: s.optional(
    s.array(
      s.object({
        message: s.string(),
        path: s.array(s.json("a key or an index")) as Schema<
          (string | number)[]
        >,
      }),
    ),
  ),
  stepUpUrl: s.optional(s.string()),
  current: s.optional(s.json("the current state of what the request raced")),
  dangerous: s.optional(s.array(s.string())),
});

/** A service. */
export const Service: Schema<ServiceDto> = s.object({
  id: Id,
  name: s.string({ min: 1, max: 200 }),
  groups: s.array(Id, 20),
  environment: s.string({ min: 1, max: 64 }),
  hosts: s.array(s.string({ max: 253 }), 100),
  topology: s.enum(["a", "b", "c"]),
  labels: Labels,
  requireStepUp: s.boolean(),
  revision: s.int({ min: 1 }),
  updatedAt: s.int({ min: 0 }),
});

/** A service to create or update. */
export const ServiceBody: Schema<ServiceInput> = s.object({
  id: s.optional(Id),
  name: s.string({ min: 1, max: 200 }),
  groups: s.optional(s.array(Id, 20)),
  environment: s.optional(s.string({ min: 1, max: 64 })),
  hosts: s.optional(s.array(s.string({ max: 253 }), 100)),
  topology: s.optional(s.enum(["a", "b", "c"])),
  labels: s.optional(Labels),
  requireStepUp: s.optional(s.boolean()),
  revision: s.optional(s.int({ min: 1 })),
});

/** A group. */
export const Group: Schema<GroupDto> = s.object({
  id: Id,
  name: s.string({ min: 1, max: 200 }),
  parent: s.nullable(Id),
  labels: Labels,
  revision: s.int({ min: 1 }),
  updatedAt: s.int({ min: 0 }),
});

/** A group to create or update. */
export const GroupBody: Schema<GroupInput> = s.object({
  id: s.optional(Id),
  name: s.string({ min: 1, max: 200 }),
  parent: s.optional(s.nullable(Id)),
  labels: s.optional(Labels),
  revision: s.optional(s.int({ min: 1 })),
});

/** A verifier: one or several. */
const Verifier = s.json(
  "sha256:<hex of the token>, or a list of them during a rotation",
) as Schema<string | string[]>;

/** A service identity. */
export const Identity: Schema<ServiceIdentityDto> = s.object({
  id: Id,
  verifier: Verifier,
  forwardsClientIp: s.boolean(),
  exempt: s.array(s.string({ max: 64 }), 10),
  services: s.array(Id, 1_000),
  revision: s.int({ min: 1 }),
  updatedAt: s.int({ min: 0 }),
});

/** A service identity to create or update. */
export const IdentityBody: Schema<ServiceIdentityInput> = s.object({
  id: s.optional(Id),
  verifier: Verifier,
  forwardsClientIp: s.optional(s.boolean()),
  exempt: s.optional(s.array(s.string({ max: 64 }), 10)),
  services: s.optional(s.array(Id, 1_000)),
  revision: s.optional(s.int({ min: 1 })),
});

/** A draft. */
export const Draft: Schema<PolicyDraftDto> = s.object({
  policy: PolicyObject,
  baseHead: s.nullable(s.string()),
  revision: s.int({ min: 1 }),
  updatedBy: s.string(),
  updatedAt: s.int({ min: 0 }),
});

/** A scope's draft and head. */
export const Policy: Schema<PolicyDto> = s.object({
  scope: Scope,
  draft: s.nullable(Draft),
  head: s.nullable(s.object({ id: s.string(), number: s.int({ min: 1 }) })),
});

/** A draft to save. */
export const DraftBody: Schema<PolicyDraftInput> = s.object({
  policy: PolicyObject,
  revision: s.nullable(s.int({ min: 1 })),
});

/** A version. */
export const Version: Schema<PolicyVersionDto> = s.object({
  scope: Scope,
  id: s.string(),
  number: s.int({ min: 1 }),
  policy: PolicyObject,
  createdAt: s.int({ min: 0 }),
  createdBy: s.nullable(s.string()),
  message: s.nullable(s.string()),
  status: s.enum(["published", "superseded"]),
});

/** A diff. */
export const Diff: Schema<PolicyDiffDto> = s.object({
  from: s.string(),
  to: s.string(),
  changes: s.array(
    s.object({
      path: s.string(),
      before: s.optional(s.json("the value before")),
      after: s.optional(s.json("the value after")),
    }),
    10_000,
  ),
});

/** A publish. */
export const PublishBody: Schema<PublishInput> = s.object({
  expectedHead: s.nullable(s.string({ min: 1, max: 200 })),
  message: s.optional(s.string({ max: 1_000 })),
  confirm: s.optional(s.string({ max: 80 })),
  emergency: s.optional(s.boolean()),
});

/** A rollback. */
export const RollbackBody: Schema<RollbackInput> = s.object({
  versionId: s.string({ min: 1, max: 200 }),
  expectedHead: s.nullable(s.string({ min: 1, max: 200 })),
  message: s.optional(s.string({ max: 1_000 })),
  confirm: s.optional(s.string({ max: 80 })),
  emergency: s.optional(s.boolean()),
});

/** An approval. */
export const Approval: Schema<ApprovalDto> = s.object({
  id: s.string(),
  action: s.enum([
    "policy.publish",
    "policy.rollback",
    "roleBinding.create",
    "roleBinding.delete",
    "serviceIdentity.put",
    "serviceIdentity.delete",
  ]),
  scope: Scope,
  status: s.enum([
    "pending",
    "review",
    "approved",
    "rejected",
    "expired",
    "stale",
  ]),
  author: s.string(),
  createdAt: s.int({ min: 0 }),
  expiresAt: s.int({ min: 0 }),
  decidedBy: s.nullable(s.string()),
  decidedAt: s.nullable(s.int({ min: 0 })),
  reason: s.nullable(s.string()),
  dangerous: s.array(s.string(), 10_000),
  summary: s.anyObject("what the change does"),
  revision: s.int({ min: 1 }),
});

/** What a publish answers. */
export const PublishResult: Schema<PublishResultDto> = s.object({
  version: Version,
  bundles: s.array(
    s.object({ service: Id, version: s.int({ min: 1 }) }),
    100_000,
  ),
  review: s.optional(Approval),
});

/** What a decided approval answers. */
export const Decision = s.object({
  approval: Approval,
  result: s.optional(s.json("what carrying it out answered")),
});

/** An approval decision. */
export const DecisionBody: Schema<ApprovalDecisionInput> = s.object({
  revision: s.int({ min: 1 }),
  reason: s.optional(s.string({ max: 1_000 })),
});

/** The effective policy. */
export const Effective: Schema<EffectivePolicyDto> = s.object({
  service: Id,
  policyVersions: s.array(s.string(), 100),
  policy: PolicyObject,
  origins: s.record(Scope, 100_000),
});

/** A signed bundle, documented as an object (`bun-security.bundle/1`). */
export const Bundle = s.anyObject(
  "a signed bundle, bun-security.bundle/1 (control-plane.md §3.1)",
);

/** A role binding. */
export const Binding: Schema<RoleBindingDto> = s.object({
  id: s.string(),
  operator: s.string({ min: 1, max: 200 }),
  role: s.enum(SECURITY_ROLES),
  scope: Scope,
  createdBy: s.string(),
  createdAt: s.int({ min: 0 }),
  revision: s.int({ min: 1 }),
});

/** A role binding to create. */
export const BindingBody: Schema<RoleBindingInput> = s.object({
  operator: s.string({ min: 1, max: 200 }),
  role: s.enum(SECURITY_ROLES),
  scope: Scope,
});

/** The calling operator. */
export const Me: Schema<OperatorDto> = s.object({
  id: s.string(),
  name: s.nullable(s.string()),
  roles: s.array(
    s.object({
      role: s.enum(SECURITY_ROLES),
      scope: Scope,
      source: s.enum(["binding", "owners"]),
    }),
    1_000,
  ),
});

/** `/meta`. */
export const Meta: Schema<SecurityApiMetaDto> = s.object({
  protocolVersion: s.int({ min: 1 }),
  basePath: s.string(),
  csrfHeader: s.nullable(s.string()),
  stepUp: s.enum(["hook", "approvals", "none"]),
  approvals: s.enum(["off", "two-person"]),
  signingKeyId: s.string(),
  builtInRbac: s.boolean(),
  store: s.object({ name: s.string(), durable: s.boolean() }),
});

/** `/meta/permissions`. */
export const Permissions: Schema<SecurityApiPermissionsDto> = s.object({
  scope: Scope,
  permissions: s.object(
    Object.fromEntries(
      SECURITY_API_PERMISSIONS.map((name) => [name, s.boolean()]),
    ) as Record<(typeof SECURITY_API_PERMISSIONS)[number], Schema<boolean>>,
  ),
});

/** Pages. */
export const Services = page(Service);
/** A page of groups. */
export const Groups = page(Group);
/** A page of identities. */
export const Identities = page(Identity);
/** A page of versions. */
export const Versions = page(Version);
/** A page of approvals. */
export const Approvals = page(Approval);
/** A page of bindings. */
export const Bindings = page(Binding);

// ── Audit (PR-CP3) ──────────────────────────────────────────────────────────

/** `GET /audit`'s query. */
export const AuditQuery = s.query({
  limit: s.optional(
    s.int({
      min: 1,
      max: MAX_API_PAGE_LIMIT,
      description: "the page size (default 50)",
    }),
  ),
  cursor: s.optional(
    s.string({ max: 2_000, description: "the previous page's next" }),
  ),
  direction: s.optional(
    s.enum(["asc", "desc"], "newest first (desc, the default) or oldest first"),
  ),
  actor: s.optional(
    s.string({ min: 1, max: 200, description: "only this operator's entries" }),
  ),
  action: s.optional(
    s.string({
      min: 1,
      max: 200,
      description: "only this action (service.put)",
    }),
  ),
  scope: s.optional(Scope),
  since: s.optional(
    s.int({ min: 0, description: "only entries at or after (ms)" }),
  ),
  until: s.optional(s.int({ min: 0, description: "only entries before (ms)" })),
});

/** `GET /audit/export`'s query. */
export const ExportQuery = s.query({
  since: s.optional(
    s.int({ min: 0, description: "only entries at or after (ms)" }),
  ),
  until: s.optional(s.int({ min: 0, description: "only entries before (ms)" })),
});

/** `GET /audit/:n`'s parameters. */
export const EntryParams = s.query({
  n: s.int({ min: 1, description: "the entry's number" }),
});

/** An audit entry. */
export const AuditEntry: Schema<AuditEntryDto> = s.object({
  n: s.int({ min: 1 }),
  at: s.int({ min: 0 }),
  hash: s.string(),
  prevHash: s.string(),
  actor: s.string(),
  action: s.string(),
  scope: s.string(),
  phase: s.enum(["intent", "done", "event"]),
  status: s.optional(s.enum(["done", "completed-unconfirmed", "not-applied"])),
  entry: s.anyObject(
    "the hashed entry: who, from where, what, before and after",
  ),
});

/** A page of audit entries. */
export const AuditEntries = page(AuditEntry);

/** A signed checkpoint. */
export const Checkpoint: Schema<AuditCheckpointDto> = s.object({
  n: s.int({ min: 1 }),
  hash: s.string(),
  at: s.int({ min: 0 }),
  keyId: s.string(),
  signature: s.string(),
});

/** A page of checkpoints. */
export const Checkpoints = page(Checkpoint);

/** What `verify` answers. */
export const AuditVerify: Schema<AuditVerifyDto> = s.object({
  ok: s.boolean(),
  checked: s.int({ min: 0 }),
  first: s.nullable(s.int({ min: 1 })),
  last: s.nullable(s.int({ min: 1 })),
  checkpoints: s.object({
    checked: s.int({ min: 0 }),
    latest: s.nullable(s.int({ min: 1 })),
  }),
  external: s.enum(["none-configured", "checked", "write-only"]),
  problems: s.array(
    s.object({
      n: s.int({ min: 1 }),
      reason: s.enum([
        "hash-mismatch",
        "gap",
        "order",
        "anchor",
        "truncated",
        "checkpoint-signature",
        "checkpoint-mismatch",
      ]),
      detail: s.string(),
      source: s.optional(s.string()),
    }),
    1_000_000,
  ),
  unconfirmed: s.array(
    s.object({
      n: s.int({ min: 1 }),
      action: s.string(),
      scope: s.string(),
      status: s.enum(["completed-unconfirmed", "not-applied"]),
    }),
    1_000_000,
  ),
});

/** The break-glass login's body. */
export const BreakGlassBody: Schema<BreakGlassLoginInput> = s.object({
  password: s.string({
    min: 1,
    max: 1_000,
    description: "the break-glass password",
  }),
  code: s.string({
    min: 6,
    max: 6,
    description: "the authenticator's current code",
  }),
});

/** A break-glass session. */
export const BreakGlassSession: Schema<BreakGlassSessionDto> = s.object({
  token: s.string({
    description: "send it back in the header named by header",
  }),
  expiresAt: s.int({ min: 0 }),
  header: s.string(),
});

// ── Agents and bans (PR-CP4) ────────────────────────────────────────────────

/** An agent id. */
const AgentId = s.string({
  min: 1,
  max: 64,
  pattern: /^[\w-]{1,64}$/,
  description: "an agent id",
});

/** `POST /agents`'s body. */
export const AgentCreateBody: Schema<AgentCreateInput> = s.object({
  id: s.optional(AgentId),
  service: Id,
  name: s.optional(s.string({ min: 1, max: 200 })),
});

/** An agent. */
export const Agent: Schema<AgentDto> = s.object({
  id: s.string(),
  service: s.string(),
  name: s.string(),
  createdAt: s.int({ min: 0 }),
  createdBy: s.string(),
  rotatedAt: s.nullable(s.int({ min: 0 })),
  previousAcceptedUntil: s.nullable(s.int({ min: 0 })),
  revokedAt: s.nullable(s.int({ min: 0 })),
  status: s.enum([
    "never-seen",
    "ok",
    "late",
    "offline",
    "signature-failing",
    "revoked",
  ]),
  lastSeen: s.nullable(s.int({ min: 0 })),
  reported: s.nullable(
    s.object({
      agentVersion: s.string(),
      bundleVersion: s.nullable(s.int({ min: 0 })),
      bundleKeyId: s.nullable(s.string()),
      bundleExpired: s.boolean(),
      banSeq: s.string(),
      banCount: s.int({ min: 0 }),
      health: s.enum(["ok", "signature-failing"]),
      lastError: s.optional(s.string()),
    }),
  ),
  revision: s.int({ min: 1 }),
});

/** A page of agents. */
export const Agents = page(Agent);

/** An agent and its secret, shown once. */
export const AgentSecret: Schema<AgentSecretDto> = s.object({
  agent: Agent,
  secret: s.string({ description: "the agent's HMAC secret: shown this once" }),
});

/** A rotation's or revocation's body: the revision read. */
export const RevisionBody = s.object({
  revision: s.int({ min: 1, description: "the revision read" }),
});

/** A ban. */
export const Ban: Schema<BanDto> = s.object({
  id: s.string(),
  scope: s.string(),
  subject: s.object({
    type: s.enum(["ip", "cidr", "user", "apiKey"]),
    value: s.string(),
  }),
  action: s.enum(["ban", "challenge"]),
  reason: s.string(),
  source: s.enum(["auto", "manual"]),
  createdAt: s.int({ min: 0 }),
  expiresAt: s.nullable(s.int({ min: 0 })),
  createdBy: s.optional(s.string()),
  rule: s.optional(s.string()),
  count: s.int({ min: 1 }),
  liftedAt: s.nullable(s.int({ min: 0 })),
  liftedBy: s.optional(s.string()),
  active: s.boolean(),
  revision: s.int({ min: 1 }),
  entered: s.optional(s.object({ apiKey: s.string() })),
});

/** A page of bans. */
export const Bans = page(Ban);

/** `POST /bans`'s body. */
export const BanCreateBody: Schema<BanCreateInput> = s.object({
  scope: s.optional(Scope),
  ip: s.optional(
    s.string({ min: 1, max: 64, description: "an address or CIDR range" }),
  ),
  user: s.optional(s.string({ min: 1, max: 512 })),
  apiKey: s.optional(s.string({ min: 1, max: 512 })),
  action: s.optional(s.enum(["ban", "challenge"])),
  reason: s.string({ min: 1, max: 500 }),
  duration: s.optional(
    s.nullable(
      s.string({
        min: 1,
        max: 20,
        description: 'a duration with its unit ("24h"), or null until lifted',
      }),
    ),
  ),
});

/** `GET /bans`'s query. */
export const BansQuery = s.query({
  limit: s.optional(
    s.int({
      min: 1,
      max: MAX_API_PAGE_LIMIT,
      description: "the page size (default 50)",
    }),
  ),
  cursor: s.optional(
    s.string({ max: 2_000, description: "the previous page's next" }),
  ),
  scope: s.optional(Scope),
  active: s.optional(s.boolean("true: in force now; false: lifted or expired")),
});
