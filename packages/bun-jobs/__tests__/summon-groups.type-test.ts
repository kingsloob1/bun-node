/**
 * Compile-time assertions for the `summon` option's two forms: policies keyed
 * by queue name, and an array of groups (`{ queues, …policy }`) and such
 * records. Checked by the tests typecheck (`bun scripts/typecheck.ts`), not
 * by `bun test`.
 *
 * Every `@ts-expect-error` below is a negative control: if the error ever
 * stops appearing, the build fails on the unused directive. Each sits beside
 * the same value written correctly, which must compile.
 */
import type {
  BunJobsOptions,
  SummonGroup,
  SummonOption,
  SummonPolicy,
} from "../lib/index";

/** `true` only when `A` and `B` are the same type, exactly. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true`. */
function assertTrue<T extends true>(_value?: T): void {}

const summoner: SummonPolicy["summoner"] = async () => {};

assertTrue<Equals<BunJobsOptions["summon"], SummonOption | undefined>>();
assertTrue<Equals<SummonGroup["queues"], readonly string[]>>();

/* --- the record form, unchanged --------------------------------------------- */

export const record: SummonOption = { emails: { summoner, maxWorkers: 2 } };
declare const built: Record<string, SummonPolicy>;
export const recordVariable: SummonOption = built;
// @ts-expect-error a typo in a record's policy is still caught.
export const recordTypo: SummonOption = { emails: { summoner, maxWorker: 2 } };
// Any queue name compiles in the record form, as on develop: `length`
// included, and `queues` too.
export const lengthQueue: SummonOption = {
  length: { summoner },
  queues: { summoner },
};
// An array of policies is not a record, nor is a Map.
// @ts-expect-error an array's members are not policies by queue.
export const policyArray: SummonOption = [{ summoner }] as SummonPolicy[];
// @ts-expect-error a Map's members are not policies by queue.
export const policyMap: SummonOption = new Map([["emails", { summoner }]]);

/* --- the group form --------------------------------------------------------- */

export const groups: SummonOption = [
  { queues: ["emails", "images"], summoner, jobsPerWorker: 10 },
  { queues: ["reports"], summoner, budget: { perHour: 20 } },
];
const names = ["emails", "images"] as const;
export const fromConst: SummonOption = [{ queues: names, summoner }];
export const withOverrides: SummonOption = [
  {
    queues: ["emails", "images"],
    summoner,
    overrides: { images: { jobsPerWorker: 2 } },
  },
];
// `budget: false` in a group, in an override, and an override's budget over
// a group's `false`: each a SummonPolicy value, so each type-checks.
export const budgetOffOverride: SummonOption = [
  {
    queues: ["a", "b"],
    summoner,
    budget: { perHour: 20, perDay: 100 },
    overrides: { a: { budget: false } },
  },
];
export const budgetOnOverride: SummonOption = [
  {
    queues: ["a", "b"],
    summoner,
    budget: false,
    overrides: { a: { budget: { perHour: 5 } } },
  },
];
export const budgetOffRecord: SummonOption = { a: { summoner, budget: false } };
export const budgetTrueRefused: SummonOption = [
  // @ts-expect-error `true` is not a budget: only `false` or an object.
  { queues: ["a"], summoner, budget: true },
];
export const mixed: SummonOption = [
  { queues: ["emails", "images"], summoner },
  { reports: { summoner } },
];

export const groupTypo: SummonOption = [
  // @ts-expect-error a typo in a group is reported against the group.
  { queues: ["a"], summoner, jobsPerWorkr: 1 },
];
// @ts-expect-error a group needs a summoner.
export const noSummoner: SummonOption = [{ queues: ["a"] }];
export const overrideTypo: SummonOption = [
  // @ts-expect-error an override is a partial policy, checked like one.
  { queues: ["a"], summoner, overrides: { a: { jobsPerWorkr: 2 } } },
];
// @ts-expect-error queue names are strings.
export const notNames: SummonOption = [{ queues: [1], summoner }];
