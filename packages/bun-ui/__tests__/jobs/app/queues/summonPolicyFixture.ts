import type { SummonPolicyDto } from "../../../app/api/types";

/**
 * A summon status's policy (`SummonPolicyDto`) for the Policy block's tests:
 * every value distinct, so a row's text names the field it came from, and
 * `explicit: []`, so every value is a default unless a test sets keys.
 */
export function policyFixture(
  overrides: Partial<SummonPolicyDto> = {},
): SummonPolicyDto {
  return {
    triggers: [
      { kind: "onAdd", on: true, debounce: 250 },
      { kind: "events", on: true, debounce: 250 },
      { kind: "poll", on: true, every: 10_000 },
    ],
    bootBudget: 120_000,
    maxWorkers: 4,
    jobsPerWorker: 2,
    maxPending: 3,
    cooldown: 15_000,
    backoff: { initial: 5_000, max: 30_000 },
    circuit: { failures: 3, resetAfter: 60_000 },
    maxLifetime: 3_600_000,
    servedBy: "any-worker",
    scaleDown: { after: 300_000 },
    summonTimeout: 20_000,
    env: [],
    fromSummoned: false,
    onSummonFailed: false,
    explicit: [],
    ...overrides,
  };
}
