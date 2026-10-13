/**
 * Compile-time assertions for a worker's `summon` option and
 * `summonedFromArgs()`: `id` is the one required field (it is what makes a
 * worker summoned), `mode` is optional and exactly the three approved
 * spellings, and the helper's answer — `undefined` included — goes straight
 * into the option. Checked by the tests typecheck
 * (`bun scripts/typecheck.ts`), not by `bun test`.
 *
 * Every `@ts-expect-error` below is a negative control: if the error ever
 * stops appearing, the build fails on the unused directive. Each sits beside
 * the same value written correctly, which must compile.
 */
import type {
  BunQueueWorker,
  BunQueueWorkerOptions,
  JobsApiConfig,
  SUMMON_ARGS,
  SUMMON_POLICY_KEYS,
  SummonedArgs,
  SummonedExit,
  SummonPolicy,
  SummonPolicyKey,
  SummonPolicyStatus,
  SummonStatus,
  SummonTriggerStatus,
  WorkerInfo,
  WorkerSummonInfo,
  WorkerSummonProvenance,
} from "../lib/index";
import { runSummoned, summonedFromArgs } from "../lib/index";

/** `true` only when `A` and `B` are the same type, exactly. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true`. */
function assertTrue<T extends true>(_value?: T): void {}

/** The options every case below shares. */
const base = { namespace: "types" } satisfies BunQueueWorkerOptions;

/* --- the shape ------------------------------------------------------------- */

assertTrue<
  Equals<
    WorkerSummonProvenance["mode"],
    "exit-on-idle" | "until-stopped" | "in-invocation" | undefined
  >
>();
assertTrue<Equals<WorkerSummonProvenance["id"], string>>();
// The option, the record and the helper's answer are one shape.
assertTrue<
  Equals<BunQueueWorkerOptions["summon"], WorkerSummonProvenance | undefined>
>();
// The record's is the option's plus what the worker resolved itself, which
// is never an option.
assertTrue<Equals<WorkerInfo["summon"], WorkerSummonInfo | undefined>>();
assertTrue<
  Equals<
    WorkerSummonInfo["resolvedMode"],
    "exit-on-idle" | "until-stopped" | "in-invocation" | undefined
  >
>();
assertTrue<
  Equals<Omit<WorkerSummonInfo, "resolvedMode">, WorkerSummonProvenance>
>();
export const noResolvedModeOption: BunQueueWorkerOptions = {
  ...base,
  // @ts-expect-error -- resolvedMode is the worker's to report, never an option
  summon: { id: "a1", resolvedMode: "exit-on-idle" },
};
export const recordWithoutMode: WorkerSummonInfo = {
  id: "a1",
  resolvedMode: "exit-on-idle",
};
assertTrue<
  Equals<ReturnType<typeof summonedFromArgs>, SummonedArgs | undefined>
>();

export const shapes: BunQueueWorkerOptions[] = [
  { ...base, summon: { id: "a1" } },
  { ...base, summon: { id: "a1", mode: "exit-on-idle" } },
  { ...base, summon: { id: "a1", mode: "until-stopped", kind: "keda" } },
  {
    ...base,
    summon: { id: "a1", mode: "in-invocation", deadlineAt: 1_700_000_000_000 },
  },
];

// The draft's spellings are not modes. The directives sit on the property,
// where the error is reported, so a formatter cannot move them off it.
export const launch: BunQueueWorkerOptions = {
  ...base,
  summon: {
    id: "a1",
    // @ts-expect-error `"launch"` is a summoner style, not a worker mode.
    mode: "launch",
  },
};
export const inHandler: BunQueueWorkerOptions = {
  ...base,
  summon: {
    id: "a1",
    // @ts-expect-error `"in-handler"` was renamed `"in-invocation"`.
    mode: "in-handler",
  },
};

// `id` is required: without it a worker is not summoned.
export const noId: BunQueueWorkerOptions = {
  ...base,
  // @ts-expect-error `id` is missing.
  summon: { mode: "exit-on-idle" },
};

// The old option name is gone.
export const summoned: BunQueueWorkerOptions = {
  ...base,
  // @ts-expect-error the option is `summon`, not `summoned`.
  summoned: { id: "a1" },
};

/* --- summonedFromArgs ------------------------------------------------------ */

const fromArgs = summonedFromArgs();

// Its answer, `undefined` included, is what the option takes — the recipe's
// one line, `summon: summonedFromArgs()`.
export const recipe: BunQueueWorkerOptions = { ...base, summon: fromArgs };
export const recipeWithArgs: BunQueueWorkerOptions = {
  ...base,
  summon: summonedFromArgs(["--bun-jobs-summon-id=a1"]),
};

// It may be `undefined`, so a caller must narrow before reading a field.
// @ts-expect-error `fromArgs` is possibly undefined.
export const unguarded: string | undefined = fromArgs.queue;
export const guarded: string | undefined = fromArgs?.queue;

