/**
 * The management API's routes (control-plane.md §4): meta and permissions,
 * services, groups, service identities, policies and their versions,
 * publishing and rollback, effective policies and bundles, approvals, role
 * bindings, and the live stream.
 */
import type { RouteSpec } from "./route";
import type {
  ApprovalDto,
  PolicyScopeId,
  SecurityLiveEventDto,
} from "./contract/types";
import type { Operator, ResolvedSecurityApiOptions } from "./options";
import type { ControlPlane, PublishOutcome } from "./plane";
import type { Infer, Schema } from "./schema";
import { sse } from "@kingsleyweb/bun-common";
import {
  DEFAULT_API_PAGE_LIMIT,
  SECURITY_API_PERMISSIONS,
  SECURITY_API_PROTOCOL_VERSION,
} from "./contract/constants";
import { diffPolicies } from "./merge";
import { ApiProblem } from "./problems";
import * as S from "./schemas";
import { s } from "./schema";
import { serviceScope } from "./scopes";

/** A route of any shape, for the list. */
type AnyRoute = RouteSpec<any, any, any>;

/** The query of a list. */
interface PageQueryOf {
  /** The page size. */
  readonly limit?: number;
  /** The previous page's next. */
  readonly cursor?: string;
}

/** A page's answer. */
const pageOf = <T>(found: { items: T[]; next?: string }) => ({
  status: 200,
  body: {
    items: found.items,
    ...(found.next === undefined ? {} : { next: found.next }),
  },
});

/** The answer of a publish: `200` published, `202` an approval opened. */
function published(outcome: PublishOutcome) {
  return outcome.kind === "published"
    ? { status: 200, body: outcome.result }
    : { status: 202, body: outcome.approval };
}

/** The live events' data schemas. */
const LiveEvent: Schema<SecurityLiveEventDto> = s.object({
  event: s.enum([
    "policy.published",
    "bundle.compiled",
    "approval.created",
    "approval.decided",
  ]),
  scope: s.string(),
  data: s.anyObject("what happened"),
  at: s.int({ min: 0 }),
});

/** The live stream's events, for its contract and the AsyncAPI document. */
export const LIVE_EVENTS = sse({
  "policy.published": LiveEvent,
  "bundle.compiled": LiveEvent,
  "approval.created": LiveEvent,
  "approval.decided": LiveEvent,
});

