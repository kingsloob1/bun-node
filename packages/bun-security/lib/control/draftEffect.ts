/**
 * `GET /policies/:scope/draft/effect` (PR-U4F): what a scope's draft does to
 * each service under it — each service's effective policy as published and
 * with the draft in its place, as their differences (the user's decision of
 * 2026-11-18, closing ui.md §3's "against the effective policy of each
 * affected service"). Bounded like the impact estimate: at most 200
 * services, at most 500 changes each (the rest counted). The draft's scope
 * needs `policy:read`; each service is compared only for an operator with
 * `policy:read` on it (else skipped, saying so), and both of its policies
 * are shown as a policy read shows them (accounts keyed, or `unkeyed`
 * without a keyring) before they are compared. It counts against the
 * impact estimate's per-operator budget (`estimateLimit.ts`): a `429`
 * with `Retry-After` past it. Read only: nothing stored, nothing audited.
 */
import type {
  DraftEffectDto,
  DraftServiceEffectDto,
} from "./contract/draftEffect";
import type { PolicyScopeId } from "./contract/types";
import type { Operator } from "./options";
import type { ControlPlane } from "./plane";
import type { AnyRoute } from "./routes";
import { DRAFT_EFFECT_LIMITS } from "./contract/draftEffect";
import { limitEstimates } from "./estimateLimit";
import { diffPolicies } from "./merge";
import { ApiProblem } from "./problems";
import { effectiveFor } from "./ruleTest";
import { s } from "./schema";
import * as S from "./schemas";

/**
 * A path in a change, with any account id it names that is not a key
 * redacted, as `origins` are without a keyring (with one, the stored
 * policies hold keys, so this redacts only a row older than the keying).
 */
function shownPath(path: string): string {
  return path.replace(
    /\[id=(user|apiKey):(?![\da-f]{32}[|\]])[^|\]]*/g,
    "[id=$1:[unkeyed]",
  );
}

/** Compares each service under `scope` with and without its draft; see the module's description. */
export async function draftEffect(
  plane: ControlPlane,
  scope: PolicyScopeId,
  operator: Operator,
  bounds: { readonly maxServices?: number; readonly maxChanges?: number } = {},
): Promise<DraftEffectDto> {
  const maxServices = bounds.maxServices ?? DRAFT_EFFECT_LIMITS.maxServices;
  const maxChanges = bounds.maxChanges ?? DRAFT_EFFECT_LIMITS.maxChanges;
  // The draft must exist (a 404 otherwise).
  await plane.policyAt(scope, "draft");
  const all = (await plane.servicesUnder(scope))
    .map((service) => service.id)
    .sort();
  const services: DraftServiceEffectDto[] = [];
  const skipped: { service: string; reason: string }[] = [];
  let notCompared = 0;
  for (const service of all) {
    if (services.length >= maxServices) {
      notCompared += 1;
      continue;
    }
    if (!(await plane.can(operator, "policy:read", `service:${service}`))) {
      skipped.push({ service, reason: "no policy:read on it" });
      continue;
    }
    let before: Record<string, unknown>;
    try {
      before = (await effectiveFor(plane, service, undefined)).policy;
    } catch (error) {
      if (!(error instanceof ApiProblem)) throw error;
      skipped.push({
        service,
        reason: `its published policy: ${error.message}`,
      });
      continue;
    }
    let after: Record<string, unknown>;
    try {
      after = (await effectiveFor(plane, service, scope)).policy;
    } catch (error) {
      if (!(error instanceof ApiProblem)) throw error;
      services.push({ service, changes: [], more: 0, error: error.message });
      continue;
    }
    const changes = diffPolicies(
      plane.showPolicy(before),
      plane.showPolicy(after),
    ).map((change) => ({ ...change, path: shownPath(change.path) }));
    services.push({
      service,
      changes: changes.slice(0, maxChanges),
      more: Math.max(0, changes.length - maxChanges),
    });
  }
  return { scope, services, skipped, notCompared };
}

/** A service's effect. */
const ServiceEffect = s.object({
  service: s.string(),
  changes: s.array(
    s.object({
      path: s.string(),
      before: s.optional(s.json("the value as published")),
      after: s.optional(s.json("the value with the draft")),
    }),
    DRAFT_EFFECT_LIMITS.maxChanges,
  ),
  more: s.int({ min: 0, description: "the differences past those listed" }),
  error: s.optional(
    s.string({
      description: "why the draft does not compile for this service",
    }),
  ),
});

/** `GET /policies/:scope/draft/effect`'s answer. */
export const DraftEffect = s.object({
  scope: s.string(),
  services: s.array(ServiceEffect, DRAFT_EFFECT_LIMITS.maxServices),
  skipped: s.array(
    s.object({ service: s.string(), reason: s.string() }),
    100_000,
  ),
  notCompared: s.int({
    min: 0,
    description: "services past the bound, not compared",
  }),
});

/** The route; see the module's description. */
export function draftEffectRoutes(): AnyRoute[] {
  return [
    {
      method: "get",
      path: "/policies/:scope/draft/effect",
      summary:
        "What a scope's draft does to each service under it: each one's effective policy as published and with the draft, as their differences (at most 200 services; each needs policy:read)",
      tag: "policies",
      params: S.ScopeParams,
      responses: { 200: DraftEffect },
      problems: [404, 429],
      handle: async ({ plane, require, params, operator }) => {
        const { scope } = params as { scope: PolicyScopeId };
        await require("policy:read", scope);
        // The impact estimate's budget, shared (the user's decision of 2026-11-18).
        await limitEstimates(plane, operator);
        return { status: 200, body: await draftEffect(plane, scope, operator) };
      },
    },
  ];
}
