/**
 * `POST /rules/test` and `POST /policies/:scope/impact` (PR-CP7), on the
 * user's decisions of 2026-11-17:
 *
 * - `rules:test` (analyst and up) on the service's scope for a test, on
 *   the draft's scope for an estimate; a draft also needs `policy:read`
 *   there.
 * - Neither is audited: both only read. Neither stores what it was given or
 *   what it found; a test request is never logged.
 * - Each is limited per operator across the instances (`incrementCounter`):
 *   30 tests and 6 estimates a minute; one estimate runs at a time per
 *   operator (a `claimKey` held while it runs), two per instance.
 */
import type { Infer } from "./schema";
import type { AnyRoute } from "./routes";
import type { ControlPlane } from "./plane";
import type { Operator, ResolvedSecurityApiOptions } from "./options";
import type { RuleTestInput } from "./contract/ruleTest";
import { RULE_TEST_LIMITS } from "./contract/ruleTest";
import { estimateImpact } from "./impact";
import { ApiProblem } from "./problems";
import { runRuleTest } from "./ruleTest";
import * as R from "./ruleTestSchemas";
import * as S from "./schemas";

/** A short, stable digest of an operator's id, for a store key. */
function operatorKey(operator: Operator): string {
  return new Bun.CryptoHasher("sha256")
    .update(operator.id)
    .digest("hex")
    .slice(0, 32);
}

/** Counts one call against the operator's minute; a `429` past `perMinute`. */
async function limitRate(
  plane: ControlPlane,
  operator: Operator,
  what: "test" | "estimate",
  perMinute: number,
): Promise<void> {
  const minute = Math.floor(plane.now() / 60_000);
  const counted = await plane.store.incrementCounter(
    `ruleTest:${what}:${operatorKey(operator)}:${minute}`,
    61_000,
  );
  if (counted.count > perMinute) {
    throw new ApiProblem(
      429,
      "rate_limited",
      `at most ${perMinute} ${what === "test" ? "tests" : "estimates"} a minute per operator`,
    );
  }
}

/** Checks a test's `trustProxy`: `true`, a hop count, or the trusted ranges. */
function checkTrustProxy(value: unknown): void {
  if (value === undefined || typeof value === "boolean") return;
  if (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 32
  )
    return;
  if (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 64,
    )
  )
    return;
  throw new ApiProblem(
    400,
    "invalid_request",
    "trustProxy is true, a hop count (0 to 32) or the trusted ranges (at most 100)",
  );
}

