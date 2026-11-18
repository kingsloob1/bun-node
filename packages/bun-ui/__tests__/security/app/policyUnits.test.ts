/**
 * The policy and services screens' pure parts (PR-U4): changing a policy by
 * path, what a field shows (set here, inherited, default) and a lock from
 * above; the schema's controls; the services' figures; the crawler
 * conflicts across agents and the scope's services. No DOM.
 */
import { describe, expect, it } from "bun:test";
import { expectUndefined } from "../../harness/assert";
import {
  conflictsOf,
  countsOf,
  servicesUnder,
} from "../../../app/security/screens/policies/crawlers";
import {
  fieldState,
  lockedAbove,
  originOf,
  setAt,
} from "../../../app/security/screens/policies/paths";
import {
  controlOf,
  labelOf,
} from "../../../app/security/screens/policies/schema";
import {
  agentSummary,
  dryRunCount,
  modeSummary,
  trafficByService,
} from "../../../app/security/screens/services/figures";

const EFFECTIVE = {
  policy: { trustCheck: { threshold: 0.7, minRequests: 50 }, mode: "enforce" },
  origins: {
    "trustCheck.threshold": "global",
    "trustCheck.minRequests": "service:s",
    mode: "group:g",
  },
  locked: { "limits[id=a]": "global", "limits[id=b]": "service:s" },
};

describe("paths", () => {
  it("setAt sets, removes, and prunes an object a removal emptied (never the root)", () => {
    const one = setAt({}, ["trustCheck", "threshold"], 0.5);
    expect(one).toEqual({ trustCheck: { threshold: 0.5 } });
    expect(setAt(one, ["trustCheck", "threshold"], undefined)).toEqual({});
    expect(setAt({ a: { b: 1, c: 2 } }, ["a", "b"], undefined)).toEqual({
      a: { c: 2 },
    });
    expect(setAt({ list: [1, 2, 3] }, ["list", 1], undefined)).toEqual({
      list: [1, 3],
    });
  });

  it("a field set here, inherited from above, or default; one this scope published and removed is the default", () => {
    expect(
      fieldState({ mode: "off" }, EFFECTIVE, "service:s", ["mode"]),
    ).toEqual({
      kind: "own",
      value: "off",
      inherited: { value: "enforce", origin: "group:g" },
    });
    expect(
      fieldState({}, EFFECTIVE, "service:s", ["trustCheck", "threshold"]),
    ).toEqual({
      kind: "inherited",
      value: 0.7,
      origin: "global",
    });
    expect(
      fieldState({}, EFFECTIVE, "service:s", ["trustCheck", "minRequests"]),
    ).toEqual({
      kind: "default",
    });
    expect(fieldState({}, undefined, "global", ["mode"])).toEqual({
      kind: "default",
    });
  });

  it("an object's origin is its own, else its first leaf's", () => {
    expect(originOf(EFFECTIVE, "trustCheck")).toBe("global");
    expectUndefined(originOf(EFFECTIVE, "shape"), "an unset section's origin");
  });

  it("a lock binds only the scopes below the one that set it", () => {
    expect(lockedAbove(EFFECTIVE, "service:s", "limits[id=a]")).toBe("global");
    expectUndefined(
      lockedAbove(EFFECTIVE, "service:s", "limits[id=b]"),
      "a lock set on the scope itself",
    );
    expectUndefined(
      lockedAbove(EFFECTIVE, "service:s", "limits[id=c]"),
      "an unlocked item's lock",
    );
  });
});

describe("schema controls", () => {
  it("reads an enumeration, a duration, a section that can be off, a list of strings and a map", () => {
    expect(controlOf({ enum: ["a", "b"] })).toEqual({
      kind: "enum",
      values: ["a", "b"],
    });
    expect(
      controlOf({
        anyOf: [
          { type: "string" },
          { type: "object", properties: { minutes: {} } },
        ],
      }),
    ).toEqual({ kind: "duration" });
    expect(
      controlOf({ anyOf: [{ type: "integer", minimum: 1 }, { const: false }] }),
    ).toEqual({
      kind: "orFalse",
      inner: { kind: "number", integer: true, min: 1 },
    });
    expect(controlOf({ type: "array", items: { type: "string" } })).toEqual({
      kind: "lines",
    });
    expect(
      controlOf({ type: "object", additionalProperties: { type: "number" } }),
    ).toEqual({
      kind: "json",
    });
    expect(labelOf("maxQueryBytes")).toBe("Max query bytes");
    expect(labelOf("ipv6Prefix")).toBe("Ipv6 prefix");
  });
});

