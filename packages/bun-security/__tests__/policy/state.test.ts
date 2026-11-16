/**
 * The policy's shared-state fields (topologies.md §3.2, §6.1): `state`
 * (`mode`, `onStoreError`, `nodes`), a limit's `state` and `onStoreError`,
 * a counted rule's; checked, and compiled with their defaults.
 */
import { PRESETS } from "../../lib/policy/presets";
import { describe, expect, it } from "bun:test";
import { compilePolicy, SecurityPolicyError } from "../../lib/index";
import { policyInternals } from "../../lib/policy/compile";

/** The issue paths of `policy`, joined. */
function issues(policy: unknown): string[] {
  try {
    compilePolicy(policy as never);
    return [];
  } catch (error) {
    if (!(error instanceof SecurityPolicyError)) throw error;
    return error.issues.map((issue) => issue.path.join("."));
  }
}

/** The rules of the policy itself, the presets (and the crawlers' own limit, PR-S12) left out. */
const own = <T extends { readonly id: string }>(rules: readonly T[]): T[] =>
  rules.filter(
    (rule) => !Object.hasOwn(PRESETS, rule.id) && rule.id !== "crawler",
  );

describe("the state fields", () => {
  it("refuses bad values, naming each", () => {
    expect(issues({ state: { mode: "global" } })).toEqual(["state.mode"]);
    expect(issues({ state: { onStoreError: "retry" } })).toEqual([
      "state.onStoreError",
    ]);
    expect(issues({ state: { nodes: 0 } })).toEqual(["state.nodes"]);
    expect(issues({ state: { nodes: 1.5 } })).toEqual(["state.nodes"]);
    expect(issues({ state: { nodes: 100_001 } })).toEqual(["state.nodes"]);
    expect(issues({ state: { other: 1 } })).toEqual(["state.other"]);
    const limit = { id: "l", limit: 1, window: "1m" };
    expect(issues({ limits: [{ ...limit, state: "cluster" }] })).toEqual([
      "limits.0.state",
    ]);
    expect(issues({ limits: [{ ...limit, onStoreError: "retry" }] })).toEqual([
      "limits.0.onStoreError",
    ]);
    expect(
      issues({ limits: [{ ...limit, state: "hybrid", algorithm: "gcra" }] }),
    ).toEqual(["limits.0.algorithm"]);
    const rule = {
      id: "c",
      event: "request",
      threshold: 1,
      window: "1m",
      duration: "1h",
    };
    expect(issues({ countedRules: [{ ...rule, state: "hybrid" }] })).toEqual([
      "countedRules.0.state",
    ]);
    expect(
      issues({ countedRules: [{ ...rule, onStoreError: "closed" }] }),
    ).toEqual(["countedRules.0.onStoreError"]);
  });

  it("compiles each rule's state and onStoreError with the policy's defaults", () => {
    const internals = policyInternals(
      compilePolicy({
        state: { mode: "hybrid", onStoreError: "closed", nodes: 4 },
        limits: [
          { id: "a", limit: 10, window: "1m" },
          {
            id: "b",
            limit: 10,
            window: "1m",
            state: "local",
            onStoreError: "open",
          },
        ],
        countedRules: [
          {
            id: "c",
            event: "request",
            threshold: 1,
            window: "1m",
            duration: "1h",
          },
        ],
      }),
    );
    expect(internals.nodes).toBe(4);
    expect(own(internals.limits).map((l) => [l.state, l.onStoreError])).toEqual(
      [
        ["hybrid", "closed"],
        ["local", "open"],
      ],
    );
    // A counted rule takes neither "hybrid" nor "closed" from the defaults.
    expect(
      own(internals.countedRules).map((r) => [r.state, r.onStoreError]),
    ).toEqual([[undefined, "local"]]);
    const plain = policyInternals(
      compilePolicy({ limits: [{ id: "a", limit: 1, window: "1m" }] }),
    );
    expect(plain.nodes).toBe(1);
    expect(own(plain.limits)[0]?.state).toBeUndefined();
    expect(own(plain.limits)[0]?.onStoreError).toBe("local");
  });
});
