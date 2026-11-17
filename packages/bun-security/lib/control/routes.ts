/**
 * The management API's routes (control-plane.md §4): meta and permissions,
 * services, groups, service identities, policies and their versions,
 * publishing and rollback, effective policies and bundles, approvals, role
 * bindings, and the live stream.
 */
import type { RouteSpec } from "./route";
import type { ApprovalDto, PolicyScopeId } from "./contract/types";
import type { Operator, ResolvedSecurityApiOptions } from "./options";
import type { ControlPlane, PublishOutcome } from "./plane";
import type { Infer } from "./schema";
import { opaque, sse } from "@kingsleyweb/bun-common";
import {
  BREAK_GLASS_HEADER,
  DEFAULT_API_PAGE_LIMIT,
  SECURITY_API_PERMISSIONS,
  SECURITY_API_PROTOCOL_VERSION,
} from "./contract/constants";
import { diffPolicies } from "./merge";
import { ApiProblem } from "./problems";
import * as A from "./analyticsSchemas";
import { analyticsRoutes } from "./analyticsRoutes";
import { LIVE_LIMITS } from "./contract/live";
import type { LiveHub } from "./live/hub";
import { parseResume } from "./live/transports";
import * as S from "./schemas";
import { serviceScope } from "./scopes";

/** A route of any shape, for the list. */
export type AnyRoute = RouteSpec<any, any, any>;

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

/** The live stream's events, for its contract and the AsyncAPI document. */
export const LIVE_EVENTS = sse({
  subscribed: A.LiveSubscribed,
  event: A.LiveEventMessage,
  overview: A.LiveOverview,
  more: A.LiveMore,
  gap: A.LiveGap,
  ban: A.LiveBan,
  "policy.published": A.LiveControl,
  "bundle.compiled": A.LiveControl,
  "approval.created": A.LiveControl,
  "approval.decided": A.LiveControl,
  "breakGlass.used": A.LiveControl,
  "ban.changed": A.LiveControl,
});

