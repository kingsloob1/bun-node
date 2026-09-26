import type {
  RunnerConfigKey as ContractRunnerConfigKey,
  RunnerConfigValues as ContractRunnerConfigValues,
  ExecutionModeDto,
  RunnerConfigBody,
  RunnerConfigDto,
} from "../lib/api/contract/index";
/**
 * Compile-time assertions for remote runner configuration.
 *
 * The runtime imports its numbers straight from the contract
 * (`EXECUTION_MODES`, `RUNNER_CONFIG_KEYS`, `RUNNER_CONFIG_BOUNDS`), so there
 * is one definition and nothing to pin. The one restatement is
 * `RunnerConfigKey`, a union `lib/runner/types.ts` declares rather than
 * importing from the API layer — these lines are what keeps it honest, along
 * with the runner types matching the DTOs a route will serialise them into.
 *
 * Checked by the tests typecheck (`bun scripts/typecheck.ts`), not by
 * `bun test`. Every `@ts-expect-error` is a negative control: if the error
 * stops appearing, the build fails on the unused directive.
 */
import type {
  ExecutionMode,
  RunnerAllowedOverrides,
  RunnerConfigInfo,
  RunnerConfigKey,
  RunnerConfigPatch,
  RunnerConfigValues,
  RunnerInfo,
} from "../lib/index";

/** `true` only when the two types are mutually assignable. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T;

/* --- the restated union matches the contract's ------------------------- */

export type ConfigKeyPinned = Expect<
  Equal<RunnerConfigKey, ContractRunnerConfigKey>
>;

/** The contract's execution-mode union is the driver's. */
export type ExecutionModePinned = Expect<
  Equal<ExecutionMode, ExecutionModeDto>
>;

/** Same three settings, same shapes, on both sides of the wire. */
export type ConfigValuesPinned = Expect<
  Equal<RunnerConfigValues, ContractRunnerConfigValues>
>;

/* --- the runtime types serialise into the DTOs ------------------------- */

/** Everything a route needs for `RunnerConfigDto` is on `RunnerConfigInfo`. */
export type ConfigInfoFitsDto = Expect<
  RunnerConfigInfo extends RunnerConfigDto ? true : false
>;

/** The patch a controller takes is the body a route parses. */
export type PatchTakesBody = Expect<
  RunnerConfigBody extends RunnerConfigPatch ? true : false
>;

/** An owner always knows its own configuration; a controller may not. */
export type OwnerConfigRequired = Expect<
  undefined extends RunnerInfo["config"] ? false : true
>;

/* --- negative controls -------------------------------------------------- */

// `maxConcurrency` is nullable — `null` is how "unlimited" crosses JSON.
export const unlimited: RunnerConfigValues = {
  executionMode: "child-process",
  runMode: "parallel",
  maxConcurrency: null,
};

export const notAMode: RunnerConfigValues = {
  // @ts-expect-error — only the three execution modes, spelled exactly.
  executionMode: "threads",
  runMode: "parallel",
  maxConcurrency: 1,
};

export const capAlone: RunnerConfigPatch = {
  // @ts-expect-error — a cap without its policy: the two are set together.
  concurrency: { maxConcurrency: 2 },
};

export const singleWithCap: RunnerConfigPatch = {
  // @ts-expect-error — `single` takes no cap; there is no overlap to bound.
  concurrency: { runMode: "single", maxConcurrency: 2 },
};

export const badAllowList: RunnerAllowedOverrides = {
  // @ts-expect-error — the allow-list holds execution modes, not any text.
  executionModes: ["in-process", "fork"],
};

/* --- a refusal names its settings -------------------------------------- */

/** `error.keys` is required whenever there is an error, on both sides of the wire. */
export type ErrorKeysPinned = Expect<
  Equal<
    NonNullable<RunnerConfigInfo["error"]>["keys"],
    NonNullable<RunnerConfigDto["error"]>["keys"]
  >
>;
export type ErrorKeysAreSettings = Expect<
  Equal<NonNullable<RunnerConfigDto["error"]>["keys"], RunnerConfigKey[]>
>;

// @ts-expect-error — `keys` is always present on an error; `[]` when unknown.
export const errorWithoutKeys: NonNullable<RunnerConfigDto["error"]> = {
  at: 1,
  message: "refused",
};

export const errorWithForeignKey: NonNullable<RunnerConfigInfo["error"]> = {
  at: 1,
  message: "refused",
  // @ts-expect-error — only the three overridable settings.
  keys: ["queueRuns"],
};
