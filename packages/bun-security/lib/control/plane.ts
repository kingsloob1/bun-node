/**
 * The control plane's logic, apart from HTTP (control-plane.md §2–§5):
 * services, groups, service identities, drafts, publishing with
 * inheritance, bundles, approvals and role bindings, over a security
 * store. The routes (`./routes`) call it; nothing here reads a request.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  BanInputRecord,
  BanRecord,
  ListQuery,
  Page,
  StoredBanSubject,
  PolicyVersionRecord,
  StoredDoc,
  AuditQuery,
} from "../store/types";
import { MAX_AUDIT_SCOPES } from "../store/types";
import { banId } from "../store/shared";
import { isWholeFamilyRange, parseAddress, parseCidr } from "../ip/address";
import { boundKey } from "../engine/identity";
import type { Logger } from "@kingsleyweb/bun-common";
import { ConfigError, noopLogger, toDurationMs } from "@kingsleyweb/bun-common";
import type { SecurityApiPermission, SecurityRole } from "./contract/constants";
import type {
  ApprovalDto,
  BanCreateInput,
  BanDto,
  CompiledBundleDto,
  EffectivePolicyDto,
  GroupDto,
  GroupInput,
  PolicyDraftDto,
  PolicyDto,
  PolicyScopeId,
  PolicyVersionDto,
  PublishResultDto,
  RoleBindingDto,
  RoleBindingInput,
  AuditEntryDto,
  SecurityAlertDto,
  SecurityLiveEventDto,
  ServiceDto,
  ServiceIdentityDto,
  ServiceIdentityInput,
  ServiceInput,
} from "./contract/types";
import type { Operator, ResolvedSecurityApiOptions } from "./options";
import type { ParsedScope } from "./scopes";
import {
  BUNDLE_FORMAT,
  MAX_GROUP_DEPTH,
  ROLE_PERMISSIONS,
  SECURITY_ROLES,
} from "./contract/constants";
import { validatePolicy } from "../policy/schema";
import { dangerousChanges } from "./dangerous";
import { diffPolicies, mergePolicies } from "./merge";
import { ApiProblem, conflict, notFound } from "./problems";
import { AuditLog } from "./audit/log";
import { AgentRegistry } from "./agents";
import { liveHooksOf } from "./liveHooks";
import { breakGlassOperators } from "./audit/context";
import type { AuditIntentInput } from "./audit/log";
import { ENTITY_ID, groupScope, parseScope, serviceScope } from "./scopes";
import { signBundle } from "./signing";

/** How long after a head moved the repair pass leaves its bundles to the publish (#847). */
const REPAIR_GRACE_MS = 30_000;

/** The most bundles one repair pass compiles. */
const REPAIR_LIMIT = 100;

/** How long a repair's claim holds before another instance may take it. */
const CLAIM_TTL_MS = 60_000;

/** Whether a bundle's `policyVersions` are `wanted`, in any order. */
function sameVersions(have: unknown, wanted: readonly string[]): boolean {
  if (!Array.isArray(have) || have.length !== wanted.length) return false;
  const set = new Set(wanted);
  return have.every((id) => typeof id === "string" && set.has(id));
}

/** A JSON object. */
type JsonObject = Record<string, unknown>;

/** A service's stored body. */
interface ServiceBody {
  name: string;
  groups: string[];
  environment: string;
  hosts: string[];
  topology: "a" | "b" | "c";
  labels: Record<string, string>;
  requireStepUp: boolean;
}

/** A group's stored body. */
interface GroupBody {
  name: string;
  parent: string | null;
  labels: Record<string, string>;
}

/** A service identity's stored body. */
interface IdentityBody {
  verifier: string | string[];
  forwardsClientIp: boolean;
  exempt: string[];
  services: string[];
}

/** A draft's stored body. */
interface DraftBody {
  policy: JsonObject;
  baseHead: string | null;
  updatedBy: string;
}

/** What an approval carries out once approved. */
type ApprovalPayload =
  | {
      kind: "publish";
      scope: PolicyScopeId;
      policy: JsonObject;
      expectedHead: string | null;
      message: string;
    }
  | { kind: "roleBinding.create"; input: RoleBindingInput }
  | { kind: "roleBinding.delete"; id: string; revision: number }
  | {
      kind: "serviceIdentity.put";
      id: string;
      input: ServiceIdentityInput;
      revision: number | null;
    }
  | { kind: "serviceIdentity.delete"; id: string; revision: number };

/** An approval's stored body. */
interface ApprovalBody {
  action: ApprovalDto["action"];
  scope: PolicyScopeId;
  status: ApprovalDto["status"];
  author: string;
  createdAt: number;
  expiresAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
  dangerous: string[];
  summary: JsonObject;
  payload: ApprovalPayload;
}

/** A role binding's stored body. */
interface BindingBody {
  operator: string;
  role: SecurityRole;
  scope: PolicyScopeId;
  createdBy: string;
  createdAt: number;
}

/** What a publish asks for besides the content. */
export interface PublishRequest {
  /** The head the change was based on. */
  readonly expectedHead: string | null;
  /** Why. */
  readonly message?: string;
  /** The scope's name typed, confirming a dangerous change when approvals are off. */
  readonly confirm?: string;
  /** Publish at once and open a review. */
  readonly emergency?: boolean;
  /** `policy.rollback` for a rollback; `policy.publish` otherwise. */
  readonly action?: "policy.publish" | "policy.rollback";
}

/** What a publish did: published, or opened an approval. */
export type PublishOutcome =
  | { readonly kind: "published"; readonly result: PublishResultDto }
  | { readonly kind: "approval"; readonly approval: ApprovalDto };

/** The most pages a whole-kind walk reads (100,000 documents). */
const MAX_WALK_PAGES = 100;

/** A store's refusal of a list query (a foreign or malformed cursor) as a `400`; anything else as it is. */
function badCursor(error: unknown): unknown {
  return error instanceof ConfigError
    ? new ApiProblem(
        400,
        "invalid_request",
        "the cursor does not belong to this list",
      )
    : error;
}

/** A short random id with `prefix`. */
function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** The control plane over a store; see the module's description. */
export class ControlPlane {
  /** Live event listeners. */
  readonly #listeners = new Set<(event: SecurityLiveEventDto) => void>();
  /** Told when an operator's access may have changed (a role binding written). */
  readonly #accessListeners = new Set<() => void>();

  /**
   * @param options The API's resolved options.
   */
  /** The audit log. */
  readonly audit: AuditLog;
  /** The agents' keys and health, when agents are served (PR-CP4). */
  readonly agents: AgentRegistry | undefined;
  /** Where failures are logged. */
  readonly #logger: Logger;

  /**
   * @param options The API's resolved options.
   * @param logger Where failures are logged.
   */
  constructor(
    private readonly options: ResolvedSecurityApiOptions,
    logger: Logger = noopLogger,
  ) {
    this.#logger = logger;
    this.audit = new AuditLog({
      store: options.store,
      signer: options.audit.signer,
      previousKeys: options.audit.previousKeys,
      sinks: options.audit.sinks,
      checkpointEvery: options.audit.checkpointEvery,
      checkpointIntervalMs: options.audit.checkpointIntervalMs,
      now: options.now,
      alert: (alert) => this.#alert(alert),
      logger,
    });
    this.agents =
      options.agents === undefined
        ? undefined
        : new AgentRegistry(this, options.agents);
  }