/** Every route. */
export function routes(
  options: ResolvedSecurityApiOptions,
  hub: LiveHub,
): AnyRoute[] {
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

    // ── Bans (storage.md §3.1, PR-CP4) ─────────────────────────────────────
    {
      method: "get",
      path: "/bans",
      summary:
        "Bans, a page at a time, by scope (and what is under it) and state",
      tag: "bans",
      query: S.BansQuery,
      responses: { 200: S.Bans },
      handle: async ({ plane, require, query }) => {
        const q = query as Infer<typeof S.BansQuery>;
        await require("bans:read", q.scope ?? "global");
        return pageOf(
          await plane.listBans({
            limit: q.limit ?? DEFAULT_API_PAGE_LIMIT,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            ...(q.scope === undefined ? {} : { scope: q.scope }),
            ...(q.active === undefined ? {} : { active: q.active }),
          }),
        );
      },
    },
    {
      method: "post",
      path: "/bans",
      summary:
        "Bans an address, range, user or API key on a scope, merged with its ban there; pushed to the agents under it",
      tag: "bans",
      body: S.BanCreateBody,
      responses: { 201: S.Ban },
      problems: [404],
      handle: async ({ plane, require, body, operator }) => {
        const input = body as Infer<typeof S.BanCreateBody>;
        await require("bans:write", input.scope ?? "global");
        return { status: 201, body: await plane.createBan(input, operator) };
      },
    },
    {
      method: "post",
      path: "/bans/:id/lift",
      summary:
        "Lifts a ban (its record is kept as history); pushed to the agents under it",
      tag: "bans",
      params: S.IdParams,
      responses: { 200: S.Ban },
      problems: [404, 409],
      handle: async ({ plane, require, params, operator }) => {
        const { id } = params as { id: string };
        const ban = await plane.store.getBan(id);
        if (ban === undefined)
          throw new ApiProblem(404, "not_found", `ban "${id}" not found`);
        await require("bans:write", ban.scope);
        return { status: 200, body: await plane.liftBan(id, operator) };
      },
    },

    // ── Agents (control-plane.md §7, PR-CP4) ───────────────────────────────
    ...(options.agents === undefined
      ? []
      : ([
          {
            method: "get",
            path: "/agents",
            summary:
              "Agents, a page at a time, with their health (late after 3 missed heartbeats, offline after 10)",
            tag: "agents",
            query: S.PageQuery,
            responses: { 200: S.Agents },
            handle: async ({ plane, require, query }) => {
              await require("agents:read", "global");
              const q = query as PageQueryOf;
              return pageOf(
                await plane.agents!.list(
                  q.limit ?? DEFAULT_API_PAGE_LIMIT,
                  q.cursor,
                ),
              );
            },
          },
          {
            method: "get",
            path: "/agents/:id",
            summary: "One agent and its health",
            tag: "agents",
            params: S.IdParams,
            responses: { 200: S.Agent },
            problems: [404],
            handle: async ({ plane, require, params }) => {
              await require("agents:read", "global");
              return {
                status: 200,
                body: await plane.agents!.get((params as { id: string }).id),
              };
            },
          },
          {
            method: "post",
            path: "/agents",
            summary:
              "Makes an agent's key for a service (a step-up); its secret is shown this once",
            tag: "agents",
            body: S.AgentCreateBody,
            responses: { 201: S.AgentSecret },
            problems: [404, 409],
            handle: async ({ plane, require, body, operator, stepUp }) => {
              const input = body as Infer<typeof S.AgentCreateBody>;
              await require("agents:write", serviceScope(input.service));
              await agentStepUp(stepUp);
              return {
                status: 201,
                body: await plane.agents!.create(input, operator),
              };
            },
          },
          {
            method: "post",
            path: "/agents/:id/rotate",
            summary:
              "A new secret for an agent (a step-up), shown once; the old one is accepted until the agent uses the new one, or 24 hours",
            tag: "agents",
            params: S.IdParams,
            body: S.RevisionBody,
            responses: { 200: S.AgentSecret },
            problems: [404, 409],
            handle: async ({ plane, require, params, body, stepUp }) => {
              const agent = await plane.agents!.get(
                (params as { id: string }).id,
              );
              await require("agents:write", serviceScope(agent.service));
              await agentStepUp(stepUp);
              return {
                status: 200,
                body: await plane.agents!.rotate(
                  agent.id,
                  (body as { revision: number }).revision,
                ),
              };
            },
          },
          {
            method: "post",
            path: "/agents/:id/revoke",
            summary:
              "Revokes an agent's key at once (no step-up: it only takes access away)",
            tag: "agents",
            params: S.IdParams,
            body: S.RevisionBody,
            responses: { 200: S.Agent },
            problems: [404, 409],
            handle: async ({ plane, require, params, body, operator }) => {
              const agent = await plane.agents!.get(
                (params as { id: string }).id,
              );
              await require("agents:write", serviceScope(agent.service));
              return {
                status: 200,
                body: await plane.agents!.revoke(
                  agent.id,
                  (body as { revision: number }).revision,
                  operator,
                ),
              };
            },
          },
        ] satisfies AnyRoute[])),

    // ── Audit (control-plane.md §6) ───────────────────────────────────────
    {
      method: "get",
      path: "/audit",
      summary:
        "The audit log, a page at a time, filtered; each intent with its status",
      tag: "audit",
      query: S.AuditQuery,
      responses: { 200: S.AuditEntries },
      handle: async ({ plane, require, query }) => {
        const q = query as Infer<typeof S.AuditQuery>;
        await require("audit:read", q.scope ?? "global");
        // A scope reads what is under it, as a role binding covers it.
        const scopes =
          q.scope === undefined
            ? undefined
            : await plane.auditScopesUnder(q.scope);
        const page = await plane.auditPage({
          limit: q.limit ?? DEFAULT_API_PAGE_LIMIT,
          direction: q.direction ?? "desc",
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          ...(q.actor === undefined ? {} : { actor: q.actor }),
          ...(q.action === undefined ? {} : { action: q.action }),
          ...(scopes === undefined ? {} : { scopes }),
          ...(q.since === undefined ? {} : { since: q.since }),
          ...(q.until === undefined ? {} : { until: q.until }),
        });
        return pageOf(page);
      },
    },
    {
      method: "get",
      path: "/audit/checkpoints",
      summary: "The chain's signed checkpoints, newest first",
      tag: "audit",
      query: S.PageQuery,
      responses: { 200: S.Checkpoints },
      handle: async ({ plane, require, query }) => {
        await require("audit:read", "global");
        const q = query as PageQueryOf;
        const page = await plane.store.listCheckpoints({
          limit: q.limit ?? DEFAULT_API_PAGE_LIMIT,
          direction: "desc",
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        });
        return pageOf({
          items: [...page.items],
          ...(page.next === undefined ? {} : { next: page.next }),
        });
      },
    },
    {
      method: "get",
      path: "/audit/verify",
      summary:
        "Recomputes the chain and checks every checkpoint; names the first entry where it broke",
      tag: "audit",
      responses: { 200: S.AuditVerify },
      handle: async ({ plane, require }) => {
        await require("audit:read", "global");
        return { status: 200, body: await plane.audit.verify() };
      },
    },
    {
      method: "get",
      path: "/audit/export",
      summary:
        "The audit log as JSON Lines (a step-up), between since and until",
      tag: "audit",
      query: S.ExportQuery,
      responses: { 200: { content: { "application/x-ndjson": opaque() } } },
      handle: async ({ plane, require, query, stepUp, res }) => {
        const q = query as Infer<typeof S.ExportQuery>;
        await require("audit:export", "global");
        if (!(await stepUp()) && options.guard !== "none") {
          throw new ApiProblem(
            403,
            "forbidden",
            "exporting the audit log needs a step-up",
          );
        }
        await plane.audit.event("audit.export", "global", {
          ...(q.since === undefined ? {} : { since: q.since }),
          ...(q.until === undefined ? {} : { until: q.until }),
        });
        const lines: string[] = [];
        for await (const record of plane.audit.entries({
          ...(q.since === undefined ? {} : { since: q.since }),
          ...(q.until === undefined ? {} : { until: q.until }),
        })) {
          lines.push(JSON.stringify(record));
        }
        res
          .status(200)
          .set("content-type", "application/x-ndjson")
          .send(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
        return undefined;
      },
    },
    {
      method: "get",
      path: "/audit/:n",
      summary: "One audit entry",
      tag: "audit",
      params: S.EntryParams,
      responses: { 200: S.AuditEntry },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        await require("audit:read", "global");
        const { n } = params as { n: number };
        const entry = await plane.auditEntry(n);
        return { status: 200, body: entry };
      },
    },

    // ── Break-glass (Q11) ─────────────────────────────────────────────────
    ...(options.breakGlass === undefined
      ? []
      : [
          {
            method: "post",
            path: "/break-glass/session",
            summary:
              "Signs in the break-glass account with its password and a TOTP code; a 15-minute token (audited, alerted)",
            tag: "break-glass",
            public: true,
            body: S.BreakGlassBody,
            responses: { 200: S.BreakGlassSession },
            problems: [429],
            handle: async ({ plane, body }) => {
              const input = body as Infer<typeof S.BreakGlassBody>;
              const attempt = await options.breakGlass!.login(
                input.password,
                input.code,
              );
              if (!attempt.ok) {
                if (attempt.reason === "locked") {
                  // While locked, attempts go to the log only: at most five
                  // failures reach the chain per lock, whoever is trying.
                  plane.logger.warn(
                    "bun-security: a break-glass login was refused while locked",
                    { lockedUntil: attempt.lockedUntil },
                  );
                } else {
                  await plane.audit
                    .event("breakGlass.failed", "global", {
                      reason: attempt.reason,
                      ...(attempt.locked === true ? { locked: true } : {}),
                    })
                    .catch((error: unknown) =>
                      plane.logger.error(
                        "bun-security: a break-glass failure could not be audited",
                        { error },
                      ),
                    );
                }
                if (attempt.locked === true) {
                  plane.alert({
                    kind: "breakGlass.locked",
                    severity: "critical",
                    message:
                      "the break-glass account is locked for 15 minutes after 5 failed attempts",
                    detail: { lockedUntil: attempt.lockedUntil },
                  });
                }
                if (attempt.reason === "locked" || attempt.locked === true) {
                  throw new ApiProblem(
                    429,
                    "break_glass_locked",
                    "the break-glass account is locked; try again later",
                  );
                }
                throw new ApiProblem(
                  401,
                  "unauthenticated",
                  "the break-glass password or code is wrong",
                );
              }
              // No session without its audit trace.
              await plane.audit
                .event("breakGlass.login", "global", {
                  expiresAt: attempt.expiresAt,
                })
                .catch(() => {
                  throw new ApiProblem(
                    503,
                    "audit_unavailable",
                    "the audit log cannot be written now, so the break-glass login is refused",
                  );
                });
              plane.alert({
                kind: "breakGlass.login",
                severity: "critical",
                message: "the break-glass account signed in",
                detail: { expiresAt: attempt.expiresAt },
              });
              plane.emit("breakGlass.used", "global", {
                expiresAt: attempt.expiresAt,
              });
              return {
                status: 200,
                body: {
                  token: attempt.token,
                  expiresAt: attempt.expiresAt,
                  header: BREAK_GLASS_HEADER,
                },
              };
            },
          } satisfies AnyRoute,
        ]),

    // ── Live (ui.md §6) ────────────────────────────────────────────────────
    {
      method: "get",
      path: "/live",
      summary:
        "Server-sent events: the live hub's topics (overview, events, policy, approvals) with resume; without topics, policies published, bundles compiled, approvals opened and decided",
      tag: "live",
      query: A.LiveQuery,
      responses: { 200: { content: { "text/event-stream": LIVE_EVENTS } } },
      problems: [429],
      handle: async ({ req, res, operator, query }) => {
        const q = query as Infer<typeof A.LiveQuery>;
        const lastEventId =
          req.request.headers.get("last-event-id") ?? undefined;
        const resume = parseResume(q.resume ?? lastEventId);
        // Refused before the stream opens: a 429 problem, not a broken stream.
        if (hub.sessionsOf(operator) >= LIVE_LIMITS.connectionsPerOperator) {
          throw new ApiProblem(
            429,
            "rate_limited",
            `an operator holds at most ${LIVE_LIMITS.connectionsPerOperator} live connections`,
          );
        }
        const stream = res.sse({ contract: LIVE_EVENTS });
        let pending = 0;
        const session = hub.open(operator, {
          send: (type, data, id) => {
            pending += JSON.stringify(data).length;
            void (
              stream.send as (message: {
                event: string;
                data: unknown;
                id?: string;
              }) => Promise<boolean>
            )({
              event: type,
              data,
              ...(id === undefined ? {} : { id }),
            }).then(() => {
              pending = 0;
            });
          },
          buffered: () => pending,
          close: () => {
            void stream.close();
          },
        });
        stream.onClose(() => session.closedByClient());
        if (q.topics === undefined) {
          session.subscribeUnscoped();
        } else {
          const subscribed = await session.subscribe(q.topics, resume);
          void stream.send({ event: "subscribed", data: subscribed });
        }
        return undefined;
      },
    },
    ...analyticsRoutes(),
  ];
}

/**
 * Making or rotating an agent's key mints a secret: it needs a fresh second
 * factor where a hook is configured. Under two-person approvals with no hook
 * it is refused (an approval would have to show the secret to someone).
 */
async function agentStepUp(stepUp: () => Promise<boolean>): Promise<void> {
  if (!(await stepUp())) {
    throw new ApiProblem(
      403,
      "forbidden",
      "making or rotating an agent key needs a step-up hook (stepUp); under approvals without one it is refused",
    );
  }
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
