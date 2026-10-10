/**
 * Compile-time assertions for a shared unit's options (PR-B3a):
 * `SummonControllerOptions.queues` and `overrides`, `group.unit`, and
 * `controller.queues`. Checked by the tests typecheck
 * (`bun scripts/typecheck.ts`), not by `bun test`.
 *
 * Every `@ts-expect-error` below is a negative control: if the error ever
 * stops appearing, the build fails on the unused directive. Each sits beside
 * the same value written correctly, which must compile.
 */
import type {
  JobsDriver,
  SummonController,
  SummonControllerOptions,
  SummonGroupOptions,
  SummonPolicy,
} from "../lib/index";

/** `true` only when `A` and `B` are the same type, exactly. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true`. */
function assertTrue<T extends true>(_value?: T): void {}

declare const driver: JobsDriver;
const summoner: SummonPolicy["summoner"] = async () => {};

assertTrue<
  Equals<SummonGroupOptions["unit"], "per-queue" | "shared" | undefined>
>();
assertTrue<
  Equals<SummonControllerOptions["queues"], readonly string[] | undefined>
>();
assertTrue<Equals<SummonController["queues"], readonly string[]>>();
assertTrue<Equals<SummonController["queue"], string>>();

/** A shared unit over three queues, with per-queue values for one. */
export const shared: SummonControllerOptions = {
  driver,
  namespace: "shop",
  queues: ["renders", "thumbs", "previews"],
  group: { name: "media", unit: "shared" },
  overrides: { renders: { jobsPerWorker: 10, maxWorkers: 1 } },
  summoner,
};

/** One queue, as before. */
export const one: SummonControllerOptions = {
  driver,
  namespace: "shop",
  queue: "emails",
  summoner,
};

const names = ["renders", "thumbs"] as const;
/** A readonly tuple is a list of queues. */
export const fromConst: SummonControllerOptions = {
  ...shared,
  queues: names,
};

export const otherKey: SummonControllerOptions = {
  ...shared,
  // @ts-expect-error a shared unit's overrides hold only the two per-queue values.
  overrides: { thumbs: { budget: { perHour: 1 } } },
};

export const badUnit: SummonGroupOptions = {
  name: "media",
  // @ts-expect-error unit is "per-queue" or "shared".
  unit: "pooled",
};

export const badQueues: SummonControllerOptions = {
  ...shared,
  // @ts-expect-error queues is a list of names, not one name.
  queues: "renders",
};