/** Every route. */
export function routes(options: ResolvedSecurityApiOptions): AnyRoute[] {
  /** A publish or rollback through the step-up and approvals rules. */
  const publishWith = async (
    plane: ControlPlane,
    operator: Operator,
    stepUp: () => Promise<boolean>,
    scope: PolicyScopeId,
    policy: Record<string, unknown>,
    request: Parameters<ControlPlane["publish"]>[2],
  ) => {
    const now = await stepUp();
    return published(
      await plane.publish(scope, policy, request, operator, {
        forceApproval: !now,
      }),
    );
  };

  /** A step-up-guarded change: done now, or (no hook, two-person approvals) opened as an approval. */
  const guarded = async (
    stepUp: () => Promise<boolean>,
    run: () => Promise<{ status: number; body?: unknown }>,
    open: () => Promise<ApprovalDto>,
  ) => ((await stepUp()) ? await run() : { status: 202, body: await open() });

  return [
    // ── Meta ──────────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/meta",
      summary:
        "What the API is: its version, CSRF header, step-up and approvals modes, signing key",
      tag: "meta",
      responses: { 200: S.Meta },
      handle: async ({ plane }) => ({
        status: 200,
        body: {
          protocolVersion: SECURITY_API_PROTOCOL_VERSION,
          basePath: options.basePath,
          csrfHeader: options.csrf === false ? null : options.csrf.header,
          stepUp: options.guard,
          approvals: options.approvals,
          signingKeyId: options.signer.keyId,
          builtInRbac: options.authorize === undefined,
          store: {
            name: plane.store.name,
            durable: plane.store.capabilities.durable,
          },
        },
      }),
    },
    {
      method: "get",
      path: "/meta/permissions",
      summary:
        "What the caller may do on a scope (an element the operator may not use is absent)",
      tag: "meta",
      query: S.PermissionsQuery,
      responses: { 200: S.Permissions },
      problems: [404],
      handle: async ({ plane, operator, query }) => {
        const scope = (query as { scope?: string }).scope ?? "global";
        await plane.checkScope(scope);
        const permissions = Object.fromEntries(
          await Promise.all(
            SECURITY_API_PERMISSIONS.map(
              async (name) =>
                [name, await plane.can(operator, name, scope)] as const,
            ),
          ),
        );
        return { status: 200, body: { scope, permissions } };
      },
    },
    {
      method: "get",
      path: "/operators/me",
      summary: "The calling operator and their roles",
      tag: "roles",
      responses: { 200: S.Me },
      handle: async ({ plane, operator }) => ({
        status: 200,
        body: {
          id: operator.id,
          name: operator.name ?? null,
          roles:
            options.authorize === undefined
              ? await plane.rolesOf(operator.id)
              : [],
        },
      }),
    },

    // ── Services ──────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/services",
      summary: "The services, a page at a time",
      tag: "services",
      query: S.PageQuery,
      responses: { 200: S.Services },
      handle: async ({ plane, require, query }) => {
        await require("services:read", "global");
        const q = query as PageQueryOf;
        return pageOf(
          await plane.listServices(q.limit ?? DEFAULT_API_PAGE_LIMIT, q.cursor),
        );
      },
    },
    {
      method: "post",
      path: "/services",
      summary: "Creates a service",
      tag: "services",
      body: S.ServiceBody,
      responses: { 201: S.Service },
      problems: [404, 409, 422],
      handle: async ({ plane, require, body }) => {
        const input = body as Infer<typeof S.ServiceBody>;
        if (input.id === undefined)
          throw new ApiProblem(
            400,
            "invalid_request",
            "a new service needs an id",
          );
        await require("services:write", "global");
        return {
          status: 201,
          body: await plane.putService(input.id, input, true),
        };
      },
    },
    {
      method: "get",
      path: "/services/:id",
      summary: "One service",
      tag: "services",
      params: S.IdParams,
      responses: { 200: S.Service },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        const { id } = params as { id: string };
        await require("services:read", serviceScope(id));
        return { status: 200, body: await plane.getService(id) };
      },
    },
    {
      method: "put",
      path: "/services/:id",
      summary: "Updates a service at the revision read (a stale one is a 409)",
      tag: "services",
      params: S.IdParams,
      body: S.ServiceBody,
      responses: { 200: S.Service },
      problems: [404, 409, 422],
      handle: async ({ plane, require, params, body }) => {
        const { id } = params as { id: string };
        const input = body as Infer<typeof S.ServiceBody>;
        await require("services:write", serviceScope(id));
        if (input.revision === undefined)
          throw new ApiProblem(
            400,
            "invalid_request",
            "an update needs the revision read",
          );
        return { status: 200, body: await plane.putService(id, input, false) };
      },
    },
    {
      method: "delete",
      path: "/services/:id",
      summary: "Deletes a service at the revision read",
      tag: "services",
      params: S.IdParams,
      query: S.RevisionQuery,
      responses: { 204: null },
      problems: [404, 409],
      handle: async ({ plane, require, params, query }) => {
        const { id } = params as { id: string };
        await require("services:write", serviceScope(id));
        await plane.deleteService(id, (query as { revision: number }).revision);
        return { status: 204 };
      },
    },
    {
      method: "get",
      path: "/services/:id/effective",
      summary:
        "A service's effective policy: its scopes merged, each field with its origin",
      tag: "policies",
      params: S.IdParams,
      responses: { 200: S.Effective },
      problems: [404, 422],
      handle: async ({ plane, require, params }) => {
        const { id } = params as { id: string };
        await require("policy:read", serviceScope(id));
        await plane.getService(id);
        return { status: 200, body: await plane.effective(id) };
      },
    },
    {
      method: "get",
      path: "/services/:id/bundle",
      summary: "A service's signed bundle (If-None-Match answers 304)",
      tag: "policies",
      params: S.IdParams,
      responses: { 200: S.Bundle, 304: null },
      problems: [404],
      handle: async ({ plane, require, params, req }) => {
        const { id } = params as { id: string };
        await require("bundles:read", serviceScope(id));
        const found = await plane.store.getBundle(
          id,
          req.request.headers.get("if-none-match") ?? undefined,
        );
        if (found === undefined)
          throw new ApiProblem(
            404,
            "not_found",
            `service "${id}" has no bundle`,
          );
        if (found === "not-modified") return { status: 304 };
        return {
          status: 200,
          body: found.bundle,
          headers: { etag: found.etag },
        };
      },
    },

    // ── Groups ────────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/groups",
      summary: "The groups, a page at a time",
      tag: "groups",
      query: S.PageQuery,
      responses: { 200: S.Groups },
      handle: async ({ plane, require, query }) => {
        await require("groups:read", "global");
        const q = query as PageQueryOf;
        return pageOf(
          await plane.listGroups(q.limit ?? DEFAULT_API_PAGE_LIMIT, q.cursor),
        );
      },
    },
    {
      method: "post",
      path: "/groups",
      summary: "Creates a group (nesting at most 4 deep)",
      tag: "groups",
      body: S.GroupBody,
      responses: { 201: S.Group },
      problems: [404, 409, 422],
      handle: async ({ plane, require, body }) => {
        const input = body as Infer<typeof S.GroupBody>;
        if (input.id === undefined)
          throw new ApiProblem(
            400,
            "invalid_request",
            "a new group needs an id",
          );
        await require("groups:write", "global");
        return {
          status: 201,
          body: await plane.putGroup(input.id, input, true),
        };
      },
    },
    {
      method: "get",
      path: "/groups/:id",
      summary: "One group",
      tag: "groups",
      params: S.IdParams,
      responses: { 200: S.Group },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        const { id } = params as { id: string };
        await require("groups:read", `group:${id}`);
        return { status: 200, body: await plane.getGroup(id) };
      },
    },
    {
      method: "put",
      path: "/groups/:id",
      summary: "Updates a group at the revision read",
      tag: "groups",
      params: S.IdParams,
      body: S.GroupBody,
      responses: { 200: S.Group },
      problems: [404, 409, 422],
      handle: async ({ plane, require, params, body }) => {
        const { id } = params as { id: string };
        const input = body as Infer<typeof S.GroupBody>;
        await require("groups:write", `group:${id}`);
        if (input.revision === undefined)
          throw new ApiProblem(
            400,
            "invalid_request",
            "an update needs the revision read",
          );
        return { status: 200, body: await plane.putGroup(id, input, false) };
      },
    },
    {
      method: "delete",
      path: "/groups/:id",
      summary: "Deletes an empty group at the revision read",
      tag: "groups",
      params: S.IdParams,
      query: S.RevisionQuery,
      responses: { 204: null },
      problems: [404, 409],
      handle: async ({ plane, require, params, query }) => {
        const { id } = params as { id: string };
        await require("groups:write", `group:${id}`);
        await plane.deleteGroup(id, (query as { revision: number }).revision);
        return { status: 204 };
      },
    },

    // ── Service identities ────────────────────────────────────────────────
    {
      method: "get",
      path: "/service-identities",
      summary: "The sibling services' identities, a page at a time",
      tag: "identities",
      query: S.PageQuery,
      responses: { 200: S.Identities },
      handle: async ({ plane, require, query }) => {
        await require("identities:read", "global");
        const q = query as PageQueryOf;
        return pageOf(
          await plane.listIdentities(
            q.limit ?? DEFAULT_API_PAGE_LIMIT,
            q.cursor,
          ),
        );
      },
    },
    {
      method: "get",
      path: "/service-identities/:id",
      summary: "One service identity",
      tag: "identities",
      params: S.IdParams,
      responses: { 200: S.Identity },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        await require("identities:read", "global");
        return {
          status: 200,
          body: await plane.getIdentity((params as { id: string }).id),
        };
      },
    },
    {
      method: "post",
      path: "/service-identities",
      summary: "Creates a service identity (a step-up, or an approval)",
      tag: "identities",
      body: S.IdentityBody,
      responses: { 201: S.Identity, 202: S.Approval },
      problems: [409, 422],
      handle: async ({ plane, require, body, stepUp, operator }) => {
        const input = body as Infer<typeof S.IdentityBody>;
        if (input.id === undefined)
          throw new ApiProblem(
            400,
            "invalid_request",
            "a new identity needs an id",
          );
        await require("identities:write", "global");
        const id = input.id;
        return await guarded(
          stepUp,
          async () => ({
            status: 201,
            body: await plane.putIdentity(id, input, null),
          }),
          async () =>
            await plane.requestApproval(
              "serviceIdentity.put",
              "global",
              operator,
              {
                kind: "serviceIdentity.put",
                id,
                input,
                revision: null,
              },
              { identity: id },
            ),
        );
      },
    },
    {
      method: "put",
      path: "/service-identities/:id",
      summary:
        "Updates a service identity at the revision read (a step-up, or an approval)",
      tag: "identities",
      params: S.IdParams,
      body: S.IdentityBody,
      responses: { 200: S.Identity, 202: S.Approval },
      problems: [404, 409, 422],
      handle: async ({ plane, require, params, body, stepUp, operator }) => {
        const { id } = params as { id: string };
        const input = body as Infer<typeof S.IdentityBody>;
        await require("identities:write", "global");
        if (input.revision === undefined)
          throw new ApiProblem(
            400,
            "invalid_request",
            "an update needs the revision read",
          );
        const revision = input.revision;
        return await guarded(
          stepUp,
          async () => ({
            status: 200,
            body: await plane.putIdentity(id, input, revision),
          }),
          async () =>
            await plane.requestApproval(
              "serviceIdentity.put",
              "global",
              operator,
              {
                kind: "serviceIdentity.put",
                id,
                input,
                revision,
              },
              { identity: id },
            ),
        );
      },
    },
    {
      method: "delete",
      path: "/service-identities/:id",
      summary:
        "Deletes a service identity at the revision read (a step-up, or an approval)",
      tag: "identities",
      params: S.IdParams,
      query: S.RevisionQuery,
      responses: { 204: null, 202: S.Approval },
      problems: [404, 409],
      handle: async ({ plane, require, params, query, stepUp, operator }) => {
        const { id } = params as { id: string };
        const { revision } = query as { revision: number };
        await require("identities:write", "global");
        return await guarded(
          stepUp,
          async () => {
            await plane.deleteIdentity(id, revision);
            return { status: 204 };
          },
          async () =>
            await plane.requestApproval(
              "serviceIdentity.delete",
              "global",
              operator,
              {
                kind: "serviceIdentity.delete",
                id,
                revision,
              },
              { identity: id },
            ),
        );
      },
    },

    // ── Policies ──────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/policies/:scope",
      summary: "A scope's draft and published head",
      tag: "policies",
      params: S.ScopeParams,
      responses: { 200: S.Policy },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        const { scope } = params as { scope: string };
        await require("policy:read", scope);
        return { status: 200, body: await plane.getPolicy(scope) };
      },
    },
    {
      method: "put",
      path: "/policies/:scope/draft",
      summary:
        "Saves a scope's draft at the revision read (a stale one is a 409; it must compile over the scopes above)",
      tag: "policies",
      params: S.ScopeParams,
      body: S.DraftBody,
      responses: { 200: S.Draft },
      problems: [404, 409, 422],
      handle: async ({ plane, require, params, body, operator, stepUp }) => {
        const { scope } = params as { scope: string };
        const input = body as Infer<typeof S.DraftBody>;
        await require("policy:draft", scope);
        await requireStepUpWhenFlagged(plane, scope, stepUp);
        return {
          status: 200,
          body: await plane.putDraft(
            scope,
            { ...input.policy },
            input.revision,
            operator,
          ),
        };
      },
    },
    {
      method: "get",
      path: "/policies/:scope/versions",
      summary: "A scope's published versions, newest first",
      tag: "policies",
      params: S.ScopeParams,
      query: S.PageQuery,
      responses: { 200: S.Versions },
      problems: [404],
      handle: async ({ plane, require, params, query }) => {
        const { scope } = params as { scope: string };
        await require("policy:read", scope);
        const q = query as PageQueryOf;
        return pageOf(
          await plane.listVersions(
            scope,
            q.limit ?? DEFAULT_API_PAGE_LIMIT,
            q.cursor,
          ),
        );
      },
    },
    {
      method: "get",
      path: "/policies/:scope/versions/:id",
      summary: "One published version",
      tag: "policies",
      params: S.ScopeVersionParams,
      responses: { 200: S.Version },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        const { scope, id } = params as { scope: string; id: string };
        await require("policy:read", scope);
        return { status: 200, body: await plane.getVersion(scope, id) };
      },
    },
    {
      method: "get",
      path: "/policies/:scope/diff",
      summary:
        "The differences between two of a scope's policies (a version, head or draft)",
      tag: "policies",
      params: S.ScopeParams,
      query: S.DiffQuery,
      responses: { 200: S.Diff },
      problems: [404],
      handle: async ({ plane, require, params, query }) => {
        const { scope } = params as { scope: string };
        const { from = "head", to = "draft" } = query as {
          from?: string;
          to?: string;
        };
        await require("policy:read", scope);
        await plane.checkScope(scope);
        const changes = diffPolicies(
          await plane.policyAt(scope, from),
          await plane.policyAt(scope, to),
        );
        return { status: 200, body: { from, to, changes } };
      },
    },
    {
      method: "post",
      path: "/policies/:scope/publish",
      summary:
        "Publishes the scope's draft: every service under it recompiled; a dangerous change confirmed or approved",
      tag: "policies",
      params: S.ScopeParams,
      body: S.PublishBody,
      responses: { 200: S.PublishResult, 202: S.Approval },
      problems: [404, 409, 422, 428],
      handle: async ({ plane, require, params, body, operator, stepUp }) => {
        const { scope } = params as { scope: string };
        const input = body as Infer<typeof S.PublishBody>;
        await require("policy:publish", scope);
        const draft = await plane.policyAt(scope, "draft");
        return await publishWith(plane, operator, stepUp, scope, draft, {
          ...input,
          action: "policy.publish",
        });
      },
    },
    {
      method: "post",
      path: "/policies/:scope/rollback",
      summary:
        "Publishes an older version's content again, as a new version (control-plane.md §3.3)",
      tag: "policies",
      params: S.ScopeParams,
      body: S.RollbackBody,
      responses: { 200: S.PublishResult, 202: S.Approval },
      problems: [404, 409, 422, 428],
      handle: async ({ plane, require, params, body, operator, stepUp }) => {
        const { scope } = params as { scope: string };
        const input = body as Infer<typeof S.RollbackBody>;
        await require("policy:publish", scope);
        const target = await plane.getVersion(scope, input.versionId);
        return await publishWith(
          plane,
          operator,
          stepUp,
          scope,
          { ...target.policy },
          {
            expectedHead: input.expectedHead,
            message: input.message ?? `rollback to ${target.id}`,
            ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
            ...(input.emergency === undefined
              ? {}
              : { emergency: input.emergency }),
            action: "policy.rollback",
          },
        );
      },
    },

    // ── Approvals ─────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/approvals",
      summary: "Approvals, newest first",
      tag: "approvals",
      query: S.PageQuery,
      responses: { 200: S.Approvals },
      handle: async ({ plane, require, query }) => {
        await require("approvals:read", "global");
        const q = query as PageQueryOf;
        return pageOf(
          await plane.listApprovals(
            q.limit ?? DEFAULT_API_PAGE_LIMIT,
            q.cursor,
          ),
        );
      },
    },
    {
      method: "get",
      path: "/approvals/:id",
      summary: "One approval",
      tag: "approvals",
      params: S.IdParams,
      responses: { 200: S.Approval },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        const approval = await plane.getApproval((params as { id: string }).id);
        await require("approvals:read", approval.scope);
        return { status: 200, body: approval };
      },
    },
    {
      method: "post",
      path: "/approvals/:id/approve",
      summary:
        "Approves (and carries out) a change, or closes an emergency's review; never by its author",
      tag: "approvals",
      params: S.IdParams,
      body: S.DecisionBody,
      responses: { 200: S.Decision },
      problems: [404, 409],
      handle: async (context) => await decideRoute(context, true),
    },
    {
      method: "post",
      path: "/approvals/:id/reject",
      summary: "Rejects a change; never by its author",
      tag: "approvals",
      params: S.IdParams,
      body: S.DecisionBody,
      responses: { 200: S.Decision },
      problems: [404, 409],
      handle: async (context) => await decideRoute(context, false),
    },

    // ── Role bindings ─────────────────────────────────────────────────────
    {
      method: "get",
      path: "/role-bindings",
      summary: "The built-in roles' bindings",
      tag: "roles",
      query: S.PageQuery,
      responses: { 200: S.Bindings },
      handle: async ({ plane, require, query }) => {
        await require("roles:read", "global");
        const q = query as PageQueryOf;
        return pageOf(
          await plane.listBindings(q.limit ?? DEFAULT_API_PAGE_LIMIT, q.cursor),
        );
      },
    },
    {
      method: "post",
      path: "/role-bindings",
      summary:
        "Binds a role to an operator on a scope (a step-up, or an approval)",
      tag: "roles",
      body: S.BindingBody,
      responses: { 201: S.Binding, 202: S.Approval },
      problems: [404],
      handle: async ({ plane, require, body, operator, stepUp }) => {
        const input = body as Infer<typeof S.BindingBody>;
        await require("roles:write", input.scope);
        return await guarded(
          stepUp,
          async () => ({
            status: 201,
            body: await plane.createBinding(input, operator),
          }),
          async () =>
            await plane.requestApproval(
              "roleBinding.create",
              input.scope,
              operator,
              {
                kind: "roleBinding.create",
                input,
              },
              { ...input },
            ),
        );
      },
    },
    {
      method: "delete",
      path: "/role-bindings/:id",
      summary:
        "Removes a role binding at the revision read (a step-up, or an approval)",
      tag: "roles",
      params: S.IdParams,
      query: S.RevisionQuery,
      responses: { 204: null, 202: S.Approval },
      problems: [404, 409],
      handle: async ({ plane, require, params, query, operator, stepUp }) => {
        const { id } = params as { id: string };
        const { revision } = query as { revision: number };
        await require("roles:write", "global");
        return await guarded(
          stepUp,
          async () => {
            await plane.deleteBinding(id, revision);
            return { status: 204 };
          },
          async () =>
            await plane.requestApproval(
              "roleBinding.delete",
              "global",
              operator,
              {
                kind: "roleBinding.delete",
                id,
                revision,
              },
              { binding: id },
            ),
        );
      },
    },

    // ── Live ──────────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/live",
      summary:
        "Server-sent events: policies published, bundles compiled, approvals opened and decided",
      tag: "live",
      responses: { 200: { content: { "text/event-stream": LIVE_EVENTS } } },
      handle: async ({ plane, operator, res }) => {
        const stream = res.sse({ contract: LIVE_EVENTS, ids: "auto" });
        const off = plane.listen((event) => {
          void plane
            .can(operator, "policy:read", event.scope)
            .then((allowed) => {
              if (allowed)
                void stream.send({ event: event.event, data: event });
            });
        });
        stream.onClose(off);
        return undefined;
      },
    },
  ];
}

