/**
 * Compile-time assertions for `BunRunnerManager.controller()` and `RunnerController`.
 *
 * Checked by the tests typecheck (`bun scripts/typecheck.ts`), not by
 * `bun test`. Every `@ts-expect-error` is a negative control: if the error
 * ever stops appearing, the build fails on the unused directive.
 */
import type {
  BunRunnerManager,
  RunnerController,
  RunnerStats,
  SharedRunnerInfo,
  TriggerOutcome,
  TruncatedRunResult,
  TypedRunRecord,
} from "../lib/index";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/** What the runner is triggered with. */
interface CleanupArgs {
  /** Remove records older than this many days. */
  olderThanDays: number;
}

/** What a run returns. */
interface CleanupResult {
  /** Records removed. */
  removed: number;
}

declare const _manager: BunRunnerManager;

/* --- controller() carries the declared types --------------------------- */

type _remote = Expect<
  Equal<
    Awaited<ReturnType<typeof _manager.controller<CleanupArgs, CleanupResult>>>,
    RunnerController<CleanupArgs, CleanupResult>
  >
>;

declare const cleanup: RunnerController<CleanupArgs, CleanupResult>;

void cleanup.trigger({ args: { olderThanDays: 30 }, force: true });
// @ts-expect-error args are the runner's argument type
void cleanup.trigger({ args: { olderThanDays: "30" } });

type _trigger = Expect<
  Equal<Awaited<ReturnType<typeof cleanup.trigger>>, TriggerOutcome>
>;
type _history = Expect<
  Equal<
    Awaited<ReturnType<typeof cleanup.history>>,
    TypedRunRecord<CleanupResult>[]
  >
>;
type _result = Expect<
  Equal<
    TypedRunRecord<CleanupResult>["result"],
    CleanupResult | TruncatedRunResult | undefined
  >
>;
type _info = Expect<
  Equal<
    Awaited<ReturnType<typeof cleanup.info>>,
    SharedRunnerInfo<CleanupResult>
  >
>;
type _lastRun = Expect<
  Equal<
    SharedRunnerInfo<CleanupResult>["lastRun"],
    TypedRunRecord<CleanupResult> | undefined
  >
>;
type _stats = Expect<
  Equal<Awaited<ReturnType<typeof cleanup.stats>>, RunnerStats>
>;

void cleanup.updateSchedule({ cron: "0 3 * * *", tz: "UTC" });
void cleanup.resume({ triggerNow: true });

/* --- and there is no remote kill ---------------------------------- */

// @ts-expect-error a run can only be killed by the process executing it
void cleanup.kill();
// @ts-expect-error nor messaged
cleanup.send({ ping: true });

/* --- undeclared, it accepts anything, as a runner does ------------- */

declare const open: RunnerController;
void open.trigger({ args: 42 });
type _openResult = Expect<Equal<TypedRunRecord["result"], unknown>>;
