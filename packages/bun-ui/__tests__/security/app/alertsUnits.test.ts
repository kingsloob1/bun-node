/**
 * An alert rule's condition as the form holds it (PR-U5): every kind
 * round-trips (stored → form → stored), and what the form cannot say is
 * refused with a reason before the API is asked.
 */
import type { AlertCondition } from "@kingsleyweb/bun-security/control/contract";
import { describe, expect, it } from "bun:test";
import {
  CONDITION_TYPES,
  conditionOf,
  describeCondition,
  emptyCondition,
  fieldsOf,
} from "../../../app/security/screens/alerts/conditionForm";

/** One condition of each kind, as the API stores them. */
const STORED: AlertCondition[] = [
  {
    type: "threshold",
    metric: "rules",
    dims: { rule: "canary", action: "ban" },
    windowMs: 300_000,
    value: 10,
    groupBy: "rule",
    prefix: "canary:",
  },
  { type: "rate", metric: "requests", windowMs: 60_000, value: 500 },
  {
    type: "baseline",
    metric: "requests",
    dims: { action: "block" },
    total: { metric: "requests" },
    windowMs: 900_000,
    baselineDays: 7,
    factor: 3,
    minimum: 100,
  },
  {
    type: "sustained",
    metric: "crawler.requests",
    dims: { verified: "false" },
    hours: 6,
    groupBy: "crawler",
  },
  { type: "banStorm", windowMs: 600_000, value: 50, source: "auto" },
  { type: "agentSilent", afterMs: 600_000 },
  {
    type: "agentWarning",
    kinds: ["store.down", "trust.misconfigured"],
    maxAgeMs: 300_000,
  },
];

describe("the condition form", () => {
  it("round-trips every kind", () => {
    expect(STORED.map((c) => c.type).sort()).toEqual(
      [...CONDITION_TYPES].sort(),
    );
    for (const condition of STORED) {
      expect(conditionOf(fieldsOf(condition))).toEqual({ condition });
    }
  });

  it("refuses what it cannot say, with the reason", () => {
    const cases: [Partial<ReturnType<typeof emptyCondition>>, string][] = [
      [{ value: "" }, "The value must be a number above 0"],
      [
        { value: "5", windowMinutes: "0" },
        "The window must be a number above 0",
      ],
      [{ value: "5", dims: "action" }, "“action” is not key=value"],
      [{ value: "5", metric: " " }, "Name the metric"],
      [
        { type: "banStorm", value: "2.5" },
        "The number of bans must be a whole number above 0",
      ],
      [
        { type: "agentWarning", kinds: " , " },
        "Name a warning kind, or * for any",
      ],
      [
        { type: "baseline", baselineDays: "x" },
        "The days of history must be a whole number above 0",
      ],
      [{ type: "sustained", hours: "169" }, "The hours are at most 168"],
    ];
    for (const [over, reason] of cases) {
      expect(conditionOf({ ...emptyCondition(), ...over })).toEqual({
        error: reason,
      });
    }
    // The control: the same form with a value is accepted.
    expect(
      "condition" in conditionOf({ ...emptyCondition(), value: "5" }),
    ).toBe(true);
  });

  it("describes a condition in one line", () => {
    expect(describeCondition(STORED[0]!)).toBe(
      "rules (rule=canary, action=ban) ≥ 10 in 5 min, per rule starting “canary:”",
    );
    expect(describeCondition(STORED[4]!)).toBe("≥ 50 auto bans in 10 min");
    expect(describeCondition(STORED[3]!)).toBe(
      "crawler.requests (verified=false) in each of the last 6 hours, per crawler",
    );
    expect(
      describeCondition({ type: "banStorm", windowMs: 3_600_000, value: 5 }),
    ).toBe("≥ 5 bans in 1 h");
  });
});
