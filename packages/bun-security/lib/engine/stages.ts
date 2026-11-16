/**
 * The two stages of an integration that sees a request twice (plan §3.3):
 *
 * - **`"early"`**, before the request is read or routed: layers L1 to L4
 *   and the limits and counted rules that need nothing routing or the app
 *   knows, so a refused request costs no parsing;
 * - **`"route"`**, once routing has picked the route and the app's
 *   `identify()` has run: the limits and counted rules keyed on who is
 *   calling (`user`, `session`, `tenant`, `apiKey`) or on the matched route
 *   (`route`), or applying to a route pattern with a parameter
 *   (`"GET /users/:id"`), which only the matched route can satisfy, and the
 *   user and API-key entries of the lists.
 *
 * Every limit and counted rule belongs to exactly one stage, so a request
 * evaluated in both is counted once. The other layers split the same way:
 * the in-flight limits, the trust check, the lists' address entries, bans
 * of an address (and of ranges), L6's shape checks and L8's honeypots run
 * early; the lists' user and API-key entries, bans naming the caller or the
 * route, and L8's canary credentials (which need `identify`) run in the
 * route stage. An event both stages see (`request`, `route.notFound`,
 * `server.error`) adds its offence weight once, in the early stage. An integration that sees a request once
 * (`withSecurity`) evaluates both stages together.
 */
import type { CompiledKey } from "../policy/compile";
import type { RoutePattern } from "../policy/routes";

/** A stage of a two-stage evaluation; see the module's description. */
export type EvaluationStage = "early" | "route";

/** What a limit or counted rule's stage is decided from. */
interface StagedRule {
  /** Its key. */
  readonly key: CompiledKey;
  /** The routes it applies to; every route when undefined. */
  readonly routes: readonly RoutePattern[] | undefined;
  /** The route profile it applies to, which only routing knows. */
  readonly profile?: string | undefined;
  /** The API key plan it applies to, which only `identify()` knows. */
  readonly apiKeyPlan?: string | undefined;
}

/** Each rule's stage, worked out once. */
const STAGES = new WeakMap<StagedRule, EvaluationStage>();

/** The stage `rule` is counted in. */
export function stageOf(rule: StagedRule): EvaluationStage {
  let stage = STAGES.get(rule);
  if (stage === undefined) {
    stage = classify(rule);
    STAGES.set(rule, stage);
  }
  return stage;
}

/**
 * The stage a key can be read in: the early stage for the address alone,
 * the route stage once it names the caller or the matched route. A ban of
 * that key type is enforced in the same stage.
 */
export function keyStage(key: CompiledKey): EvaluationStage {
  for (const part of key.parts) {
    if (part !== "ip" && part !== "crawler") return "route";
  }
  return "early";
}

/** {@link stageOf}, uncached. */
function classify(rule: StagedRule): EvaluationStage {
  if (
    keyStage(rule.key) === "route" ||
    rule.profile !== undefined ||
    rule.apiKeyPlan !== undefined
  ) {
    return "route";
  }
  if (rule.routes !== undefined) {
    for (const pattern of rule.routes) {
      // A parameter matches only the matched route's pattern, never a path.
      if (!pattern.prefix && pattern.path.includes(":")) return "route";
    }
  }
  return "early";
}

/** Whether `rule` is counted in `stage`; every rule is when no stage is given. */
export function inStage(
  rule: StagedRule,
  stage: EvaluationStage | undefined,
): boolean {
  return stage === undefined || stageOf(rule) === stage;
}