/** A draft write on a service flagged `requireStepUp` needs a step-up too, where a hook is configured. */
async function requireStepUpWhenFlagged(
  plane: ControlPlane,
  scope: PolicyScopeId,
  stepUp: () => Promise<boolean>,
): Promise<void> {
  if (!scope.startsWith("service:")) return;
  const service = await plane
    .getService(scope.slice("service:".length))
    .catch(() => undefined);
  // With a hook, a stale second factor is a 401 with its URL. Under
  // two-person approvals (no hook) the draft is saved: its publish waits
  // for a second operator anyway.
  if (service?.requireStepUp === true) await stepUp();
}

/** Approves or rejects. */
async function decideRoute(
  context: Parameters<AnyRoute["handle"]>[0],
  approve: boolean,
): Promise<{ status: number; body: unknown }> {
  const { plane, require, params, body, operator, stepUp } = context;
  const { id } = params as { id: string };
  const input = body as { revision: number; reason?: string };
  const approval = await plane.getApproval(id);
  await require(plane.permissionFor(approval), approval.scope);
  // Approving carries the change out, so it takes the step-up the change
  // would (with no hook, the approval itself is the second check).
  if (approve && approval.status === "pending") await stepUp();
  return {
    status: 200,
    body: await plane.decide(
      id,
      input.revision,
      approve,
      input.reason,
      operator,
    ),
  };
}
