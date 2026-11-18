/**
 * Test a request (ui.md §4.5, PR-CP7): a request an operator describes,
 * run through a service's effective policy, with a scope's draft standing in
 * for its published policy when asked, by the engine's `explain()`.
 *
 * Each test builds a throwaway engine: the effective policy compiled afresh,
 * the fleet's keying secret (so account lists and bans keyed by it match),
 * no shared store, in-memory state that is dropped when the test ends, and
 * no network: a crawler claim is never verified by reverse DNS, and an
 * address's country, ASN and classes are only what the test assumes. So a
 * test never counts, bans or writes anything an enforcement point or the
 * control plane keeps.
 */
import type { SecurityIdentity } from "../engine/facts";
import type { Explanation } from "../engine/decision";
import type { IntelLookup, IntelRecord } from "../intel/types";
import type { RuleTestInput, RuleTestResultDto } from "./contract/ruleTest";
import type { Security } from "../engine/security";
import type { BanRecord } from "../store/types";
import type { PolicyScopeId } from "./contract/types";
import type { ControlPlane } from "./plane";
import type { SharedStateStore } from "../engine/shared";
import { ConfigError, memoryThrottleStore } from "@kingsleyweb/bun-common";
import { requestFacts } from "../engine/facts";
import { THROWAWAY_ENGINE, withInternal } from "../engine/internal";
import { cidrContains, parseAddress, parseCidr } from "../ip/address";
import { createSecurity } from "../engine/security";
import { RULE_TEST_LIMITS } from "./contract/ruleTest";
import { ApiProblem } from "./problems";

/** What one test takes: the contract's input (validated by the route's schema). */
export type RuleTestRun = RuleTestInput;

/** A set that holds every string: the test's intel can tell any class (it answers only what is assumed). */
class EverySet extends Set<string> {
  override has(): boolean {
    return true;
  }
}

/** Intel that answers what the test assumes, for any address. */
function assumedIntel(intel: RuleTestRun["intel"]): IntelLookup {
  const record: IntelRecord = {
    ...(intel?.country === undefined
      ? {}
      : { country: intel.country.toUpperCase() }),
    ...(intel?.asn === undefined ? {} : { asn: intel.asn }),
    classes: [...(intel?.classes ?? [])].sort(),
  };
  return {
    lookup: () => record,
    provides: () => ({ country: true, asn: true, classes: new EverySet() }),
  };
}

/** A resolver that never resolves: no DNS is made for a test. */
const NO_DNS = Object.freeze({
  reverse: () =>
    Promise.reject(
      Object.assign(new Error("no DNS in a test"), { code: "ENOTFOUND" }),
    ),
  lookup: () =>
    Promise.reject(
      Object.assign(new Error("no DNS in a test"), { code: "ENOTFOUND" }),
    ),
});

/**
 * An empty shared store of the test's own, dropped with it: a policy whose
 * limits or counted rules count in the shared store (`state: "shared"`,
 * `hybrid`) is accepted and reads nothing counted. Its timers never fire
 * within a test.
 */
function throwawaySharedState(now: () => number): SharedStateStore {
  const values = new Map<string, unknown>();
  const throttle = memoryThrottleStore({ now });
  return {
    name: "rule-test",
    throttle,
    hybrid: throttle,
    intervals: { sync: 1e9, poll: 1e9, reconcile: 1e9 },
    get: async (key) => values.get(key),
    getMany: async (keys) => keys.map((key) => values.get(key)),
    set: async (key, value) => {
      values.set(key, value);
    },
    increment: async (key, by) => {
      const next = (Number(values.get(key)) || 0) + by;
      values.set(key, next);
      return next;
    },
    touch: async () => {},
    pfAdd: async () => true,
    pfCount: async () => 0,
    health: () => ({ healthy: true, failingSince: undefined, failures: 0 }),
    close: async () => {},
  };
}