/** The test and estimate routes. */
export function ruleTestRoutes(
  options: ResolvedSecurityApiOptions,
): AnyRoute[] {
  /** Estimates running on this instance. */
  let running = 0;
  /**
   * Runs one estimate under the limits (6 a minute per operator, one at a
   * time per operator, two per instance): of `scope`'s draft, or of
   * `candidate` (an approval's policy) in its place.
   */
  const estimate = async (
    plane: ControlPlane,
    operator: Operator,
    signal: AbortSignal,
    run: {
      scope: string;
      input: Infer<typeof R.RuleImpactBody>;
      candidate?: Readonly<Record<string, unknown>>;
    },
  ): Promise<Awaited<ReturnType<typeof estimateImpact>>> => {
    const { scope, input, candidate } = run;
    const to = input.to ?? plane.now();
    const from = input.from ?? to - RULE_TEST_LIMITS.defaultWindowMs;
    if (from >= to || to - from > RULE_TEST_LIMITS.maxWindowMs) {
      throw new ApiProblem(
        400,
        "invalid_request",
        "the window must end after it starts, and span at most 7 days",
      );
    }
    await limitRate(
      plane,
      operator,
      "estimate",
      RULE_TEST_LIMITS.estimatesPerMinute,
    );
    if (running >= RULE_TEST_LIMITS.estimatesPerInstance) {
      throw new ApiProblem(
        429,
        "rate_limited",
        `at most ${RULE_TEST_LIMITS.estimatesPerInstance} estimates run at once on an instance`,
      );
    }
    const lock = `ruleTest:running:${operatorKey(operator)}`;
    if (
      !(await plane.store.claimKey(
        lock,
        RULE_TEST_LIMITS.maxDurationMs + 5_000,
      ))
    ) {
      throw new ApiProblem(
        429,
        "rate_limited",
        "an estimate of yours is already running",
      );
    }
    running += 1;
    try {
      return await estimateImpact(plane, {
        scope,
        from,
        to,
        operator,
        signal,
        ...(candidate === undefined ? {} : { candidate }),
        ...(options.fleetSecret === undefined
          ? {}
          : { secret: options.fleetSecret }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // The caller went away: nobody reads this.
        throw new ApiProblem(
          400,
          "invalid_request",
          "the estimate was cancelled",
        );
      }
      throw error;
    } finally {
      running -= 1;
      await plane.store.resetCounter(lock).catch(() => undefined);
    }
  };
  return [
    {
      method: "post",
      path: "/rules/test",
      summary:
        "What a service's effective policy (or with a scope's draft in its place) would decide for a described request, and why; nothing is counted, banned, written or stored",
      tag: "rules",
      body: R.RuleTestBody,
      responses: { 200: R.RuleTestResult },
      problems: [400, 404, 422, 429],
      handle: async ({ plane, require, body, operator }) => {
        const input = body as RuleTestInput;
        await require("rules:test", `service:${input.service}`);
        if (input.draft !== undefined)
          await require("policy:read", input.draft);
        checkTrustProxy(input.trustProxy);
        let bytes = 0;
        for (const [name, value] of Object.entries(input.headers ?? {}))
          bytes += name.length + value.length;
        if (bytes > RULE_TEST_LIMITS.maxHeaderBytes) {
          throw new ApiProblem(
            400,
            "invalid_request",
            `the headers hold at most ${RULE_TEST_LIMITS.maxHeaderBytes} bytes`,
          );
        }
        await limitRate(
          plane,
          operator,
          "test",
          RULE_TEST_LIMITS.testsPerMinute,
        );
        if ((await plane.store.get("service", input.service)) === undefined) {
          throw new ApiProblem(
            404,
            "not_found",
            `service "${input.service}" was not found`,
          );
        }
        return {
          status: 200,
          body: await runRuleTest(plane, input, options.fleetSecret),
        };
      },
    },
    {
      method: "post",
      path: "/policies/:scope/impact",
      summary:
        "A scope's draft against its published policy over stored events: what would be refused, challenged or allowed differently, by rule and route (bounded; nothing stored)",
      tag: "policies",
      params: S.ScopeParams,
      body: R.RuleImpactBody,
      responses: { 200: R.RuleImpact },
      problems: [400, 404, 429],
      handle: async ({ plane, require, params, body, operator, req }) => {
        const { scope } = params as { scope: string };
        const input = body as Infer<typeof R.RuleImpactBody>;
        await require("rules:test", scope);
        await require("policy:read", scope);
        return {
          status: 200,
          body: await estimate(plane, operator, req.request.signal, {
            scope,
            input,
          }),
        };
      },
    },
    {
      method: "post",
      path: "/approvals/:id/impact",
      summary:
        "An approval's policy change against the published policy over stored events, as a draft's estimate (bounded; nothing stored); a 404 for an approval that changes no policy",
      tag: "approvals",
      params: S.IdParams,
      body: R.RuleImpactBody,
      responses: { 200: R.RuleImpact },
      problems: [400, 404, 429],
      handle: async ({ plane, require, params, body, operator, req }) => {
        const { id } = params as { id: string };
        const input = body as Infer<typeof R.RuleImpactBody>;
        const approval = await plane.getApproval(id);
        await require("approvals:read", approval.scope);
        const change = await plane.approvalChange(id);
        await require("rules:test", change.scope);
        await require("policy:read", change.scope);
        return {
          status: 200,
          body: await estimate(plane, operator, req.request.signal, {
            scope: change.scope,
            input,
            candidate: change.policy,
          }),
        };
      },
    },
  ];
}
