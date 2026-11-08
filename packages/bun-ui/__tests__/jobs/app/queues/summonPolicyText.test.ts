import type {
  SummonCapabilitiesDto,
  SummonTriggerDto,
} from "../../../app/api/types";
import type { SummonPolicyRow } from "../../../app/screens/queues/panels/summonPolicyText";
import { SUMMON_POLICY_KEYS } from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import {
  jobsPerWorkerText,
  PROVIDER_DEFAULT_BOOT_BUDGET,
  shutdownText,
  summonBudgetDefaulted,
  summonPolicyPerQueue,
  summonPolicyRows,
  summonPolicyVisibility,
} from "../../../app/screens/queues/panels/summonPolicyText";
import { expectUndefined } from "../assert";
import { policyFixture } from "./summonPolicyFixture";

/**
 * The Summon panel's Policy block in words (`summonPolicyText.ts`): when it
 * is shown, each row's text, and which values carry a "default" tag — a
 * value none of whose `SUMMON_POLICY_KEYS` paths the policy set.
 */

/** A ready launch-style summoner's capabilities. */
function capabilities(
  overrides: Partial<SummonCapabilitiesDto> = {},
): SummonCapabilitiesDto {
  return {
    style: "launch",
    dedupe: { kind: "none" },
    passes: "argv",
    bootBudgetMs: 180_000,
    shutdown: { signal: "SIGTERM", graceMs: 3_000 },
    maxLifetimeMs: null,
    enforcesLifetime: false,
    ...overrides,
  };
}

/** A row's value as it reads, chips joined by spaces. */
function text(row: SummonPolicyRow): string {
  return row.parts
    .map(
      (part) =>
        part.joiner +
        (part.names !== undefined && part.names.length > 0
          ? part.names.join(" ")
          : part.text),
    )
    .join("");
}

