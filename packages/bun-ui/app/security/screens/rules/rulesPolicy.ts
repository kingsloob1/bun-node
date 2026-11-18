/**
 * The scope's request rules, for the rules screens: the scope's own (its
 * draft's, else its head's, through U3's draft pieces), the ones it
 * inherits (its effective policy's, each with the scope it came from and
 * whether it is locked: the effective policy's `locked`, or its own flag),
 * the managed probe set's settings as they apply here, and each rule's
 * hits in the last 24 hours (the analytics `rules` metric: enforced hits
 * and dry-run would-blocks). The effective policy is `usePolicyLists`'s
 * (U4's `effective`).
 */
import { useQuery } from "@tanstack/react-query";
import { readSeries } from "../../analytics/api";
import { REFUSING } from "../../analytics/actions";
import { useSecurityClient } from "../../context";
import type { RuleJson } from "./ruleModel";
import { usePolicyLists } from "../lists/policy";
import { rulesOf } from "./ruleModel";

/** A rule inherited from a scope above. */
export interface InheritedRule {
  /** The rule. */
  readonly rule: RuleJson;
  /** The scope it came from. */
  readonly origin: string;
  /** Whether that scope locked it. */
  readonly locked: boolean;
}

/** A rule's hits over the last 24 hours. */
export interface RuleHits {
  /** Hits that acted (enforced). */
  readonly hits: number;
  /** Refusals it would have made in dry run. */
  readonly wouldBlock: number;
}

/** The rules screens' query keys. */
export const rulesKeys = {
  /** The rules' hits over the last 24 hours. */
  hits: (scope: string) => ["rules", scope, "hits"] as const,
};

/** The hits of every rule in the last 24 hours, by the rule's analytics name (`rule:<id>`). */
export function useRuleHits(scope: string, enabled: boolean) {
  const { client } = useSecurityClient();
  return useQuery({
    queryKey: rulesKeys.hits(scope),
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const series = await readSeries(
        { client, scope, range: { kind: "preset", seconds: 86_400 }, signal },
        "rules",
      );
      const out = new Map<string, { hits: number; wouldBlock: number }>();
      for (const point of series.points) {
        const rule = point.dims.rule ?? "";
        const row = out.get(rule) ?? { hits: 0, wouldBlock: 0 };
        if (point.dims.dryRun === "true") {
          if (REFUSING.has(point.dims.action ?? ""))
            row.wouldBlock += point.value;
        } else row.hits += point.value;
        out.set(rule, row);
      }
      return out as ReadonlyMap<string, RuleHits>;
    },
  });
}

/** An effective policy as the rules read it: its merged policy, each item's origin and each locked item's locking scope. */
export interface EffectiveRules {
  /** The merged policy. */
  readonly policy: Readonly<Record<string, unknown>>;
  /** Each field's or keyed item's path → the scope it came from. */
  readonly origins: Readonly<Record<string, string>>;
  /** Each locked item's path → the scope that locked it. */
  readonly locked: Readonly<Record<string, string>>;
}

/**
 * The rules `scope` inherits from the scopes above, from its effective
 * policy (`undefined` on global): each with the scope it came from and
 * whether it is locked (the effective policy's `locked`, or the rule's own
 * flag). U4's policy editor and the rules screen both read them so.
 */
export function inheritedRules(
  effective: EffectiveRules | undefined,
  scope: string,
): InheritedRule[] {
  if (effective === undefined) return [];
  const out: InheritedRule[] = [];
  for (const rule of rulesOf(effective.policy)) {
    const path = `requestRules.rules[id=${String(rule.id)}]`;
    const origin = effective.origins[path];
    if (origin === undefined || origin === scope) continue;
    out.push({
      rule,
      origin,
      locked: effective.locked[path] !== undefined || rule.locked === true,
    });
  }
  return out;
}

/** See the module's description. */
export function useRulesPolicy(scope: string, poll: boolean) {
  const policy = usePolicyLists(scope, poll);
  const effective = policy.effective;
  const managed =
    effective === undefined
      ? (policy.base.requestRules as { managed?: unknown } | undefined)?.managed
      : (effective.policy.requestRules as { managed?: unknown } | undefined)
          ?.managed;
  return {
    ...policy,
    own: rulesOf(policy.base),
    headRules: rulesOf(policy.head),
    inherited: inheritedRules(effective, scope),
    managed,
  };
}