// The extras configure the worker; they are numbers and strings, not `any`.
assertTrue<Equals<SummonedArgs["maxLifetimeMs"], number | undefined>>();
assertTrue<Equals<SummonedArgs["graceMs"], number | undefined>>();
assertTrue<Equals<SummonedArgs["namespace"], string | undefined>>();

// Every name is a `--bun-jobs-summon-*` argument, none an environment key.
assertTrue<
  Equals<
    (typeof SUMMON_ARGS)[keyof typeof SUMMON_ARGS] extends `--bun-jobs-summon-${string}`
      ? true
      : false,
    true
  >
>();
assertTrue<Equals<(typeof SUMMON_ARGS)["id"], "--bun-jobs-summon-id">>();

/* --- the API switch -------------------------------------------------------- */

assertTrue<
  Equals<
    NonNullable<JobsApiConfig["serialize"]>["exposeSummonHandles"],
    boolean | undefined
  >
>();

/* --- runSummoned over a set (PR-B2) ---------------------------------------- */

/** Workers of different data and result types, as one unit's would be. */
declare const renders: BunQueueWorker<{ file: string }, number>;
declare const thumbs: BunQueueWorker<{ size: number }, string>;
// One worker, as ever, and a set of differently typed ones.
export const one: Promise<SummonedExit> = runSummoned(renders);
export const several: Promise<SummonedExit> = runSummoned([renders, thumbs], {
  idleFor: 1_000,
});
assertTrue<
  Equals<
    SummonedExit["queues"],
    Record<string, { completed: number; failed: number }> | undefined
  >
>();
// @ts-expect-error -- a set holds workers, nothing else.
export const notWorkers = runSummoned([renders, "thumbs"]);

/* --- status().policy ("policy visible", 2026-10-12) ------------------------ */

// Local only, so optional on the status; the explicit list is the
// contract's keys, read-only, and so is everything else that is a list.
assertTrue<Equals<SummonStatus["policy"], SummonPolicyStatus | undefined>>();
assertTrue<
  Equals<SummonPolicyStatus["explicit"], readonly SummonPolicyKey[]>
>();
assertTrue<Equals<SummonPolicyKey, (typeof SUMMON_POLICY_KEYS)[number]>>();
assertTrue<
  Equals<SummonPolicyStatus["triggers"], readonly SummonTriggerStatus[]>
>();
assertTrue<Equals<SummonTriggerStatus["kind"], "onAdd" | "events" | "poll">>();
// In the runtime, `jobsPerWorker` is the policy's number, `Infinity`
// included; only the wire makes it `null`.
assertTrue<Equals<SummonPolicyStatus["jobsPerWorker"], number>>();
// Never present until known: absent, not a placeholder.
assertTrue<Equals<SummonPolicyStatus["bootBudget"], number | undefined>>();
// `servedBy` is the policy option's own vocabulary.
assertTrue<
  Equals<SummonPolicyStatus["servedBy"], NonNullable<SummonPolicy["servedBy"]>>
>();
// env is names, never a record of values.
assertTrue<Equals<SummonPolicyStatus["env"], readonly string[]>>();
/**
 * Every dotted path into a policy option: `cooldown`, `backoff.initial`,
 * `group.circuit.failures`, … A function is a leaf; a union's object
 * members are walked and its other members (`false`, `true`) are not.
 */
type PolicyPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]-?:
    | `${Prefix}${K}`
    | (NonNullable<T[K]> extends infer V
        ? V extends (...args: never[]) => unknown
          ? never
          : V extends object
            ? PolicyPaths<V, `${Prefix}${K}.`>
            : never
        : never);
}[keyof T & string];
/** The paths a status may name: a policy's, the summoner aside (never shown). */
type ShownPolicyPath = PolicyPaths<Omit<SummonPolicy, "summoner">>;
// Every key in `SUMMON_POLICY_KEYS` is a real path into `SummonPolicy`, dotted
// or not, so a renamed option cannot leave a key naming nothing.
assertTrue<[SummonPolicyKey] extends [ShownPolicyPath] ? true : false>();
assertTrue<
  Equals<
    Extract<ShownPolicyPath, "group.circuit.resetAfter" | "budget.perDay">,
    "group.circuit.resetAfter" | "budget.perDay"
  >
>();
// Negative controls: a path that is not the policy's is refused, and so is a
// step into a non-object member of a union (`budget: false`).
// @ts-expect-error -- `triggers` has no `cron`
export const notAPath: ShownPolicyPath = "triggers.cron";
// @ts-expect-error -- `fromSummoned` is a boolean, with nothing under it
export const intoABoolean: ShownPolicyPath = "fromSummoned.value";
export function editsExplicit(status: SummonStatus): void {
  // @ts-expect-error -- the explicit list is read-only, as the status's other lists are
  status.policy!.explicit.push("cooldown");
}
