import type { SummonGroupStatusDto } from "../../../app/api/types";
import { describe, expect, it } from "bun:test";
import {
  circuitKindLabel,
  groupCircuits,
  groupShares,
} from "../../../app/screens/queues/panels/summonGroupText";
import { expectNone, expectUndefined } from "../assert";

/**
 * A summon group in the shapes its views draw (`summonGroupText.ts`): the
 * member queues' shares of today's attempts in order, and the shared
 * circuit per provider kind.
 */

/** A group with no shares and no circuit. */
function group(
  overrides: Partial<SummonGroupStatusDto> = {},
): SummonGroupStatusDto {
  return {
    name: "gpu",
    budget: {
      hour: 0,
      perHour: 10,
      day: 0,
      perDay: 100,
      hourResetsAt: 0,
      dayResetsAt: 0,
    },
    queues: {},
    ...overrides,
  };
}

describe("a group's shares", () => {
  it("orders most attempts first, then by queue name", () => {
    const shares = groupShares(
      group({
        queues: {
          emails: { day: 3, lastAt: 1 },
          reports: { day: 7, lastAt: 2 },
          alerts: { day: 3, lastAt: 3 },
        },
      }),
    );
    expect(shares.map((share) => share.queue)).toEqual([
      "reports",
      "alerts",
      "emails",
    ]);
    expect(shares[0]).toEqual({ queue: "reports", day: 7, lastAt: 2 });
  });

  it("is empty with no attempts charged today", () => {
    expectNone(groupShares(group()));
  });
});

describe("a group's shared circuits", () => {
  it("takes every kind from circuits, in kind order, over the one circuit", () => {
    const circuits = groupCircuits(
      group({
        circuit: { failures: 9 },
        circuits: {
          k8s: { failures: 0 },
          ecs: {
            failures: 5,
            openUntil: 100,
            openedBy: { queue: "reports", id: "s-3" },
          },
        },
      }),
      "k8s",
    );
    expect(circuits).toEqual([
      {
        kind: "ecs",
        failures: 5,
        openUntil: 100,
        openedBy: { queue: "reports", id: "s-3" },
      },
      { kind: "k8s", failures: 0, openUntil: undefined, openedBy: undefined },
    ]);
  });

  it("keys the one circuit by the summoner's kind without circuits, or by none", () => {
    const shared = group({ circuit: { failures: 2 } });
    expect(groupCircuits(shared, "ecs")).toEqual([
      { kind: "ecs", failures: 2, openUntil: undefined, openedBy: undefined },
    ]);
    expectUndefined(groupCircuits(shared, undefined)[0]?.kind);
    expect(groupCircuits(shared, undefined)).toHaveLength(1);
    // An empty `circuits` falls back to `circuit` too.
    expect(groupCircuits({ ...shared, circuits: {} }, "ecs")).toHaveLength(1);
  });

  it("is empty where the group shares no circuit", () => {
    expectNone(groupCircuits(group(), "ecs"));
  });

  it("names an unknown kind as this summoner", () => {
    expect(circuitKindLabel(undefined)).toBe("this summoner");
    expect(circuitKindLabel("")).toBe("this summoner");
    expect(circuitKindLabel("ecs")).toBe("ecs");
  });
});