/** The engine's explanation as plain JSON. */
export function explanationDto(
  explanation: Explanation,
): Pick<RuleTestResultDto, "decision" | "client" | "steps"> {
  const { decision, client, steps } = explanation;
  const subject: Record<string, string> = {};
  for (const [name, value] of Object.entries(decision.subject)) {
    if (typeof value === "string") subject[name] = value;
  }
  return {
    decision: {
      action: decision.action,
      ...(decision.status === undefined ? {} : { status: decision.status }),
      ...(decision.code === undefined ? {} : { code: decision.code }),
      ...(decision.delayMs === undefined ? {} : { delayMs: decision.delayMs }),
      ...(decision.retryAfter === undefined
        ? {}
        : { retryAfter: decision.retryAfter }),
      hits: decision.hits.map((hit) => ({
        layer: hit.layer,
        rule: hit.rule,
        action: hit.action,
        ...(hit.wouldHaveBeen === undefined
          ? {}
          : { wouldHaveBeen: hit.wouldHaveBeen }),
        ...(hit.reason === undefined ? {} : { reason: hit.reason }),
      })),
      tags: [...decision.tags],
      risk: decision.risk,
      subject,
      ...(decision.crawler === undefined
        ? {}
        : {
            crawler: {
              id: decision.crawler.id,
              verified: decision.crawler.verified,
              ...(decision.crawler.verifiedBy === undefined
                ? {}
                : { verifiedBy: decision.crawler.verifiedBy }),
              spoofed: decision.crawler.spoofed,
            },
          }),
    },
    client: {
      ...(client.address === undefined ? {} : { address: client.address }),
      ...(client.key === undefined ? {} : { key: client.key }),
      source: client.source,
      chain: client.chain.map((hop) => ({
        address: hop.address,
        source: hop.source,
        trusted: hop.trusted,
      })),
      ...(client.service === undefined ? {} : { service: client.service }),
    },
    steps: steps.map((step) => ({
      layer: step.layer,
      check: step.check,
      ...(step.rule === undefined ? {} : { rule: step.rule }),
      outcome: step.outcome,
      ...(step.decided === undefined ? {} : { decided: step.decided }),
    })),
  };
}

/** The most active bans a test reads for its subjects. */
const MAX_BANS_READ = 20_000;

/**
 * A throwaway engine for `policy`: the fleet secret, an empty shared store
 * of its own, `intel` for addresses, no DNS. A policy it refuses is a `422`.
 */
export function throwawayEngine(
  policy: unknown,
  secret: string | Uint8Array | undefined,
  intel: IntelLookup,
  now: () => number,
): Security {
  try {
    return createSecurity({
      // The brand that lets this engine take internal facts (assume, prekeyed).
      ...({ [THROWAWAY_ENGINE]: true } as object),
      policy: policy as never,
      logger: () => {},
      now,
      intel,
      resolver: NO_DNS,
      verifyTimeoutMs: 1,
      // A shared store needs the fleet secret (it keys accounts with it).
      ...(secret === undefined
        ? {}
        : { secret, store: throwawaySharedState(now) }),
    });
  } catch (error) {
    if (error instanceof ConfigError)
      throw new ApiProblem(
        422,
        "invalid_policy",
        `the engine refuses this policy: ${error.message}`,
      );
    throw error;
  }
}

/** A service's effective policy, with a scope's draft (or `candidate`, an approval's policy) standing in for its published policy when asked. */
export async function effectiveFor(
  plane: ControlPlane,
  service: string,
  draft: PolicyScopeId | undefined,
  candidate?: Readonly<Record<string, unknown>>,
): Promise<{ policy: Record<string, unknown>; versions: string[] }> {
  const effective =
    draft === undefined
      ? await plane.effective(service)
      : await plane.effective(service, {
          scope: draft,
          policy:
            candidate === undefined
              ? await plane.policyAt(draft, "draft")
              : (candidate as Record<string, unknown>),
        });
  if (
    draft !== undefined &&
    !effective.policyVersions.includes(`${draft}@draft`)
  ) {
    throw new ApiProblem(
      400,
      "invalid_request",
      `${draft} is not a scope above service "${service}"`,
    );
  }
  return {
    policy: effective.policy as Record<string, unknown>,
    versions: [...effective.policyVersions],
  };
}

/** Whether an active ban's subject is the request's. */
function bansSubject(
  ban: BanRecord,
  client: { address?: string },
  subject: Readonly<Record<string, string>>,
): boolean {
  const { type, value } = ban.subject;
  if (type === "user") return subject.user === value;
  if (type === "apiKey") return subject.apiKey === value;
  const address = parseAddress(client.address);
  if (address === null) return false;
  if (type === "ip") {
    const banned = parseAddress(value);
    return banned !== null && banned.text === address.text;
  }
  const cidr = parseCidr(value);
  return cidr !== null && cidrContains(cidr, address);
}

