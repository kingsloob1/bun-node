/**
 * Inheritance (control-plane.md §2.2): `mergePolicies` merges objects by
 * key, keyed collections by id (override, disable with `mode: "off"`),
 * refuses an override of a locked item, unions lists with their layer's
 * scope, and reports each field's origin; `diffPolicies` matches keyed
 * items by key.
 */
import { describe, expect, it } from "bun:test";
import { diffPolicies, mergePolicies } from "../../lib/control/index";

describe("mergePolicies", () => {
  it("merges objects by key, replaces scalars and unkeyed arrays, and records origins", () => {
    const merged = mergePolicies([
      {
        scope: "global",
        policy: {
          mode: "dryRun",
          ladder: {
            halfLife: "1h",
            steps: [{ score: 3, action: "challenge" }],
          },
        },
      },
      {
        scope: "group:payments",
        policy: {
          mode: "enforce",
          ladder: { steps: [{ score: 5, action: "ban" }] },
        },
      },
    ]);
    expect(merged.policy).toEqual({
      mode: "enforce",
      ladder: { halfLife: "1h", steps: [{ score: 5, action: "ban" }] },
    });
    expect(merged.origins).toMatchObject({
      mode: "group:payments",
      "ladder.halfLife": "global",
      "ladder.steps": "group:payments",
    });
  });

  it("overrides a keyed item by id, disables it with mode off, and adds a lower scope's own", () => {
    const merged = mergePolicies([
      {
        scope: "global",
        policy: {
          limits: [
            { id: "a", limit: 10, window: "1m" },
            { id: "b", limit: 5, window: "1m" },
          ],
          requestRules: {
            rules: [{ id: "r", when: { path: { prefix: "/x" } } }],
          },
        },
      },
      {
        scope: "service:checkout",
        policy: {
          limits: [
            { id: "a", limit: 99 },
            { id: "c", limit: 1, window: "1s" },
          ],
          requestRules: { rules: [{ id: "r", mode: "off" }] },
        },
      },
    ]);
    expect(merged.policy.limits).toEqual([
      { id: "a", limit: 99, window: "1m" },
      { id: "b", limit: 5, window: "1m" },
      { id: "c", limit: 1, window: "1s" },
    ]);
    expect((merged.policy.requestRules as { rules: unknown[] }).rules).toEqual([
      { id: "r", when: { path: { prefix: "/x" } }, mode: "off" },
    ]);
    expect(merged.origins["limits[id=a]"]).toBe("service:checkout");
    expect(merged.origins["limits[id=b]"]).toBe("global");
    expect(merged.locked).toEqual([]);
  });

  it("keeps a locked item and reports the override; negative control: unlocked, it is overridden", () => {
    const layers = (locked: boolean) =>
      mergePolicies([
        {
          scope: "global",
          policy: {
            countedRules: [
              {
                id: "scan",
                event: "probe.hit",
                threshold: 1,
                window: "1m",
                duration: "1d",
                locked,
              },
            ],
          },
        },
        {
          scope: "group:g",
          policy: { countedRules: [{ id: "scan", mode: "off" }] },
        },
      ]);
    const kept = layers(true);
    expect(kept.policy.countedRules).toEqual([
      {
        id: "scan",
        event: "probe.hit",
        threshold: 1,
        window: "1m",
        duration: "1d",
        locked: true,
      },
    ]);
    expect(kept.locked).toEqual([
      { path: "countedRules[id=scan]", lockedBy: "global", scope: "group:g" },
    ]);
    expect(
      (layers(false).policy.countedRules as { mode?: string }[])[0]?.mode,
    ).toBe("off");
  });

  it("unions lists, scoping each entry by its layer; an entry's own scope is kept", () => {
    const merged = mergePolicies([
      {
        scope: "global",
        policy: {
          lists: [{ ip: "203.0.113.0/24", action: "block", locked: true }],
        },
      },
      {
        scope: "group:g",
        policy: { lists: [{ ip: "198.51.100.0/24", action: "allow" }] },
      },
      {
        scope: "service:s",
        policy: {
          lists: [{ id: "own", user: "u_1", action: "block", scope: "global" }],
        },
      },
    ]);
    expect(merged.policy.lists).toEqual([
      { ip: "203.0.113.0/24", action: "block", locked: true, scope: "global" },
      { ip: "198.51.100.0/24", action: "allow", scope: "group" },
      { id: "own", user: "u_1", action: "block", scope: "global" },
    ]);
  });
});

describe("diffPolicies", () => {
  it("matches keyed items by key, so a reorder is no change; reports adds, removals and changes", () => {
    const before = {
      limits: [
        { id: "a", limit: 1 },
        { id: "b", limit: 2 },
      ],
      mode: "dryRun",
    };
    const after = {
      limits: [
        { id: "b", limit: 2 },
        { id: "a", limit: 5 },
        { id: "c", limit: 3 },
      ],
    };
    expect(diffPolicies(before, after)).toEqual([
      { path: "limits[id=a].limit", before: 1, after: 5 },
      { path: "limits[id=c]", after: { id: "c", limit: 3 } },
      { path: "mode", before: "dryRun" },
    ]);
    expect(diffPolicies(before, structuredClone(before))).toEqual([]);
  });
});
