/**
 * Compile-time assertions for a worker's `summon` option and
 * `summonedFromEnv()`: the modes are exactly the three approved spellings,
 * `mode` is the one required field, and the helper's answer — `undefined`
 * included — goes straight into the option. Checked by the tests typecheck
 * (`bun scripts/typecheck.ts`), not by `bun test`.
 *
 * Every `@ts-expect-error` below is a negative control: if the error ever
 * stops appearing, the build fails on the unused directive. Each sits beside
 * the same value written correctly, which must compile.
 */
import type {
  BunQueueWorkerOptions,
  SUMMON_ENV,
  WorkerInfo,
  WorkerSummonProvenance,
} from "../lib/index";
import { summonedFromEnv } from "../lib/index";

/** `true` only when `A` and `B` are the same type, exactly. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when given `true`. */
function assertTrue<T extends true>(_value?: T): void {}

/** The options every case below shares. */
const base = { namespace: "types" } satisfies BunQueueWorkerOptions;

/* --- the modes ------------------------------------------------------------- */

assertTrue<
  Equals<
    WorkerSummonProvenance["mode"],
    "exit-on-idle" | "until-stopped" | "in-invocation"
  >
>();
// The option, the record and the helper's answer are one shape.
assertTrue<
  Equals<BunQueueWorkerOptions["summon"], WorkerSummonProvenance | undefined>
>();
assertTrue<Equals<WorkerInfo["summon"], WorkerSummonProvenance | undefined>>();

export const modes: BunQueueWorkerOptions[] = [
  { ...base, summon: { mode: "exit-on-idle" } },
  { ...base, summon: { mode: "until-stopped", kind: "keda" } },
  {
    ...base,
    summon: { mode: "in-invocation", id: "a1", deadlineAt: 1_700_000_000_000 },
  },
];

// The draft's spellings are not modes. The directives sit on the property,
// where the error is reported, so a formatter cannot move them off it.
export const launch: BunQueueWorkerOptions = {
  ...base,
  summon: {
    // @ts-expect-error `"launch"` is a summoner style, not a worker mode.
    mode: "launch",
  },
};
export const inHandler: BunQueueWorkerOptions = {
  ...base,
  summon: {
    // @ts-expect-error `"in-handler"` was renamed `"in-invocation"`.
    mode: "in-handler",
  },
};

// `mode` is required: a provenance with no mode says nothing about how to run.
// @ts-expect-error `mode` is missing.
export const noMode: BunQueueWorkerOptions = { ...base, summon: { id: "a1" } };

// The old option name is gone.
export const summoned: BunQueueWorkerOptions = {
  ...base,
  // @ts-expect-error the option is `summon`, not `summoned`.
  summoned: { mode: "exit-on-idle" },
};

/* --- summonedFromEnv ------------------------------------------------------- */

const fromEnv = summonedFromEnv();

// Its answer, `undefined` included, is what the option takes — the recipe's
// one line, `summon: summonedFromEnv()`.
export const recipe: BunQueueWorkerOptions = { ...base, summon: fromEnv };
export const recipeWithArgs: BunQueueWorkerOptions = {
  ...base,
  summon: summonedFromEnv({ BUN_JOBS_SUMMON_ID: "a1" }, []),
};

// It may be `undefined`, so a caller must narrow before reading a field.
// @ts-expect-error `fromEnv` is possibly undefined.
export const unguarded: string | undefined = fromEnv.queue;
export const guarded: string | undefined = fromEnv?.queue;

// The extras configure the worker; they are numbers and strings, not `any`.
assertTrue<
  Equals<NonNullable<typeof fromEnv>["maxLifetimeMs"], number | undefined>
>();
assertTrue<
  Equals<NonNullable<typeof fromEnv>["graceMs"], number | undefined>
>();
assertTrue<
  Equals<NonNullable<typeof fromEnv>["namespace"], string | undefined>
>();

// Every key is under `BUN_JOBS_SUMMON_*`.
assertTrue<
  Equals<
    (typeof SUMMON_ENV)[keyof typeof SUMMON_ENV] extends `BUN_JOBS_SUMMON_${string}`
      ? true
      : false,
    true
  >
>();
assertTrue<
  Equals<(typeof SUMMON_ENV)["namespace"], "BUN_JOBS_SUMMON_NAMESPACE">
>();