/** Runs one test; see the module's description. A policy the engine refuses is a `422`. */
export async function runRuleTest(
  plane: ControlPlane,
  run: RuleTestRun,
  secret: string | Uint8Array | undefined,
): Promise<RuleTestResultDto> {
  const effective = await effectiveFor(plane, run.service, run.draft);
  const limits = new Set(
    ((effective.policy.limits ?? []) as { id?: unknown }[])
      .map((limit) => limit.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const assumed = Object.entries(run.assume?.limits ?? {});
  if (assumed.length > RULE_TEST_LIMITS.maxAssumedLimits) {
    throw new ApiProblem(
      400,
      "invalid_request",
      `at most ${RULE_TEST_LIMITS.maxAssumedLimits} assumed limits`,
    );
  }
  const unknown = assumed.filter(([id]) => !limits.has(id)).map(([id]) => id);
  if (unknown.length > 0) {
    throw new ApiProblem(
      400,
      "invalid_request",
      `the policy has no limit ${unknown.map((id) => `"${id}"`).join(", ")}`,
    );
  }
  if (!run.path.startsWith("/") || run.path.startsWith("//")) {
    throw new ApiProblem(
      400,
      "invalid_request",
      "the path must start with a single /",
    );
  }
  let request: Request;
  try {
    // The raw path as given (its encoding kept), on a host nothing resolves.
    request = new Request(`http://service.invalid${run.path}`, {
      method: run.method,
      headers: (run.headers ?? {}) as Record<string, string>,
    });
  } catch (error) {
    throw new ApiProblem(
      400,
      "invalid_request",
      `the request is not valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const at = plane.now();
  const security = throwawayEngine(
    effective.policy,
    secret,
    assumedIntel(run.intel),
    () => at,
  );
  const notEvaluated = ["crawler.rdns"];
  if (run.intel === undefined) notEvaluated.push("intel");
  try {
    const identity = run.identity as SecurityIdentity | undefined;
    const facts = requestFacts(request, {
      peer: run.peer,
      service: run.service,
      ...(run.trustProxy === undefined
        ? {}
        : { trustProxy: run.trustProxy as boolean | number | string[] }),
      ...(run.clientIpHeader === undefined
        ? {}
        : { clientIpHeader: run.clientIpHeader }),
      ...(identity === undefined ? {} : { identity }),
      ...(run.routeKey === undefined ? {} : { routeKey: run.routeKey }),
      ...(run.profile === undefined ? {} : { profile: run.profile }),
    });
    // First, who the request is: its keys, for the bans that name them.
    const first = explanationDto(await security.explain(facts, { now: at }));
    if (
      secret === undefined &&
      (identity?.user !== undefined || identity?.apiKey !== undefined)
    ) {
      notEvaluated.push("bans.accounts");
    }
    let read = 0;
    let cursor: string | undefined;
    const scopes = await plane.scopesAbove(run.service);
    do {
      const page = await plane.store.listBans({
        limit: 500,
        scopes,
        active: true,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const ban of page.items) {
        read += 1;
        if (!bansSubject(ban, first.client, first.decision.subject)) continue;
        const { type, value } = ban.subject;
        security.ban({
          ...(type === "user"
            ? { userHash: value }
            : type === "apiKey"
              ? { apiKeyHash: value }
              : { ip: value }),
          action: ban.action,
          duration:
            ban.expiresAt === null
              ? null
              : `${Math.max(1, ban.expiresAt - at)}ms`,
          reason: ban.reason,
          by: ban.createdBy ?? "control plane",
          ...(ban.code === undefined ? {} : { code: ban.code }),
        });
      }
      cursor = page.next;
    } while (cursor !== undefined && read < MAX_BANS_READ);
    if (cursor !== undefined) notEvaluated.push("bans.truncated");
    const explained =
      run.assume === undefined
        ? await security.explain(facts, { now: at })
        : await security.explain(
            withInternal(facts, {
              assume: {
                ...(run.assume.limits === undefined
                  ? {}
                  : { limits: run.assume.limits }),
                ...(run.assume.score === undefined
                  ? {}
                  : { score: run.assume.score }),
              },
            }),
            { now: at },
          );
    return {
      service: run.service,
      policy: { draft: run.draft ?? null, versions: effective.versions },
      at,
      ...explanationDto(explained),
      notEvaluated,
    };
  } finally {
    security.close();
  }
}