describe("the services' figures", () => {
  it("count what runs in dry run, and say the mode", () => {
    const policy = {
      lists: [{ mode: "dryRun" }, {}],
      requestRules: {
        rules: [{ mode: "dryRun" }],
        managed: { mode: "dryRun" },
      },
      shape: { mode: "dryRun" },
    };
    expect(dryRunCount(policy)).toBe(4);
    expect(modeSummary(policy)).toBe("Enforced, 4 in dry run");
    expect(modeSummary({ mode: "dryRun" })).toBe("Dry run (all of it)");
    expect(modeSummary({})).toBe("Enforced");
  });

  it("sum each service's requests a minute and refused share", () => {
    const figures = trafficByService(
      {
        tier: "minute",
        points: [
          { at: 0, service: "a", dims: { action: "allow" }, value: 90 },
          { at: 0, service: "a", dims: { action: "drop" }, value: 10 },
          { at: 0, service: "b", dims: { action: "log" }, value: 0 },
        ],
      },
      10,
    );
    expect(figures.get("a")).toEqual({ perMinute: 10, blockedShare: 0.1 });
    expect(figures.get("b")).toEqual({ perMinute: 0, blockedShare: null });
  });

  it("summarise a service's agents, leaving revoked ones out", () => {
    const agent = (status: string, bundleVersion: number) => ({
      id: status,
      service: "s",
      status,
      lastSeen: bundleVersion,
      reported: { bundleVersion, bundleKeyId: "k" },
    });
    const summary = agentSummary(
      [agent("ok", 3), agent("late", 2), agent("revoked", 9)] as never,
      "s",
    );
    expect(summary).toEqual({
      count: 2,
      states: { ok: 1, late: 1 },
      bundles: [3, 2],
      keys: ["k"],
      lastSeen: 3,
    });
  });
});

describe("crawler conflicts", () => {
  const conflict = {
    crawler: "google",
    entry: "country:US",
    range: "66.249.64.0/19",
  };
  const agent = (
    id: string,
    service: string,
    conflicts: unknown[] | undefined,
    total?: number,
  ) => ({
    id,
    service,
    revokedAt: null,
    reported:
      conflicts === undefined
        ? null
        : { crawlers: { conflicts, total: total ?? conflicts.length } },
  });

  it("are listed once with the services reporting them; an agent that cut its list is noted", () => {
    const report = conflictsOf(
      [
        agent("a1", "web", [conflict]),
        agent("a2", "api", [conflict], 40),
        agent("a3", "old", undefined),
      ] as never,
      null,
    );
    expect(report).toEqual({
      conflicts: [{ ...conflict, services: ["web", "api"] }],
      truncated: true,
      reporting: 2,
      agents: 3,
    });
    expect(
      conflictsOf([agent("a1", "web", [conflict])] as never, new Set(["api"])),
    ).toEqual({
      conflicts: [],
      truncated: false,
      reporting: 0,
      agents: 0,
    });
  });

  it("a group's scope covers the services of it and every group under it", () => {
    const groups = [
      { id: "g", parent: null },
      { id: "h", parent: "g" },
      { id: "i", parent: "h" },
      { id: "x", parent: null },
    ];
    const services = [
      { id: "s1", groups: ["i"] },
      { id: "s2", groups: ["x"] },
      { id: "s3", groups: ["g", "x"] },
    ];
    expect([...servicesUnder("group:g", services, groups)!]).toEqual([
      "s1",
      "s3",
    ]);
    expect([...servicesUnder("service:s2", services, groups)!]).toEqual(["s2"]);
    expect(servicesUnder("global", services, groups) === null).toBe(true);
  });

  it("count each crawler's outcomes, busiest first, ignoring unknown outcomes", () => {
    expect(
      countsOf({
        tier: "hour",
        points: [
          { at: 0, dims: { crawler: "bing", outcome: "request" }, value: 2 },
          { at: 0, dims: { crawler: "google", outcome: "request" }, value: 5 },
          { at: 1, dims: { crawler: "google", outcome: "request" }, value: 5 },
          {
            at: 0,
            dims: { crawler: "google", outcome: "whatever" },
            value: 99,
          },
        ],
      }).map((row) => [row.crawler, row.counts.request]),
    ).toEqual([
      ["google", 10],
      ["bing", 2],
    ]);
  });
});