/** The row `id` of `rows`; throws when there is none. */
function row(rows: SummonPolicyRow[], id: string): SummonPolicyRow {
  const found = rows.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no ${id} row in ${rows.map((r) => r.id).join(", ")}`);
  }
  return found;
}

/** How many "default" tags a row shows: its own, plus its pieces'. */
function tags(target: SummonPolicyRow): number {
  return (target.tag ? 1 : 0) + target.parts.filter((part) => part.tag).length;
}

describe("when the Policy block is shown", () => {
  it("only with the feature on: the block for a local policy, a line for a stored status", () => {
    const policy = policyFixture();
    expect(summonPolicyVisibility(true, { local: true, policy })).toBe("shown");
    expect(summonPolicyVisibility(true, { local: false })).toBe("elsewhere");
    // A local status without one: nothing to show.
    expect(summonPolicyVisibility(true, { local: true })).toBe("none");
    // Negative control: the flag off, whatever the status carries.
    expect(summonPolicyVisibility(false, { local: true, policy })).toBe("none");
    expect(summonPolicyVisibility(false, { local: false })).toBe("none");
  });
});

describe("the policy's rows", () => {
  it("read as phrases, in the panel's order", () => {
    const rows = summonPolicyRows(policyFixture(), capabilities());
    expect(rows.map((r) => r.id)).toEqual([
      "triggers",
      "workers",
      "cooldown",
      "backoff",
      "circuit",
      "boot-budget",
      "lifetime",
      "shutdown",
      "summon-timeout",
      "served-by",
      "env",
      "from-summoned",
      "failure-hook",
    ]);
    expect(text(row(rows, "triggers"))).toBe(
      "On add · Events (coalesced 250ms) · Poll every 10s",
    );
    expect(text(row(rows, "workers"))).toBe(
      "at most 4 · 2 jobs per worker · at most 3 starting",
    );
    expect(text(row(rows, "cooldown"))).toBe("15s");
    expect(text(row(rows, "backoff"))).toBe("5s, doubling to 30s");
    expect(text(row(rows, "circuit"))).toBe("opens after 3 failures, for 1m");
    expect(text(row(rows, "boot-budget"))).toBe("2m");
    expect(text(row(rows, "lifetime"))).toBe("1h");
    expect(text(row(rows, "shutdown"))).toBe("SIGTERM, 3s grace");
    expect(text(row(rows, "summon-timeout"))).toBe("20s");
    expect(text(row(rows, "served-by"))).toBe("any live worker");
    expect(text(row(rows, "env"))).toBe("none");
    expect(text(row(rows, "from-summoned"))).toBe("no");
    expect(text(row(rows, "failure-hook"))).toBe("not set");
  });

  it("tag a row once when every value in it is a default", () => {
    const rows = summonPolicyRows(policyFixture(), capabilities());
    for (const target of rows) {
      if (target.id === "shutdown") {
        // The platform's, not the policy's: never tagged.
        expect(tags(target)).toBe(0);
        continue;
      }
      expect({ id: target.id, tag: target.tag }).toEqual({
        id: target.id,
        tag: true,
      });
      expect(target.parts.some((part) => part.tag)).toBe(false);
    }
  });

  it("tag no value the policy set, and each default piece of a row it set in part", () => {
    const rows = summonPolicyRows(
      policyFixture({
        explicit: [
          "triggers.events",
          "maxWorkers",
          "cooldown",
          "backoff.initial",
        ],
      }),
      capabilities(),
    );
    expect(tags(row(rows, "cooldown"))).toBe(0);
    // Backoff: the first wait set, the longest a default.
    const backoff = row(rows, "backoff");
    expect(backoff.tag).toBe(false);
    expect(backoff.parts.map((part) => part.tag)).toEqual([false, true]);
    // Workers: maxWorkers set; jobsPerWorker and maxPending defaults.
    expect(row(rows, "workers").parts.map((part) => part.tag)).toEqual([
      false,
      true,
      true,
    ]);
    // Triggers: on add, the debounce and the poll are defaults; events set.
    expect(row(rows, "triggers").parts.map((part) => part.tag)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    // A row the policy did not touch keeps its one tag.
    expect(row(rows, "circuit").tag).toBe(true);
  });

  it("read jobsPerWorker null as one worker regardless of depth", () => {
    expect(jobsPerWorkerText(null)).toBe("one regardless of depth");
    expect(jobsPerWorkerText(1)).toBe("1 job per worker");
    const rows = summonPolicyRows(
      policyFixture({ jobsPerWorker: null }),
      undefined,
    );
    expect(text(row(rows, "workers"))).toBe(
      "at most 4 · one regardless of depth · at most 3 starting",
    );
  });

  it("mute a trigger that is off, and print the debounce only beside one that is on", () => {
    const eventsOff = summonPolicyRows(
      policyFixture({
        triggers: [
          { kind: "onAdd", on: true, debounce: 250 },
          { kind: "events", on: false, debounce: 250 },
          { kind: "poll", on: false },
        ],
      }),
      undefined,
    );
    const triggers = row(eventsOff, "triggers");
    expect(text(triggers)).toBe(
      "On add (coalesced 250ms) · Events off · Poll off",
    );
    expect(triggers.parts.map((part) => part.muted)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    const allOff = summonPolicyRows(
      policyFixture({
        triggers: [
          { kind: "onAdd", on: false, debounce: 250 },
          { kind: "events", on: false, debounce: 250 },
          { kind: "poll", on: false },
        ],
      }),
      undefined,
    );
    expect(text(row(allOff, "triggers"))).toBe(
      "On add off · Events off · Poll off",
    );
  });

  it("show a trigger kind this build does not know as raw text, untagged", () => {
    const webhook = {
      kind: "webhook",
      on: true,
      every: 5_000,
    } as unknown as SummonTriggerDto;
    const rows = summonPolicyRows(
      policyFixture({
        triggers: [{ kind: "onAdd", on: true, debounce: 250 }, webhook],
      }),
      undefined,
    );
    const triggers = row(rows, "triggers");
    expect(text(triggers)).toBe(
      "On add (coalesced 250ms) · webhook (on: true, every: 5000)",
    );
    // Its key is unknown, so it carries no tag, and the known ones carry their own.
    expect(triggers.tag).toBe(false);
    expect(triggers.parts.map((part) => part.tag)).toEqual([true, true, false]);
  });

  it("show the group's circuit only where circuit.group is present", () => {
    const without = summonPolicyRows(policyFixture(), undefined);
    expect(without.some((r) => r.id === "group-circuit")).toBe(false);
    const withGroup = summonPolicyRows(
      policyFixture({
        circuit: {
          failures: 3,
          resetAfter: 60_000,
          group: { failures: 2, resetAfter: 300_000 },
        },
        explicit: ["group.circuit.failures"],
      }),
      undefined,
    );
    const group = row(withGroup, "group-circuit");
    expect(text(group)).toBe("opens after 2 failures across the group, for 5m");
    expect(group.parts.map((part) => part.tag)).toEqual([false, true]);
  });

  it("read an absent boot budget as the provider's default, never a number, and untagged", () => {
    const { bootBudget: _absent, ...pending } = policyFixture();
    const rows = summonPolicyRows(pending, undefined);
    const boot = row(rows, "boot-budget");
    expect(text(boot)).toBe(PROVIDER_DEFAULT_BOOT_BUDGET);
    expect(tags(boot)).toBe(0);
    // Set by the policy: its value, untagged.
    const set = summonPolicyRows(
      policyFixture({ bootBudget: 90_000, explicit: ["bootBudget"] }),
      undefined,
    );
    expect(text(row(set, "boot-budget"))).toBe("1m 30s");
    expect(tags(row(set, "boot-budget"))).toBe(0);
  });

  it("take the shutdown from the capabilities, and show none without them", () => {
    expect(shutdownText({ signal: "SIGTERM", graceMs: 3_000 })).toBe(
      "SIGTERM, 3s grace",
    );
    expect(
      shutdownText({ signal: "SIGINT", graceMs: 30_000, graceMaxMs: 120_000 }),
    ).toBe("SIGINT, 30s grace (up to 2m)");
    expect(shutdownText({ signal: "none", graceMs: 0 })).toBe(
      "no stop signal (in-invocation)",
    );
    const none = summonPolicyRows(
      policyFixture(),
      capabilities({ shutdown: { signal: "none", graceMs: 0 } }),
    );
    expect(text(row(none, "shutdown"))).toBe("no stop signal (in-invocation)");
    // Not ready: no capabilities, so no Shutdown row at all.
    const pending = summonPolicyRows(policyFixture(), undefined);
    expect(pending.some((r) => r.id === "shutdown")).toBe(false);
  });

  it("put the platform's lifetime cap beside the policy's, untagged", () => {
    const rows = summonPolicyRows(
      policyFixture(),
      capabilities({ maxLifetimeMs: 900_000 }),
    );
    const lifetime = row(rows, "lifetime");
    expect(text(lifetime)).toBe("1h · platform cap 15m");
    // The policy's value is a default; the cap is the platform's.
    expect(lifetime.tag).toBe(false);
    expect(lifetime.parts.map((part) => part.tag)).toEqual([true, false]);
  });

  it("show the scale-down only for a scale-style summoner", () => {
    expect(
      summonPolicyRows(policyFixture(), capabilities()).some(
        (r) => r.id === "scale-down",
      ),
    ).toBe(false);
    const scale = summonPolicyRows(
      policyFixture(),
      capabilities({ style: "scale" }),
    );
    expect(text(row(scale, "scale-down"))).toBe("to zero after 5m idle");
  });

  it("list the env names, and a servedBy this build does not know as text", () => {
    const rows = summonPolicyRows(
      policyFixture({
        env: ["API_URL", "REGION"],
        servedBy: "teleport" as never,
        fromSummoned: true,
        onSummonFailed: true,
        explicit: ["env", "fromSummoned", "onSummonFailed"],
      }),
      undefined,
    );
    expect(row(rows, "env").parts[0]?.names).toEqual(["API_URL", "REGION"]);
    expect(text(row(rows, "served-by"))).toBe("teleport");
    expect(text(row(rows, "from-summoned"))).toBe("yes");
    expect(text(row(rows, "failure-hook"))).toBe("set");
    expect(tags(row(rows, "env"))).toBe(0);
  });

  it("name only SUMMON_POLICY_KEYS, and every one but the budget's", () => {
    const rows = summonPolicyRows(
      policyFixture({
        circuit: {
          failures: 3,
          resetAfter: 60_000,
          group: { failures: 2, resetAfter: 300_000 },
        },
      }),
      capabilities({ style: "scale" }),
    );
    const named = new Set(rows.flatMap((r) => r.parts.flatMap((p) => p.keys)));
    const all: readonly string[] = SUMMON_POLICY_KEYS;
    for (const key of named) {
      expect(all).toContain(key);
    }
    // The budget is the status's own Budget row (summonBudgetDefaulted).
    expect(all.filter((key) => !named.has(key as never)).sort()).toEqual([
      "budget",
      "budget.perDay",
      "budget.perHour",
    ]);
  });
});

describe("a shared unit's per-queue capacities", () => {
  it("list each queue in order, marking what its override set; none for one queue", () => {
    expectUndefined(summonPolicyPerQueue(policyFixture()));
    expect(
      summonPolicyPerQueue(
        policyFixture({
          perQueue: {
            renders: { jobsPerWorker: 2, maxWorkers: 4, explicit: [] },
            thumbs: {
              jobsPerWorker: null,
              maxWorkers: 1,
              explicit: ["maxWorkers"],
            },
          },
        }),
      ),
    ).toEqual([
      {
        queue: "renders",
        jobsPerWorker: "2 jobs per worker",
        maxWorkers: "4",
        jobsPerWorkerOverride: false,
        maxWorkersOverride: false,
      },
      {
        queue: "thumbs",
        jobsPerWorker: "one regardless of depth",
        maxWorkers: "1",
        jobsPerWorkerOverride: false,
        maxWorkersOverride: true,
      },
    ]);
  });
});

describe("the Budget row's default tag", () => {
  it("is shown where the policy gave no budget, and only with a policy", () => {
    expect(summonBudgetDefaulted(policyFixture())).toBe(true);
    expect(summonBudgetDefaulted(policyFixture({ explicit: ["budget"] }))).toBe(
      false,
    );
    expect(summonBudgetDefaulted(undefined)).toBe(false);
  });
});
