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
  BunQueueWorkerOptions,
  JobsApiConfig,
  SUMMON_ARGS,
  SummonedArgs,
  WorkerInfo,
  WorkerSummonProvenance,
} from "../lib/index";
import { summonedFromArgs } from "../lib/index";

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
assertTrue<Equals<WorkerInfo["summon"], WorkerSummonProvenance | undefined>>();
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
