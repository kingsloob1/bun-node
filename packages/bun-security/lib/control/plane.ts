/**
 * The control plane's logic, apart from HTTP (control-plane.md §2–§5):
 * services, groups, service identities, drafts, publishing with
 * inheritance, bundles, approvals and role bindings, over a security
 * store. The routes (`./routes`) call it; nothing here reads a request.
 */
import { randomUUID } from "node:crypto";
import type {
  ListQuery,
  Page,
  PolicyVersionRecord,
  StoredDoc,
} from "../store/types";
import { ConfigError } from "@kingsleyweb/bun-common";
import type { SecurityApiPermission, SecurityRole } from "./contract/constants";
import type {
  ApprovalDto,
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
import { mergePolicies } from "./merge";
import { ApiProblem, conflict, notFound } from "./problems";
import { ENTITY_ID, groupScope, parseScope, serviceScope } from "./scopes";
import { signBundle } from "./signing";

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

  /**
   * @param options The API's resolved options.
   */
  constructor(private readonly options: ResolvedSecurityApiOptions) {}

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
  async putService(
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
  async deleteService(id: string, revision: number): Promise<void> {
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
  async putGroup(
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
  async deleteGroup(id: string, revision: number): Promise<void> {
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
  async putIdentity(
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
  async deleteIdentity(id: string, revision: number): Promise<void> {
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
  async putDraft(
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
    const id = newId("pv");
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
  async #openApproval(
    input: Omit<
      ApprovalBody,
      "createdAt" | "expiresAt" | "decidedBy" | "decidedAt" | "reason"
    >,
  ): Promise<ApprovalDto> {
    const now = this.options.now();
    const id = newId("ap");
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
  async requestApproval(
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
  async decide(
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
  async createBinding(
    input: RoleBindingInput,
    operator: Operator,
  ): Promise<RoleBindingDto> {
    if (!SECURITY_ROLES.includes(input.role)) {
      throw new ApiProblem(
        400,
        "invalid_request",
        `"${String(input.role)}" is not a role`,
      );
    }
    await this.checkScope(input.scope);
    const id = newId("rb");
    const body: BindingBody = {
      operator: input.operator,
      role: input.role,
      scope: input.scope,
      createdBy: operator.id,
      createdAt: this.options.now(),
    };
    await this.store.put("roleBinding", id, body, null);
    return this.#binding((await this.store.get("roleBinding", id))!);
  }

  /** Removes a binding at `revision`. */
  async deleteBinding(id: string, revision: number): Promise<void> {
    if (!(await this.store.delete("roleBinding", id, revision))) {
      const current = await this.store.get("roleBinding", id);
      if (current === undefined) throw notFound(`role binding "${id}"`);
      throw conflict(`role binding "${id}" changed`, this.#binding(current));
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
}