  /** Raises an alert: the host's `onAlert`, and the log. */
  #alert(alert: Omit<SecurityAlertDto, "at">): void {
    const out: SecurityAlertDto = { ...alert, at: this.options.now() };
    const fields = { kind: out.kind, detail: out.detail };
    if (out.severity === "critical")
      this.#logger.error(`bun-security: ${out.message}`, fields);
    else this.#logger.warn(`bun-security: ${out.message}`, fields);
    try {
      this.options.onAlert(out);
    } catch (error) {
      this.#logger.error("bun-security: onAlert threw", { error });
    }
  }

  /** The control plane's clock, epoch ms. */
  now(): number {
    return this.options.now();
  }

  /** The bundle signer (bundles, and ban batches since PR-CP4). */
  get signer(): ResolvedSecurityApiOptions["signer"] {
    return this.options.signer;
  }

  /** Where the control plane logs. */
  get logger(): Logger {
    return this.#logger;
  }

  /** Raises an alert from outside (break-glass, verify). */
  alert(alert: Omit<SecurityAlertDto, "at">): void {
    this.#alert(alert);
  }

  /** Emits a live event from outside (break-glass). */
  emit(
    event: SecurityLiveEventDto["event"],
    scope: PolicyScopeId,
    data: JsonObject,
  ): void {
    this.#emit(event, scope, data);
  }

  /**
   * Runs a change between its audit intent and done (the user's rule,
   * PR-CP3): no intent, no change (a \`503\`); a refused change's done
   * says why; a done that cannot be written leaves the change standing.
   */
  async #audited<T>(
    intent: AuditIntentInput,
    run: () => Promise<T>,
    done: (result: T) => JsonObject = () => ({}),
  ): Promise<T> {
    const handle = await this.audit.intent(intent);
    let result: T;
    try {
      result = await run();
    } catch (error) {
      await this.audit.done(handle, "refused", {
        reason: error instanceof ApiProblem ? error.code : "error",
      });
      throw error;
    }
    await this.audit.done(handle, "applied", done(result));
    return result;
  }

  /** A document's current body, for an entry's before. */
  async #before(kind: StoredDoc["kind"], id: string): Promise<unknown> {
    return (await this.store.get(kind, id).catch(() => undefined))?.doc;
  }

  /** The store. */
  get store() {
    return this.options.store;
  }

  /** Listens to live events; answers the unsubscribe. */
  listen(listener: (event: SecurityLiveEventDto) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Emits a live event. */
  #emit(
    event: SecurityLiveEventDto["event"],
    scope: PolicyScopeId,
    data: JsonObject,
  ): void {
    const out: SecurityLiveEventDto = {
      event,
      scope,
      data,
      at: this.options.now(),
    };
    for (const listener of [...this.#listeners]) {
      try {
        listener(out);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** Every document of `kind`, walked page by page. */
  async #all(kind: StoredDoc["kind"]): Promise<StoredDoc[]> {
    const out: StoredDoc[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_WALK_PAGES; page++) {
      const found: Page<StoredDoc> = await this.store.list(kind, {
        limit: 1_000,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...found.items);
      if (found.next === undefined) return out;
      cursor = found.next;
    }
    return out;
  }

  /** A page of `kind`; a cursor of another walk, or a malformed one, is a `400`. */
  async #page(
    kind: StoredDoc["kind"],
    query: ListQuery,
  ): Promise<Page<StoredDoc>> {
    try {
      return await this.store.list(kind, query);
    } catch (error) {
      throw badCursor(error);
    }
  }

  /** A page of a scope's versions; a bad cursor is a `400`. */
  async #versionsPage(
    scope: PolicyScopeId,
    query: ListQuery,
  ): Promise<Page<PolicyVersionRecord>> {
    try {
      return await this.store.listVersions(scope, query);
    } catch (error) {
      throw badCursor(error);
    }
  }

  // ── Services ─────────────────────────────────────────────────────────────

  /** A stored service as its DTO. */
  #service(doc: StoredDoc): ServiceDto {
    const body = doc.doc as ServiceBody;
    return {
      id: doc.id,
      ...body,
      revision: doc.revision,
      updatedAt: doc.updatedAt,
    };
  }

  /** A page of services. */
  async listServices(
    limit: number,
    cursor?: string,
  ): Promise<{ items: ServiceDto[]; next?: string }> {
    const page = await this.#page("service", {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: page.items.map((doc) => this.#service(doc)),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  /** One service. */
  async getService(id: string): Promise<ServiceDto> {
    const doc = await this.store.get("service", id);
    if (doc === undefined) throw notFound(`service "${id}"`);
    return this.#service(doc);
  }

  /** Creates (`revision` absent) or updates a service; its bundle is recompiled. */
  async #putServiceNow(
    id: string,
    input: ServiceInput,
    create: boolean,
  ): Promise<ServiceDto> {
    if (!ENTITY_ID.test(id))
      throw new ApiProblem(400, "invalid_request", `"${id}" is not an id`);
    const groups = [...new Set(input.groups ?? [])];
    for (const group of groups) {
      if ((await this.store.get("group", group)) === undefined)
        throw notFound(`group "${group}"`);
    }
    const body: ServiceBody = {
      name: input.name,
      groups,
      environment: input.environment ?? "production",
      hosts: [...(input.hosts ?? [])],
      topology: input.topology ?? "a",
      labels: { ...input.labels },
      requireStepUp: input.requireStepUp ?? false,
    };
    // The effective policy under the new groups must compile before the write.
    await this.effective(id, { groups });
    const written = await this.store.put(
      "service",
      id,
      body,
      create ? null : (input.revision ?? 0),
    );
    if (!written.ok) {
      throw conflict(
        create
          ? `service "${id}" exists`
          : `service "${id}" changed since revision ${input.revision}`,
        written.conflict === undefined ? null : this.#service(written.conflict),
      );
    }
    await this.compileBundle(id);
    return this.getService(id);
  }

  /** Deletes a service at `revision`. */
  async #deleteServiceNow(id: string, revision: number): Promise<void> {
    if (!(await this.store.delete("service", id, revision))) {
      const current = await this.store.get("service", id);
      if (current === undefined) throw notFound(`service "${id}"`);
      throw conflict(
        `service "${id}" changed since revision ${revision}`,
        this.#service(current),
      );
    }
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  /** A stored group as its DTO. */
  #group(doc: StoredDoc): GroupDto {
    const body = doc.doc as GroupBody;
    return {
      id: doc.id,
      ...body,
      revision: doc.revision,
      updatedAt: doc.updatedAt,
    };
  }

  /** A page of groups. */
  async listGroups(
    limit: number,
    cursor?: string,
  ): Promise<{ items: GroupDto[]; next?: string }> {
    const page = await this.#page("group", {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: page.items.map((doc) => this.#group(doc)),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  /** One group. */
  async getGroup(id: string): Promise<GroupDto> {
    const doc = await this.store.get("group", id);
    if (doc === undefined) throw notFound(`group "${id}"`);
    return this.#group(doc);
  }

  /** The chain of `id`'s ancestors and itself, outermost first; refuses a cycle or a depth over the bound. */
  async groupChain(
    id: string,
    parentOverride?: { id: string; parent: string | null },
  ): Promise<string[]> {
    const chain: string[] = [];
    let at: string | null = id;
    while (at !== null) {
      if (chain.includes(at)) {
        throw new ApiProblem(
          422,
          "invalid_request",
          `group "${id}" would be its own ancestor`,
        );
      }
      chain.unshift(at);
      if (chain.length > MAX_GROUP_DEPTH) {
        throw new ApiProblem(
          422,
          "invalid_request",
          `groups nest at most ${MAX_GROUP_DEPTH} deep`,
        );
      }
      if (parentOverride !== undefined && at === parentOverride.id) {
        at = parentOverride.parent;
        continue;
      }
      const doc: StoredDoc | undefined = await this.store.get("group", at);
      if (doc === undefined) throw notFound(`group "${at}"`);
      at = (doc.doc as GroupBody).parent;
    }
    return chain;
  }

  /** Creates or updates a group; every service under it is recompiled. */
  async #putGroupNow(
    id: string,
    input: GroupInput,
    create: boolean,
  ): Promise<GroupDto> {
    if (!ENTITY_ID.test(id))
      throw new ApiProblem(400, "invalid_request", `"${id}" is not an id`);
    const parent = input.parent ?? null;
    // The group's own chain with its new parent: no cycle, at most the depth.
    if (parent !== null) await this.groupChain(id, { id, parent });
    const body: GroupBody = {
      name: input.name,
      parent,
      labels: { ...input.labels },
    };
    const written = await this.store.put(
      "group",
      id,
      body,
      create ? null : (input.revision ?? 0),
    );
    if (!written.ok) {
      throw conflict(
        create
          ? `group "${id}" exists`
          : `group "${id}" changed since revision ${input.revision}`,
        written.conflict === undefined ? null : this.#group(written.conflict),
      );
    }
    if (!create) await this.recompileUnder(groupScope(id));
    return this.getGroup(id);
  }

  /** Deletes a group at `revision`; refused while a service or group names it. */
  async #deleteGroupNow(id: string, revision: number): Promise<void> {
    const services = await this.#all("service");
    const groups = await this.#all("group");
    if (
      services.some((doc) => (doc.doc as ServiceBody).groups.includes(id)) ||
      groups.some((doc) => (doc.doc as GroupBody).parent === id)
    ) {
      throw new ApiProblem(409, "conflict", `group "${id}" still has members`);
    }
    if (!(await this.store.delete("group", id, revision))) {
      const current = await this.store.get("group", id);
      if (current === undefined) throw notFound(`group "${id}"`);
      throw conflict(
        `group "${id}" changed since revision ${revision}`,
        this.#group(current),
      );
    }
  }

  // ── Service identities ───────────────────────────────────────────────────

  /** A stored identity as its DTO. */
  #identity(doc: StoredDoc): ServiceIdentityDto {
    const body = doc.doc as IdentityBody;
    return {
      id: doc.id,
      ...body,
      revision: doc.revision,
      updatedAt: doc.updatedAt,
    };
  }

  /** A page of service identities. */
  async listIdentities(
    limit: number,
    cursor?: string,
  ): Promise<{ items: ServiceIdentityDto[]; next?: string }> {
    const page = await this.#page("serviceIdentity", {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: page.items.map((doc) => this.#identity(doc)),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  /** One identity. */
  async getIdentity(id: string): Promise<ServiceIdentityDto> {
    const doc = await this.store.get("serviceIdentity", id);
    if (doc === undefined) throw notFound(`service identity "${id}"`);
    return this.#identity(doc);
  }

  /** Creates (`revision` null) or updates an identity; the services it may call are recompiled. */
  async #putIdentityNow(
    id: string,
    input: ServiceIdentityInput,
    revision: number | null,
  ): Promise<ServiceIdentityDto> {
    if (!ENTITY_ID.test(id))
      throw new ApiProblem(400, "invalid_request", `"${id}" is not an id`);
    const body: IdentityBody = {
      verifier: Array.isArray(input.verifier)
        ? [...input.verifier]
        : (input.verifier as string),
      forwardsClientIp: input.forwardsClientIp ?? false,
      exempt: [
        ...(input.exempt ?? ["lists", "bans", "countedRules", "globalLimits"]),
      ],
      services: [...new Set(input.services ?? [])],
    };
    const issues = validatePolicy({
      serviceIdentity: {
        services: [
          {
            id,
            verifier: body.verifier,
            forwardsClientIp: body.forwardsClientIp,
            exempt: body.exempt,
          },
        ],
      },
    });
    if (issues.length > 0) {
      throw new ApiProblem(422, "invalid_policy", "the identity is not valid", {
        issues: issues.map((issue) => ({
          message: issue.message,
          path: issue.path.slice(3),
        })),
      });
    }
    const written = await this.store.put("serviceIdentity", id, body, revision);
    if (!written.ok) {
      throw conflict(
        revision === null
          ? `service identity "${id}" exists`
          : `service identity "${id}" changed`,
        written.conflict === undefined
          ? null
          : this.#identity(written.conflict),
      );
    }
    await this.#recompileFor(body.services);
    return this.getIdentity(id);
  }

  /** Deletes an identity at `revision`. */
  async #deleteIdentityNow(id: string, revision: number): Promise<void> {
    const current = await this.store.get("serviceIdentity", id);
    if (current === undefined) throw notFound(`service identity "${id}"`);
    if (!(await this.store.delete("serviceIdentity", id, revision))) {
      throw conflict(
        `service identity "${id}" changed`,
        this.#identity(current),
      );
    }
    await this.#recompileFor((current.doc as IdentityBody).services);
  }

  /** Recompiles the named services, or every service for an empty list. */
  async #recompileFor(services: readonly string[]): Promise<void> {
    if (services.length === 0) {
      await this.recompileUnder("global");
      return;
    }
    for (const service of services) {
      if ((await this.store.get("service", service)) !== undefined)
        await this.compileBundle(service);
    }
  }

  // ── Policies ─────────────────────────────────────────────────────────────

  /** Checks `scope` names an existing entity; its parsed form. */
  async checkScope(scope: string): Promise<ParsedScope> {
    const parsed = parseScope(scope);
    if (parsed === undefined) {
      throw new ApiProblem(
        400,
        "invalid_request",
        `"${scope}" is not a scope (global, group:<id>, service:<id>)`,
      );
    }
    if (
      parsed.kind !== "global" &&
      (await this.store.get(parsed.kind, parsed.id)) === undefined
    ) {
      throw notFound(`${parsed.kind} "${parsed.id}"`);
    }
    return parsed;
  }

  /** The head of a scope's policy. */
  async #head(
    scope: PolicyScopeId,
  ): Promise<{ id: string; number: number } | null> {
    const doc = await this.store.get("policy", scope);
    if (doc === undefined) return null;
    const head = doc.doc as { head: string; number: number };
    return { id: head.head, number: head.number };
  }

  /** The head's policy of a scope, or `{}`. */
  async #headPolicy(
    scope: PolicyScopeId,
  ): Promise<{ id: string | null; policy: JsonObject }> {
    const head = await this.#head(scope);
    if (head === null) return { id: null, policy: {} };
    const version = await this.store.getVersion(scope, head.id);
    return { id: head.id, policy: (version?.policy ?? {}) as JsonObject };
  }

  /** A scope's draft and head. */
  async getPolicy(scope: PolicyScopeId): Promise<PolicyDto> {
    await this.checkScope(scope);
    const draft = await this.store.get("policyDraft", scope);
    return {
      scope,
      draft: draft === undefined ? null : this.#draft(draft),
      head: await this.#head(scope),
    };
  }

  /** A stored draft as its DTO. */
  #draft(doc: StoredDoc): PolicyDraftDto {
    const body = doc.doc as DraftBody;
    return {
      policy: body.policy,
      baseHead: body.baseHead,
      updatedBy: body.updatedBy,
      revision: doc.revision,
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * Saves a scope's draft at `revision` (`null`: a new draft). The draft
   * layered over the scopes above it must compile, and must not override a
   * locked item.
   */
  async #putDraftNow(
    scope: PolicyScopeId,
    policy: JsonObject,
    revision: number | null,
    operator: Operator,
  ): Promise<PolicyDraftDto> {
    await this.checkScope(scope);
    await this.#validateScope(scope, policy);
    const head = await this.#head(scope);
    const existing = await this.store.get("policyDraft", scope);
    const body: DraftBody = {
      policy,
      baseHead:
        revision === null
          ? (head?.id ?? null)
          : ((existing?.doc as DraftBody | undefined)?.baseHead ??
            head?.id ??
            null),
      updatedBy: operator.id,
    };
    const written = await this.store.put("policyDraft", scope, body, revision);
    if (!written.ok) {
      throw conflict(
        "the draft changed since you read it: rebase your edit on it",
        written.conflict === undefined ? null : this.#draft(written.conflict),
      );
    }
    return this.#draft((await this.store.get("policyDraft", scope))!);
  }

  /**
   * The scope's own effective policy with `policy` in its place (every
   * scope above it, then it), compiled: an invalid one, or one overriding a
   * locked item, is a `422`.
   */
  async #validateScope(
    scope: PolicyScopeId,
    policy: JsonObject,
  ): Promise<void> {
    const layers = await this.#layersAbove(scope);
    const merged = mergePolicies([...layers, { scope, policy }]);
    if (merged.locked.length > 0) {
      throw new ApiProblem(
        422,
        "locked",
        merged.locked
          .map((item) => `${item.path} is locked by ${item.lockedBy}`)
          .join("; "),
      );
    }
    const issues = validatePolicy(merged.policy);
    if (issues.length > 0) {
      throw new ApiProblem(
        422,
        "invalid_policy",
        "the policy does not compile",
        {
          issues: issues.map((issue) => ({
            message: issue.message,
            path: issue.path,
          })),
        },
      );
    }
  }

  /** The published layers above `scope`, outermost first. */
  async #layersAbove(
    scope: PolicyScopeId,
  ): Promise<{ scope: PolicyScopeId; policy: JsonObject }[]> {
    const parsed = parseScope(scope);
    if (parsed === undefined || parsed.kind === "global") return [];
    const scopes: PolicyScopeId[] = ["global"];
    if (parsed.kind === "group") {
      const chain = await this.groupChain(parsed.id);
      scopes.push(...chain.slice(0, -1).map(groupScope));
    } else {
      scopes.push(...(await this.#groupScopesOf(parsed.id)));
    }
    return await Promise.all(
      scopes.map(async (at) => ({
        scope: at,
        policy: (await this.#headPolicy(at)).policy,
      })),
    );
  }

  /** The group scopes a service inherits, outermost first, each group's chain in turn. */
  async #groupScopesOf(
    serviceId: string,
    groups?: readonly string[],
  ): Promise<PolicyScopeId[]> {
    const own =
      groups ??
      (
        (await this.store.get("service", serviceId))?.doc as
          ServiceBody | undefined
      )?.groups ??
      [];
    const out: PolicyScopeId[] = [];
    for (const group of own) {
      for (const at of await this.groupChain(group)) {
        if (!out.includes(groupScope(at))) out.push(groupScope(at));
      }
    }
    return out;
  }

  /** A page of a scope's versions, newest first. */
  async listVersions(
    scope: PolicyScopeId,
    limit: number,
    cursor?: string,
  ): Promise<{ items: PolicyVersionDto[]; next?: string }> {
    await this.checkScope(scope);
    const head = await this.#head(scope);
    const page = await this.#versionsPage(scope, {
      limit,
      direction: "desc",
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: page.items.map((version) => ({
        scope,
        id: version.id,
        number: version.number,
        policy: version.policy as JsonObject,
        createdAt: version.createdAt,
        createdBy: version.createdBy ?? null,
        message: version.message ?? null,
        status: version.id === head?.id ? "published" : "superseded",
      })),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  /** One version. */
  async getVersion(
    scope: PolicyScopeId,
    id: string,
  ): Promise<PolicyVersionDto> {
    await this.checkScope(scope);
    const version = await this.store.getVersion(scope, id);
    if (version === undefined) throw notFound(`version "${id}" of ${scope}`);
    const head = await this.#head(scope);
    return {
      scope,
      id: version.id,
      number: version.number,
      policy: version.policy as JsonObject,
      createdAt: version.createdAt,
      createdBy: version.createdBy ?? null,
      message: version.message ?? null,
      status: version.id === head?.id ? "published" : "superseded",
    };
  }

  /** A policy named by `ref`: `draft`, `head` or a version id. */
  async policyAt(scope: PolicyScopeId, ref: string): Promise<JsonObject> {
    if (ref === "draft") {
      const draft = await this.store.get("policyDraft", scope);
      if (draft === undefined) throw notFound(`a draft of ${scope}`);
      return (draft.doc as DraftBody).policy;
    }
    if (ref === "head") return (await this.#headPolicy(scope)).policy;
    return (await this.getVersion(scope, ref)).policy;
  }

  /** The services a change at `scope` reaches. */
  async servicesUnder(scope: PolicyScopeId): Promise<ServiceDto[]> {
    const parsed = parseScope(scope);
    if (parsed === undefined) return [];
    if (parsed.kind === "service") {
      const doc = await this.store.get("service", parsed.id);
      return doc === undefined ? [] : [this.#service(doc)];
    }
    const all = (await this.#all("service")).map((doc) => this.#service(doc));
    if (parsed.kind === "global") return all;
    const out: ServiceDto[] = [];
    for (const service of all) {
      if (
        (await this.#groupScopesOf(service.id, service.groups)).includes(scope)
      )
        out.push(service);
    }
    return out;
  }

  /**
   * A service's effective policy (control-plane.md §2.2), with
   * `override`'s scope policy in place of the published one, or the
   * service's groups replaced; a `422` when it does not compile.
   */
  async effective(
    serviceId: string,
    override: {
      scope?: PolicyScopeId;
      policy?: JsonObject;
      groups?: readonly string[];
    } = {},
  ): Promise<EffectivePolicyDto> {
    const scopes: PolicyScopeId[] = [
      "global",
      ...(await this.#groupScopesOf(serviceId, override.groups)),
      serviceScope(serviceId),
    ];
    const versions: string[] = [];
    const layers: { scope: PolicyScopeId; policy: JsonObject }[] = [];
    for (const scope of scopes) {
      if (override.scope === scope && override.policy !== undefined) {
        layers.push({ scope, policy: override.policy });
        versions.push(`${scope}@draft`);
        continue;
      }
      const head = await this.#headPolicy(scope);
      layers.push({ scope, policy: head.policy });
      if (head.id !== null) versions.push(head.id);
    }
    const merged = mergePolicies(layers);
    if (merged.locked.length > 0) {
      throw new ApiProblem(
        422,
        "locked",
        merged.locked
          .map((item) => `${item.path} is locked by ${item.lockedBy}`)
          .join("; "),
      );
    }
    const policy = merged.policy;
    policy.service ??= serviceId;
    // The identities allowed to call this service join its policy.
    const identities = (await this.#all("serviceIdentity"))
      .map((doc) => this.#identity(doc))
      .filter(
        (identity) =>
          identity.services.length === 0 ||
          identity.services.includes(serviceId),
      );
    if (identities.length > 0) {
      const section = (policy.serviceIdentity ?? { services: [] }) as {
        services?: JsonObject[];
      };
      const own = (section.services ?? []).filter(
        (entry) => !identities.some((identity) => identity.id === entry.id),
      );
      policy.serviceIdentity = {
        ...section,
        services: [
          ...own,
          ...identities.map((identity) => ({
            id: identity.id,
            verifier: identity.verifier,
            forwardsClientIp: identity.forwardsClientIp,
            exempt: identity.exempt,
          })),
        ],
      };
    }
    const issues = validatePolicy(policy);
    if (issues.length > 0) {
      throw new ApiProblem(
        422,
        "invalid_policy",
        `the effective policy of service "${serviceId}" does not compile`,
        {
          issues: issues.map((issue) => ({
            message: issue.message,
            path: issue.path,
          })),
        },
      );
    }
    return {
      service: serviceId,
      policyVersions: versions,
      policy,
      origins: merged.origins,
    };
  }

  /** Compiles, signs and stores `serviceId`'s bundle, one version past the last. */
  async compileBundle(serviceId: string): Promise<CompiledBundleDto> {
    const effective = await this.effective(serviceId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.store.getBundle(serviceId);
      const last =
        current === undefined || current === "not-modified"
          ? null
          : current.version;
      const version = (last ?? 0) + 1;
      const now = this.options.now();
      const bundle = await signBundle(
        {
          format: BUNDLE_FORMAT,
          service: serviceId,
          version,
          policyVersions: effective.policyVersions,
          compiledAt: new Date(now).toISOString(),
          notBefore: new Date(now).toISOString(),
          expiresAt: new Date(now + this.options.bundleTtlMs).toISOString(),
          effective: effective.policy,
          artefacts: [],
        },
        this.options.signer,
      );
      const stored = await this.store.putBundle(
        serviceId,
        { version, bundle },
        last,
      );
      if (stored.ok) {
        this.#emit("bundle.compiled", serviceScope(serviceId), {
          service: serviceId,
          version,
        });
        return { service: serviceId, version };
      }
    }
    throw new ApiProblem(
      409,
      "conflict",
      `the bundle of service "${serviceId}" kept changing; try again`,
    );
  }

  /**
   * The repair pass (#847): recompiles each service bundle whose policy
   * versions are behind the heads of its scopes, as a publish cut off
   * between appending its version and writing its bundles leaves it.
   * - A head moved less than `graceMs` ago is left alone: its publish may
   *   still be compiling, on this instance or another.
   * - Safe with several instances at once: each repair is claimed in the
   *   store (`claimKey`, per service and head) by one of them; a claimer
   *   that dies leaves the claim to lapse after `CLAIM_TTL_MS`, and the
   *   next pass repairs it.
   * - Bounded: at most `limit` bundles a pass; the rest wait for the next.
   * - Each repair is audited as a system action, `bundle.repair`.
   * A service whose effective policy does not compile, or that has no
   * bundle yet, is skipped. Answers the bundles compiled.
   */
  async repairBundles(
    options: { readonly graceMs?: number; readonly limit?: number } = {},
  ): Promise<CompiledBundleDto[]> {
    const graceMs = options.graceMs ?? REPAIR_GRACE_MS;
    const limit = options.limit ?? REPAIR_LIMIT;
    const out: CompiledBundleDto[] = [];
    for (const doc of await this.#all("service")) {
      if (out.length >= limit) break;
      const serviceId = doc.id;
      const current = await this.store.getBundle(serviceId);
      if (current === undefined || current === "not-modified") continue;
      let wanted: readonly string[];
      try {
        wanted = (await this.effective(serviceId)).policyVersions;
      } catch {
        continue;
      }
      const have = (current.bundle as { policyVersions?: unknown })
        .policyVersions;
      if (sameVersions(have, wanted)) continue;
      // A head that moved just now may belong to a publish still compiling.
      const scopes: PolicyScopeId[] = [
        "global",
        ...(await this.#groupScopesOf(serviceId)),
        serviceScope(serviceId),
      ];
      let moved = 0;
      for (const scope of scopes) {
        const head = await this.store.get("policy", scope);
        if (head !== undefined) moved = Math.max(moved, head.updatedAt);
      }
      if (this.options.now() - moved < graceMs) continue;
      const claim = `bundle-repair:${serviceId}:${createHash("sha256")
        .update([...wanted].sort().join("\n"))
        .digest("hex")
        .slice(0, 32)}`;
      if (!(await this.store.claimKey(claim, CLAIM_TTL_MS))) continue;
      out.push(
        await this.#audited(
          {
            action: "bundle.repair",
            scope: serviceScope(serviceId),
            target: {
              kind: "bundle",
              id: serviceId,
              revision: current.version + 1,
            },
            before: { version: current.version, policyVersions: have },
            after: { policyVersions: wanted },
          },
          async () => await this.compileBundle(serviceId),
          (compiled) => ({ version: compiled.version }),
        ),
      );
    }
    return out;
  }

  /** Recompiles every service under `scope`. */
  async recompileUnder(scope: PolicyScopeId): Promise<CompiledBundleDto[]> {
    const out: CompiledBundleDto[] = [];
    for (const service of await this.servicesUnder(scope))
      out.push(await this.compileBundle(service.id));
    return out;
  }

  /**
   * The dangerous changes publishing `policy` at `scope` would make, over
   * every service it reaches; each line names the service. Checks that
   * every one of them still compiles.
   */
  async dangerousFor(
    scope: PolicyScopeId,
    policy: JsonObject,
  ): Promise<string[]> {
    const found: string[] = [];
    for (const service of await this.servicesUnder(scope)) {
      const before = (await this.effective(service.id)).policy;
      const after = (await this.effective(service.id, { scope, policy }))
        .policy;
      for (const line of dangerousChanges(
        before,
        after,
        service.environment === "production",
      )) {
        found.push(`service ${service.id}: ${line}`);
      }
    }
    return found;
  }

  /**
   * Publishes `policy` at `scope` (control-plane.md §3.2): validated,
   * checked for dangerous changes, appended on `expectedHead`, and every
   * service under it recompiled. A dangerous change opens an approval
   * under `approvals: "two-person"` (unless an emergency), or needs the
   * scope's name typed in `confirm`; `forceApproval` (no step-up hook)
   * opens one whatever the change.
   */
  async #publishNow(
    scope: PolicyScopeId,
    policy: JsonObject,
    request: PublishRequest,
    operator: Operator,
    context: {
      readonly approved?: ApprovalDto;
      readonly forceApproval?: boolean;
      readonly versionId?: string;
    } = {},
  ): Promise<PublishOutcome> {
    await this.checkScope(scope);
    await this.#validateScope(scope, policy);
    const action = request.action ?? "policy.publish";
    const dangerous = await this.dangerousFor(scope, policy);
    const twoPerson = this.options.approvals === "two-person";
    if (context.approved === undefined) {
      const head = await this.#head(scope);
      if ((head?.id ?? null) !== request.expectedHead) {
        throw conflict(
          "the policy was published since your change was based on it",
          head,
        );
      }
      if (
        (dangerous.length > 0 && twoPerson && request.emergency !== true) ||
        context.forceApproval === true
      ) {
        const approval = await this.#openApproval({
          action,
          scope,
          author: operator.id,
          status: "pending",
          dangerous:
            dangerous.length > 0
              ? dangerous
              : ["step-up unavailable: a second operator approves instead"],
          summary: {
            message: request.message ?? null,
            ...(action === "policy.rollback" ? { rollback: true } : {}),
          },
          payload: {
            kind: "publish",
            scope,
            policy,
            expectedHead: request.expectedHead,
            message: request.message ?? "",
          },
        });
        return { kind: "approval", approval };
      }
      // Without approvals, a dangerous change (an emergency's too) is
      // confirmed by typing the scope's name.
      if (dangerous.length > 0 && !twoPerson && request.confirm !== scope) {
        throw new ApiProblem(
          428,
          "confirmation_required",
          `this change is dangerous: type the scope's name ("${scope}") in confirm to publish it`,
          { dangerous },
        );
      }
    }
    const id = context.versionId ?? newId("pv");
    const appended = await this.store.appendVersion(
      scope,
      { id, policy, createdBy: operator.id, message: request.message ?? "" },
      request.expectedHead,
    );
    if (!appended.ok) {
      throw conflict(
        "the policy was published since your change was based on it",
        { head: appended.head },
      );
    }
    const draft = await this.store.get("policyDraft", scope);
    if (draft !== undefined && context.approved === undefined) {
      await this.store.delete("policyDraft", scope, draft.revision);
    }
    const bundles = await this.recompileUnder(scope);
    const version = await this.getVersion(scope, id);
    if (dangerous.length > 0) {
      this.#alert({
        kind:
          request.emergency === true
            ? "approval.emergency"
            : "policy.dangerous",
        severity: request.emergency === true ? "critical" : "info",
        message:
          request.emergency === true
            ? `an emergency publish of ${scope} went out with dangerous changes; a second operator must review it`
            : `a dangerous change of ${scope} was published`,
        detail: { scope, version: id, dangerous: dangerous.slice(0, 20) },
      });
    }
    this.#emit("policy.published", scope, {
      version: id,
      number: version.number,
    });
    let review: ApprovalDto | undefined;
    if (request.emergency === true && dangerous.length > 0 && twoPerson) {
      review = await this.#openApproval({
        action,
        scope,
        author: operator.id,
        status: "review",
        dangerous,
        summary: {
          message: request.message ?? null,
          version: id,
          emergency: true,
        },
        payload: {
          kind: "publish",
          scope,
          policy,
          expectedHead: request.expectedHead,
          message: request.message ?? "",
        },
      });
    }
    return {
      kind: "published",
      result: { version, bundles, ...(review ? { review } : {}) },
    };
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  /** A stored approval as its DTO, expired when its time passed. */
  #approval(doc: StoredDoc): ApprovalDto {
    const body = doc.doc as ApprovalBody;
    const status =
      body.status === "pending" && this.options.now() >= body.expiresAt
        ? "expired"
        : body.status;
    return {
      id: doc.id,
      action: body.action,
      scope: body.scope,
      status,
      author: body.author,
      createdAt: body.createdAt,
      expiresAt: body.expiresAt,
      decidedBy: body.decidedBy,
      decidedAt: body.decidedAt,
      reason: body.reason,
      dangerous: body.dangerous,
      summary: body.summary,
      revision: doc.revision,
    };
  }

  /** Opens an approval. */
  async #openApprovalNow(
    input: Omit<
      ApprovalBody,
      "createdAt" | "expiresAt" | "decidedBy" | "decidedAt" | "reason"
    >,
    id: string,
  ): Promise<ApprovalDto> {
    const now = this.options.now();
    const body: ApprovalBody = {
      ...input,
      createdAt: now,
      expiresAt: now + this.options.approvalTtlMs,
      decidedBy: null,
      decidedAt: null,
      reason: null,
    };
    await this.store.put("approval", id, body, null);
    const approval = this.#approval((await this.store.get("approval", id))!);
    this.#emit("approval.created", approval.scope, {
      id,
      action: approval.action,
      status: approval.status,
    });
    return approval;
  }

  /** Opens an approval for an action that needs a second operator because no step-up hook is configured. */
  async #requestApprovalNow(
    action: ApprovalDto["action"],
    scope: PolicyScopeId,
    operator: Operator,
    payload: ApprovalPayload,
    summary: JsonObject,
  ): Promise<ApprovalDto> {
    return await this.#openApproval({
      action,
      scope,
      author: operator.id,
      status: "pending",
      dangerous: ["step-up unavailable: a second operator approves instead"],
      summary,
      payload,
    });
  }

  /** A page of approvals, newest first. */
  async listApprovals(
    limit: number,
    cursor?: string,
  ): Promise<{ items: ApprovalDto[]; next?: string }> {
    const page = await this.#page("approval", {
      limit,
      sort: "updatedAt",
      direction: "desc",
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: page.items.map((doc) => this.#approval(doc)),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  /** One approval. */
  async getApproval(id: string): Promise<ApprovalDto> {
    const doc = await this.store.get("approval", id);
    if (doc === undefined) throw notFound(`approval "${id}"`);
    return this.#approval(doc);
  }

  /** The permission deciding `approval`. */
  permissionFor(approval: ApprovalDto): SecurityApiPermission {
    return approval.action.startsWith("policy.")
      ? "policy:publish"
      : approval.action.startsWith("roleBinding.")
        ? "roles:write"
        : "identities:write";
  }

  /**
   * Decides `id` at `revision`: approved (carried out) or rejected, by an
   * operator who is not its author. A `review` (an emergency publish's)
   * is closed by approving it.
   */
  async #decideNow(
    id: string,
    revision: number,
    approve: boolean,
    reason: string | undefined,
    operator: Operator,
  ): Promise<{ approval: ApprovalDto; result?: unknown }> {
    const doc = await this.store.get("approval", id);
    if (doc === undefined) throw notFound(`approval "${id}"`);
    const approval = this.#approval(doc);
    const body = doc.doc as ApprovalBody;
    if (approval.status !== "pending" && approval.status !== "review") {
      throw new ApiProblem(
        409,
        "approval_closed",
        `approval "${id}" is ${approval.status}`,
        { current: approval },
      );
    }
    if (approval.author === operator.id) {
      throw new ApiProblem(
        403,
        "self_approval",
        "an approval is decided by an operator other than its author",
      );
    }
    if (doc.revision !== revision)
      throw conflict(`approval "${id}" changed`, approval);
    let result: unknown;
    let status: ApprovalDto["status"] = approve ? "approved" : "rejected";
    if (approve && approval.status === "pending") {
      try {
        result = await this.#carryOut(body.payload, approval);
      } catch (error) {
        if (error instanceof ApiProblem && error.status === 409) {
          status = "stale";
        } else {
          throw error;
        }
      }
    }
    const decided: ApprovalBody = {
      ...body,
      status,
      decidedBy: operator.id,
      decidedAt: this.options.now(),
      reason: reason ?? null,
    };
    const written = await this.store.put("approval", id, decided, revision);
    if (!written.ok) throw conflict(`approval "${id}" changed`, approval);
    const out = this.#approval((await this.store.get("approval", id))!);
    this.#emit("approval.decided", out.scope, {
      id,
      status: out.status,
      decidedBy: operator.id,
    });
    if (status === "stale") {
      throw new ApiProblem(
        409,
        "conflict",
        "the change no longer applies: what it was based on moved",
        {
          current: out,
        },
      );
    }
    return { approval: out, ...(result === undefined ? {} : { result }) };
  }

  /** Carries out an approved payload, as `approver`. */
  async #carryOut(
    payload: ApprovalPayload,
    approval: ApprovalDto,
  ): Promise<unknown> {
    const author: Operator = { id: approval.author };
    switch (payload.kind) {
      case "publish": {
        const outcome = await this.publish(
          payload.scope,
          payload.policy,
          { expectedHead: payload.expectedHead, message: payload.message },
          author,
          { approved: approval },
        );
        // Checked again here: a head moved since the approval opened is stale.
        return outcome.kind === "published" ? outcome.result : undefined;
      }
      case "roleBinding.create":
        return await this.createBinding(payload.input, author);
      case "roleBinding.delete":
        await this.deleteBinding(payload.id, payload.revision);
        return undefined;
      case "serviceIdentity.put":
        return await this.putIdentity(
          payload.id,
          payload.input,
          payload.revision,
        );
      case "serviceIdentity.delete":
        await this.deleteIdentity(payload.id, payload.revision);
        return undefined;
    }
  }

  // ── Role bindings ────────────────────────────────────────────────────────

  /** A stored binding as its DTO. */
  #binding(doc: StoredDoc): RoleBindingDto {
    const body = doc.doc as BindingBody;
    return { id: doc.id, ...body, revision: doc.revision };
  }

  /** A page of bindings. */
  async listBindings(
    limit: number,
    cursor?: string,
  ): Promise<{ items: RoleBindingDto[]; next?: string }> {
    const page = await this.#page("roleBinding", {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return {
      items: page.items.map((doc) => this.#binding(doc)),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  /** Binds a role. */
  async #createBindingNow(
    input: RoleBindingInput,
    operator: Operator,
    id: string,
  ): Promise<RoleBindingDto> {
    if (!SECURITY_ROLES.includes(input.role)) {
      throw new ApiProblem(
        400,
        "invalid_request",
        `"${String(input.role)}" is not a role`,
      );
    }
    await this.checkScope(input.scope);
    const body: BindingBody = {
      operator: input.operator,
      role: input.role,
      scope: input.scope,
      createdBy: operator.id,
      createdAt: this.options.now(),
    };
    await this.store.put("roleBinding", id, body, null);
    this.#accessChanged();
    return this.#binding((await this.store.get("roleBinding", id))!);
  }

  /** Removes a binding at `revision`. */
  async #deleteBindingNow(id: string, revision: number): Promise<void> {
    if (!(await this.store.delete("roleBinding", id, revision))) {
      const current = await this.store.get("roleBinding", id);
      if (current === undefined) throw notFound(`role binding "${id}"`);
      throw conflict(`role binding "${id}" changed`, this.#binding(current));
    }
    this.#accessChanged();
  }

  /**
   * Listens for changes that may change an operator's access (a role
   * binding created or deleted): the live hub re-checks its subscriptions.
   * Answers the unsubscribe.
   */
  onAccessChanged(listener: () => void): () => void {
    this.#accessListeners.add(listener);
    return () => this.#accessListeners.delete(listener);
  }

  /** Tells the access listeners; one that throws does not stop the others. */
  #accessChanged(): void {
    for (const listener of [...this.#accessListeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** The roles `operatorId` holds, from configuration and bindings. */
  async rolesOf(
    operatorId: string,
  ): Promise<
    { role: SecurityRole; scope: PolicyScopeId; source: "binding" | "owners" }[]
  > {
    const out: {
      role: SecurityRole;
      scope: PolicyScopeId;
      source: "binding" | "owners";
    }[] = [];
    if (this.options.owners.has(operatorId))
      out.push({ role: "owner", scope: "global", source: "owners" });
    for (const doc of await this.#all("roleBinding")) {
      const body = doc.doc as BindingBody;
      if (body.operator === operatorId)
        out.push({ role: body.role, scope: body.scope, source: "binding" });
    }
    return out;
  }

  /** The scopes that cover `scope`: itself and every scope above it. */
  async #covering(scope: PolicyScopeId): Promise<PolicyScopeId[]> {
    const parsed = parseScope(scope);
    if (parsed === undefined || parsed.kind === "global") return ["global"];
    if (parsed.kind === "group") {
      return [
        "global",
        ...(await this.groupChain(parsed.id).catch(() => [parsed.id])).map(
          groupScope,
        ),
      ];
    }
    return [
      "global",
      ...(await this.#groupScopesOf(parsed.id).catch(() => [])),
      scope,
    ];
  }

  /**
   * Whether `operator` may use `permission` on `scope`: the host's
   * `authorize`, or a built-in role bound on the scope or above it.
   */
  async can(
    operator: Operator,
    permission: SecurityApiPermission,
    scope: PolicyScopeId,
  ): Promise<boolean> {
    // A break-glass session acts as owner on global (Q11), whatever model is in use.
    if (breakGlassOperators.has(operator)) return true;
    if (this.options.authorize !== undefined) {
      return (
        (await this.options.authorize(operator, permission, { scope })) === true
      );
    }
    const covering = await this.#covering(scope);
    for (const held of await this.rolesOf(operator.id)) {
      if (!covering.includes(held.scope)) continue;
      const upTo = SECURITY_ROLES.indexOf(held.role);
      if (
        SECURITY_ROLES.slice(0, upTo + 1).some((role) =>
          ROLE_PERMISSIONS[role].includes(permission),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  // ── For the control plane's own modules (agents, bans: PR-CP4) ────────────

  /** Runs a change between its audit intent and done (see `#audited`). */
  async audited<T>(
    intent: AuditIntentInput,
    run: () => Promise<T>,
    done: (result: T) => JsonObject = () => ({}),
  ): Promise<T> {
    return await this.#audited(intent, run, done);
  }

  /** The scopes whose bans and policies reach a service: `global`, its groups (each with its ancestors), itself. */
  async scopesAbove(serviceId: string): Promise<PolicyScopeId[]> {
    return [
      "global",
      ...(await this.#groupScopesOf(serviceId)),
      serviceScope(serviceId),
    ];
  }

  // ── Bans (storage.md §3.1, PR-CP4) ───────────────────────────────────────

  /** Tells the live hub (CP5) of a ban written or lifted; a hook that throws is logged. */
  #publishBan(ban: BanRecord): void {
    try {
      liveHooksOf(this).publishBan(ban);
    } catch (error) {
      this.#logger.error("bun-security: the live hub's ban hook threw", {
        error,
      });
    }
  }

  /** A ban as the API answers it. */
  banDto(ban: BanRecord): BanDto {
    return {
      id: ban.id,
      scope: ban.scope,
      subject: ban.subject,
      action: ban.action,
      reason: ban.reason,
      source: ban.source,
      createdAt: ban.createdAt,
      expiresAt: ban.expiresAt,
      ...(ban.createdBy === undefined ? {} : { createdBy: ban.createdBy }),
      ...(ban.rule === undefined ? {} : { rule: ban.rule }),
      count: ban.count,
      liftedAt: ban.liftedAt,
      ...(ban.liftedBy === undefined ? {} : { liftedBy: ban.liftedBy }),
      active:
        ban.liftedAt === null &&
        (ban.expiresAt === null || ban.expiresAt > this.options.now()),
      revision: ban.revision,
    };
  }

  /** Writes a manual ban (merged with the scope's record of the subject). Audited. */
  async createBan(input: BanCreateInput, operator: Operator): Promise<BanDto> {
    const scope = input.scope ?? "global";
    await this.checkScope(scope);
    const given = (["ip", "user", "apiKey"] as const).filter(
      (key) => input[key] !== undefined,
    );
    const only = given[0];
    if (given.length !== 1 || only === undefined) {
      throw new ApiProblem(
        400,
        "invalid_request",
        "a ban names exactly one of ip, user, apiKey",
      );
    }
    const value = input[only]!;
    let subject: StoredBanSubject;
    if (only === "ip") {
      if (parseAddress(value) !== null) subject = { type: "ip", value };
      else if (parseCidr(value) !== null && !isWholeFamilyRange(value)) {
        subject = { type: "cidr", value: parseCidr(value)!.text };
      } else {
        throw new ApiProblem(
          400,
          "invalid_request",
          `"${value}" is not an address or a CIDR range narrower than a whole family`,
        );
      }
    } else {
      // Keyed as the engines key it: the id itself is never stored or sent.
      const keys = this.options.banKeys;
      if (keys === undefined || !this.options.banKinds[only]) {
        throw new ApiProblem(
          400,
          "invalid_request",
          only === "apiKey"
            ? "this control plane takes no API-key bans (bans.apiKeys: false)"
            : "this control plane takes no user bans (bans.users: false)",
        );
      }
      subject = {
        type: only,
        value:
          only === "apiKey"
            ? keys.apiKey(boundKey(value))
            : keys.user(boundKey(value)),
      };
    }
    let expiresAt: number | null = null;
    if (input.duration !== null) {
      try {
        expiresAt =
          this.options.now() +
          toDurationMs(input.duration ?? "24h", "a ban's duration");
      } catch (error) {
        throw new ApiProblem(
          400,
          "invalid_request",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const record: BanInputRecord = {
      scope,
      subject,
      action: input.action ?? "ban",
      reason: input.reason,
      source: "manual",
      expiresAt,
      createdBy: operator.id,
    };
    const id = banId(scope, subject);
    const before = await this.store.getBan(id);
    const ban = await this.#audited(
      {
        action: "ban.create",
        scope,
        target: { kind: "ban", id, revision: (before?.revision ?? 0) + 1 },
        ...(before === undefined ? {} : { before: this.banDto(before) }),
        after: {
          subject,
          action: record.action,
          reason: record.reason,
          expiresAt,
        },
      },
      async () => await this.store.upsertBan(record),
      (written) => ({ revision: written.revision, count: written.count }),
    );
    this.#emit("ban.changed", scope, { id, op: "ban" });
    this.#publishBan(ban);
    // What the operator typed is shown in this answer only, never stored.
    return {
      ...this.banDto(ban),
      ...(only === "ip" ? {} : { entered: { [only]: value } }),
    };
  }

  /** Lifts a ban. Audited. */
  async liftBan(id: string, operator: Operator): Promise<BanDto> {
    const before = await this.store.getBan(id);
    if (before === undefined) throw notFound(`ban "${id}"`);
    await this.#audited(
      {
        action: "ban.lift",
        scope: before.scope,
        target: { kind: "ban", id, deleted: true },
        before: this.banDto(before),
      },
      async () => {
        if (!(await this.store.liftBan(id, operator.id, this.options.now()))) {
          throw new ApiProblem(409, "conflict", `ban "${id}" is not in force`);
        }
      },
    );
    this.#emit("ban.changed", before.scope, { id, op: "lift" });
    const lifted = (await this.store.getBan(id))!;
    this.#publishBan(lifted);
    return this.banDto(lifted);
  }

  /** A page of bans, by scope (and what is under it) and state. */
  async listBans(query: {
    limit: number;
    cursor?: string;
    scope?: PolicyScopeId;
    active?: boolean;
  }): Promise<{ items: BanDto[]; next?: string }> {
    const scopes =
      query.scope === undefined
        ? undefined
        : await this.auditScopesUnder(query.scope);
    let page;
    try {
      page = await this.store.listBans({
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(scopes === undefined ? {} : { scopes }),
        ...(query.active === undefined ? {} : { active: query.active }),
      });
    } catch (error) {
      if (error instanceof ConfigError)
        throw new ApiProblem(400, "invalid_request", error.message);
      throw error;
    }
    return {
      items: page.items.map((ban) => this.banDto(ban)),
      ...(page.next === undefined ? {} : { next: page.next }),
    };
  }

  // ── The audit log (PR-CP3) ───────────────────────────────────────────────

  /** A page of the audit log, each intent with its status. */
  async auditPage(
    query: AuditQuery,
  ): Promise<{ items: AuditEntryDto[]; next?: string }> {
    let page;
    try {
      page = await this.store.listAudit(query);
    } catch (error) {
      if (error instanceof ConfigError)
        throw new ApiProblem(400, "invalid_request", error.message);
      throw error;
    }
    return {
      items: await this.audit.describe(page.items),
      ...(page.next === undefined ? {} : { next: page.next }),
    };
  }

  /**
   * The scopes `/audit?scope=` reads, as role bindings cover them: `global`
   * is everything (`undefined`); a group is itself, its descendant groups
   * and every service in any of them; a service is itself.
   */
  async auditScopesUnder(scope: PolicyScopeId): Promise<string[] | undefined> {
    const parsed = parseScope(scope);
    if (parsed === undefined) {
      throw new ApiProblem(400, "invalid_request", `"${scope}" is not a scope`);
    }
    if (parsed.kind === "global") return undefined;
    if (parsed.kind === "service") return [scope];
    const groups = await this.#all("group");
    const under = new Set([parsed.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const doc of groups) {
        const parent = (doc.doc as GroupBody).parent;
        if (parent !== null && under.has(parent) && !under.has(doc.id)) {
          under.add(doc.id);
          grew = true;
        }
      }
    }
    const scopes = [...under].map((id) => groupScope(id));
    for (const doc of await this.#all("service")) {
      if ((doc.doc as ServiceBody).groups.some((group) => under.has(group))) {
        scopes.push(serviceScope(doc.id));
      }
    }
    if (scopes.length > MAX_AUDIT_SCOPES) {
      throw new ApiProblem(
        400,
        "invalid_request",
        `${scope} covers more than ${MAX_AUDIT_SCOPES} scopes; read a narrower one`,
      );
    }
    return scopes;
  }

  /** One entry. */
  async auditEntry(n: number): Promise<AuditEntryDto> {
    const page = await this.store.listAudit({ limit: 1, fromN: n, toN: n });
    const record = page.items[0];
    if (record === undefined) throw notFound(`audit entry ${n}`);
    return (await this.audit.describe([record]))[0];
  }

  // ── Audited changes (PR-CP3) ─────────────────────────────────────────────

  /** Creates (`revision` absent) or updates a service; its bundle is recompiled. Audited. */
  async putService(
    id: string,
    input: ServiceInput,
    create: boolean,
  ): Promise<ServiceDto> {
    return await this.#audited(
      {
        action: "service.put",
        scope: serviceScope(id),
        target: {
          kind: "service",
          id,
          revision: create ? 1 : (input.revision ?? 0) + 1,
        },
        before: await this.#before("service", id),
        after: input,
      },
      async () => await this.#putServiceNow(id, input, create),
      (service) => ({ revision: service.revision }),
    );
  }

  /** Deletes a service at `revision`. Audited. */
  async deleteService(id: string, revision: number): Promise<void> {
    await this.#audited(
      {
        action: "service.delete",
        scope: serviceScope(id),
        target: { kind: "service", id, deleted: true },
        before: await this.#before("service", id),
      },
      async () => await this.#deleteServiceNow(id, revision),
    );
  }

  /** Creates or updates a group; every service under it is recompiled. Audited. */
  async putGroup(
    id: string,
    input: GroupInput,
    create: boolean,
  ): Promise<GroupDto> {
    return await this.#audited(
      {
        action: "group.put",
        scope: groupScope(id),
        target: {
          kind: "group",
          id,
          revision: create ? 1 : (input.revision ?? 0) + 1,
        },
        before: await this.#before("group", id),
        after: input,
      },
      async () => await this.#putGroupNow(id, input, create),
      (group) => ({ revision: group.revision }),
    );
  }

  /** Deletes an empty group at `revision`. Audited. */
  async deleteGroup(id: string, revision: number): Promise<void> {
    await this.#audited(
      {
        action: "group.delete",
        scope: groupScope(id),
        target: { kind: "group", id, deleted: true },
        before: await this.#before("group", id),
      },
      async () => await this.#deleteGroupNow(id, revision),
    );
  }

  /** Creates (`revision` null) or updates a service identity. Audited. */
  async putIdentity(
    id: string,
    input: ServiceIdentityInput,
    revision: number | null,
  ): Promise<ServiceIdentityDto> {
    return await this.#audited(
      {
        action: "serviceIdentity.put",
        scope: "global",
        target: { kind: "serviceIdentity", id, revision: (revision ?? 0) + 1 },
        before: await this.#before("serviceIdentity", id),
        after: input,
      },
      async () => await this.#putIdentityNow(id, input, revision),
      (identity) => ({ revision: identity.revision }),
    );
  }

  /** Deletes a service identity at `revision`. Audited. */
  async deleteIdentity(id: string, revision: number): Promise<void> {
    await this.#audited(
      {
        action: "serviceIdentity.delete",
        scope: "global",
        target: { kind: "serviceIdentity", id, deleted: true },
        before: await this.#before("serviceIdentity", id),
      },
      async () => await this.#deleteIdentityNow(id, revision),
    );
  }

  /** Saves a scope's draft at `revision`. Audited, as a diff from the previous draft. */
  async putDraft(
    scope: PolicyScopeId,
    policy: JsonObject,
    revision: number | null,
    operator: Operator,
  ): Promise<PolicyDraftDto> {
    const previous =
      (
        (await this.#before("policyDraft", scope)) as
          { policy?: JsonObject } | undefined
      )?.policy ?? {};
    return await this.#audited(
      {
        action: "policy.draft",
        scope,
        target: {
          kind: "policyDraft",
          id: scope,
          revision: (revision ?? 0) + 1,
        },
        after: { diff: diffPolicies(previous, policy) },
      },
      async () => await this.#putDraftNow(scope, policy, revision, operator),
      (draft) => ({ revision: draft.revision }),
    );
  }

  /** Publishes `policy` at `scope` (see the core's description). Audited, as a diff from the head. */
  async publish(
    scope: PolicyScopeId,
    policy: JsonObject,
    request: PublishRequest,
    operator: Operator,
    context: {
      readonly approved?: ApprovalDto;
      readonly forceApproval?: boolean;
    } = {},
  ): Promise<PublishOutcome> {
    const versionId = newId("pv");
    const head =
      parseScope(scope) === undefined
        ? { policy: {} }
        : await this.#headPolicy(scope).catch(() => ({ policy: {} }));
    return await this.#audited(
      {
        action: request.action ?? "policy.publish",
        scope,
        target: { kind: "version", id: versionId, scope },
        after: { diff: diffPolicies(head.policy, policy) },
        extra: {
          expectedHead: request.expectedHead,
          ...(request.message === undefined
            ? {}
            : { message: request.message }),
          ...(request.emergency === true ? { emergency: true } : {}),
          ...(context.approved === undefined
            ? {}
            : { approvalId: context.approved.id }),
        },
      },
      async () =>
        await this.#publishNow(scope, policy, request, operator, {
          ...context,
          versionId,
        }),
      (outcome) =>
        outcome.kind === "published"
          ? {
              version: outcome.result.version.id,
              bundles: outcome.result.bundles,
              ...(outcome.result.review === undefined
                ? {}
                : { review: outcome.result.review.id }),
            }
          : { approval: outcome.approval.id },
    );
  }

  /** Opens an approval. Audited. */
  async #openApproval(
    input: Omit<
      ApprovalBody,
      "createdAt" | "expiresAt" | "decidedBy" | "decidedAt" | "reason"
    >,
  ): Promise<ApprovalDto> {
    const id = newId("ap");
    return await this.#audited(
      {
        action: "approval.open",
        scope: input.scope,
        target: { kind: "approval", id, revision: 1 },
        after: {
          action: input.action,
          status: input.status,
          dangerous: input.dangerous,
          summary: input.summary,
        },
      },
      async () => await this.#openApprovalNow(input, id),
      (approval) => ({ approvalId: approval.id }),
    );
  }

  /** Opens an approval for a guarded change (no step-up hook). Audited. */
  async requestApproval(
    action: ApprovalDto["action"],
    scope: PolicyScopeId,
    operator: Operator,
    payload: ApprovalPayload,
    summary: JsonObject,
  ): Promise<ApprovalDto> {
    return await this.#requestApprovalNow(
      action,
      scope,
      operator,
      payload,
      summary,
    );
  }

  /** Decides an approval. Audited. */
  async decide(
    id: string,
    revision: number,
    approve: boolean,
    reason: string | undefined,
    operator: Operator,
  ): Promise<{ approval: ApprovalDto; result?: unknown }> {
    const approval = await this.store.get("approval", id);
    return await this.#audited(
      {
        action: approve ? "approval.approve" : "approval.reject",
        scope: (approval?.doc as ApprovalBody | undefined)?.scope ?? "global",
        target: { kind: "approval", id, revision: revision + 1 },
        extra: { approvalId: id, ...(reason === undefined ? {} : { reason }) },
      },
      async () =>
        await this.#decideNow(id, revision, approve, reason, operator),
      (decided) => ({ status: decided.approval.status }),
    );
  }

  /** Binds a role. Audited. */
  async createBinding(
    input: RoleBindingInput,
    operator: Operator,
  ): Promise<RoleBindingDto> {
    const id = newId("rb");
    return await this.#audited(
      {
        action: "roleBinding.create",
        scope: input.scope,
        target: { kind: "roleBinding", id, revision: 1 },
        after: input,
      },
      async () => await this.#createBindingNow(input, operator, id),
      (binding) => ({ bindingId: binding.id }),
    );
  }

  /** Removes a binding at `revision`. Audited. */
  async deleteBinding(id: string, revision: number): Promise<void> {
    const before = await this.#before("roleBinding", id);
    await this.#audited(
      {
        action: "roleBinding.delete",
        scope: (before as { scope?: string } | undefined)?.scope ?? "global",
        target: { kind: "roleBinding", id, deleted: true },
        before,
      },
      async () => await this.#deleteBindingNow(id, revision),
    );
  }
}
