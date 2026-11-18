/**
 * The per-operator budget the read-heavy policy estimates share (PR-CP7,
 * PR-U4F): `POST /policies/:scope/impact` and
 * `GET /policies/:scope/draft/effect` count against one budget, at most
 * {@link RULE_TEST_LIMITS}'s `estimatesPerMinute` a minute per operator
 * across the instances (the store's `incrementCounter`); past it a `429`
 * with `Retry-After`, the seconds until the minute ends (the user's
 * decision of 2026-11-18). `POST /rules/test` has a budget of its own.
 */
import type { Operator } from "./options";
import type { ControlPlane } from "./plane";
import { RULE_TEST_LIMITS } from "./contract/ruleTest";
import { ApiProblem } from "./problems";

/** A short, stable digest of an operator's id, for a store key. */
export function operatorKey(operator: Operator): string {
  return new Bun.CryptoHasher("sha256")
    .update(operator.id)
    .digest("hex")
    .slice(0, 32);
}

/** Counts one call against the operator's minute; a `429` with `Retry-After` past `perMinute`. */
export async function limitRate(
  plane: ControlPlane,
  operator: Operator,
  what: "test" | "estimate",
  perMinute: number,
): Promise<void> {
  const now = plane.now();
  const minute = Math.floor(now / 60_000);
  const counted = await plane.store.incrementCounter(
    `ruleTest:${what}:${operatorKey(operator)}:${minute}`,
    61_000,
  );
  if (counted.count > perMinute) {
    throw new ApiProblem(
      429,
      "rate_limited",
      `at most ${perMinute} ${what === "test" ? "tests" : "estimates"} a minute per operator`,
      {},
      {
        "retry-after": String(
          Math.max(1, Math.ceil((60_000 - (now % 60_000)) / 1_000)),
        ),
      },
    );
  }
}

/** Counts one estimate (an impact estimate or a draft's effect) against the shared budget. */
export async function limitEstimates(
  plane: ControlPlane,
  operator: Operator,
): Promise<void> {
  await limitRate(
    plane,
    operator,
    "estimate",
    RULE_TEST_LIMITS.estimatesPerMinute,
  );
}
