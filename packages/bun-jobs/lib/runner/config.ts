import type { ExecutionMode, JobsDriver } from "../drivers/index";
import type {
  RunnerConfigInfo,
  RunnerConfigKey,
  RunnerConfigPatch,
  RunnerConfigValues,
} from "./types";
import {
  EXECUTION_MODES,
  RUNNER_CONFIG_BOUNDS,
  RUNNER_CONFIG_KEYS,
} from "../api/contract/constants";
import { ConfigError } from "../shared/errors";

/**
 * Runner configuration from another process: where the override lives, how a
 * controller writes it, and how an owner resolves what to run with.
 *
 * The override cannot live in the `executionMode`/`runMode`/`maxConcurrency`
 * state fields the runner already writes, because `BunRunner.start()`
 * rewrites those from code on every start and would clobber it. It lives in
 * its own `config:*` family instead, **one state field per setting**: the
 * driver's `setState` has no compare-and-set, so two controllers writing
 * different settings at the same moment must not be able to lose each
 * other's.
 *
 * The bounds and the key list are imported from the contract
 * (`lib/api/contract/constants.ts`), which imports nothing at all, rather
 * than restated here — one definition, and the UI builds its form from the
 * very numbers the owner enforces.
 */

/**
 * The state fields the override lives in. The owner keeps writing the plain
 * `executionMode`/`runMode`/`maxConcurrency` fields with the **effective**
 * values, so `RunnerController.info()` and older clients are unchanged.
 */
export const RUNNER_CONFIG_STATE = {
  /** The execution-mode override; absent when there is none. */
  executionMode: "config:executionMode",
  /** The overlap-policy override; absent when there is none. */
  runMode: "config:runMode",
  /** The concurrency-cap override, a number or `"unlimited"`. */
  maxConcurrency: "config:maxConcurrency",
  /** What the owner's own options asked for, as JSON. */
  code: "config:code",
  /** The execution modes the owner's code permits, as a JSON array. */
  allowed: "config:allowed",
  /** The override's version, bumped with `incrementCounters` on every write. */
  seq: "config:seq",
  /** The version the owner has adopted. */
  appliedSeq: "config:appliedSeq",
  /** When the owner last adopted, epoch ms. */
  appliedAt: "config:appliedAt",
  /** Why the owner refused part of the override, as JSON. */
  error: "config:error",
  /** When the override was last written, epoch ms. */
  updatedAt: "config:updatedAt",
} as const;

/**
 * Whether a driver can hold a runner's configuration override: the three
 * state primitives it is written and versioned with.
 *
 * Every driver this package ships implements all three, so this only prunes
 * on a partial driver a host supplied itself — the guard
 * `supportsWorkerControl` gives the worker control routes, at the runner's
 * own storage.
 */
export function supportsRunnerConfig(driver: JobsDriver): boolean {
  return (
    typeof driver.getState === "function" &&
    typeof driver.setState === "function" &&
    typeof driver.incrementCounters === "function"
  );
}

/** How an uncapped `maxConcurrency` override is spelled in state. */
export const UNLIMITED_CONCURRENCY = "unlimited";

/** The overlap policies a runner accepts. */
const RUN_MODES = ["single", "parallel"] as const;

/** The override exactly as the state hash holds it, before validation. */
export interface StoredRunnerOverride {
  /** The raw `config:executionMode` value. */
  executionMode?: string;
  /** The raw `config:runMode` value. */
  runMode?: string;
  /** The raw `config:maxConcurrency` value. */
  maxConcurrency?: string;
}

/** Everything the `config:*` fields hold, parsed but not yet validated. */
export interface StoredRunnerConfig {
  /** The three override fields, as stored. */
  override: StoredRunnerOverride;
  /** What the owner's code asked for, when an owner has written it. */
  code?: RunnerConfigValues;
  /** The execution modes the owner's code permits, when it wrote them. */
  allowed?: ExecutionMode[];
  /** The override's version; `0` when nothing is stored. */
  seq: number;
  /** The version an owner has adopted. */
  appliedSeq?: number;
  /** When an owner last adopted, epoch ms. */
  appliedAt?: number;
  /**
   * Why an owner refused part of the override, and which settings: `keys` is
   * `[]` on an error an owner stored before it named them.
   */
  error?: RunnerConfigError;
  /** When the override was last written, epoch ms. */
  updatedAt?: number;
}

/** What an owner should run with, and what it had to drop to get there. */
export interface ResolvedRunnerConfig {
  /** The values to run with. */
  effective: RunnerConfigValues;
  /** Which settings an override is stored for, in `RUNNER_CONFIG_KEYS` order. */
  overridden: RunnerConfigKey[];
  /** One message per setting whose override was dropped; empty when all were adopted. */
  refusals: string[];
  /** The settings whose override was dropped, in `RUNNER_CONFIG_KEYS` order; empty when all were adopted. */
  refusedKeys: RunnerConfigKey[];
  /** One message per adopted setting that needs care (a handler losing `ctx.driver`). */
  warnings: string[];
}

/**
 * An owner's refusal of an override, as stored under `config:error` and
 * reported on {@link RunnerConfigInfo.error}.
 */
export interface RunnerConfigError {
  /** When it was refused, epoch ms. */
  at: number;
  /** A safe message naming each refused setting. */
  message: string;
  /** The refused settings, in `RUNNER_CONFIG_KEYS` order; `[]` when a stored error predates the field. */
  keys: RunnerConfigKey[];
}

/**
 * Reads a stored `config:error` value, sanitising what an older owner (no
 * `keys`) or a hand edit left there: unknown keys are dropped, the rest put in
 * `RUNNER_CONFIG_KEYS` order, and a missing list reads as `[]`. `undefined`
 * when there is no usable error.
 */
export function parseRunnerConfigError(
  raw: string | undefined,
): RunnerConfigError | undefined {
  const error = parseJson<{ at?: unknown; message?: unknown; keys?: unknown }>(
    raw,
  );
  if (
    !error ||
    typeof error !== "object" ||
    typeof error.message !== "string"
  ) {
    return undefined;
  }
  const listed = Array.isArray(error.keys) ? (error.keys as unknown[]) : [];
  return {
    at: Number(error.at) || 0,
    message: error.message,
    keys: RUNNER_CONFIG_KEYS.filter((key) => listed.includes(key)),
  };
}

/** Whether a string names an execution mode. */
export function isExecutionMode(value: string): value is ExecutionMode {
  return (EXECUTION_MODES as readonly string[]).includes(value);
}

/** Whether a string names an overlap policy. */
function isRunMode(value: string): value is "parallel" | "single" {
  return (RUN_MODES as readonly string[]).includes(value);
}

/** Turns a cap into the number the runner gates on; `null` is unlimited. */
export function toRunnerConcurrency(value: number | null): number {
  return value ?? Number.POSITIVE_INFINITY;
}

/** Turns the runner's live cap back into a value that survives JSON. */
export function fromRunnerConcurrency(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Parses a JSON state field, treating anything malformed as absent. */
function parseJson<T>(raw: string | undefined): T | undefined {
  if (raw === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Reads a set of configuration values out of a JSON state field. */
function parseValues(raw: string | undefined): RunnerConfigValues | undefined {
  const parsed = parseJson<Partial<RunnerConfigValues>>(raw);
  if (
    !parsed ||
    typeof parsed.executionMode !== "string" ||
    !isExecutionMode(parsed.executionMode) ||
    typeof parsed.runMode !== "string" ||
    !isRunMode(parsed.runMode)
  ) {
    return undefined;
  }

  return {
    executionMode: parsed.executionMode,
    runMode: parsed.runMode,
    maxConcurrency:
      typeof parsed.maxConcurrency === "number" ? parsed.maxConcurrency : null,
  };
}

/** Reads every `config:*` field out of a runner's state. */
export function readStoredRunnerConfig(
  state: Record<string, string>,
): StoredRunnerConfig {
  const allowed = parseJson<string[]>(state[RUNNER_CONFIG_STATE.allowed])
    ?.filter((mode): mode is ExecutionMode => isExecutionMode(mode))
    .slice();

  const error = parseRunnerConfigError(state[RUNNER_CONFIG_STATE.error]);

  return {
    override: {
      ...(state[RUNNER_CONFIG_STATE.executionMode] !== undefined
        ? { executionMode: state[RUNNER_CONFIG_STATE.executionMode] }
        : {}),
      ...(state[RUNNER_CONFIG_STATE.runMode] !== undefined
        ? { runMode: state[RUNNER_CONFIG_STATE.runMode] }
        : {}),
      ...(state[RUNNER_CONFIG_STATE.maxConcurrency] !== undefined
        ? { maxConcurrency: state[RUNNER_CONFIG_STATE.maxConcurrency] }
        : {}),
    },
    ...(parseValues(state[RUNNER_CONFIG_STATE.code])
      ? { code: parseValues(state[RUNNER_CONFIG_STATE.code]) }
      : {}),
    // Kept when empty: an owner that can adopt no mode override publishes
    // `[]` (see `adoptableExecutionModes`), and dropping it would read as
    // "unknown, so anything goes".
    ...(allowed ? { allowed } : {}),
    seq: Number(state[RUNNER_CONFIG_STATE.seq] ?? 0) || 0,
    ...(state[RUNNER_CONFIG_STATE.appliedSeq] !== undefined
      ? { appliedSeq: Number(state[RUNNER_CONFIG_STATE.appliedSeq]) || 0 }
      : {}),
    ...(state[RUNNER_CONFIG_STATE.appliedAt] !== undefined
      ? { appliedAt: Number(state[RUNNER_CONFIG_STATE.appliedAt]) || 0 }
      : {}),
    ...(error ? { error } : {}),
    ...(state[RUNNER_CONFIG_STATE.updatedAt] !== undefined
      ? { updatedAt: Number(state[RUNNER_CONFIG_STATE.updatedAt]) || 0 }
      : {}),
  };
}

/** Which settings an override is stored for, in the contract's order. */
export function overriddenKeys(
  override: StoredRunnerOverride,
): RunnerConfigKey[] {
  return RUNNER_CONFIG_KEYS.filter(
    (key) => override[key] !== undefined,
  ) as RunnerConfigKey[];
}

/**
 * Whether an owner can actually run in `mode` when an override asks for it:
 * its own code's mode and `in-process` always, and a mode that moves the
 * handler into a child (`spawn`, `worker`) only when the runner has a driver
 * config to hand that child. {@link resolveRunnerConfig} refuses the rest.
 */
function canSwitchTo(
  mode: ExecutionMode,
  codeMode: ExecutionMode,
  hasChildDriver: boolean,
): boolean {
  return mode === codeMode || mode === "in-process" || hasChildDriver;
}

/**
 * The execution modes an owner publishes as `allowed` (`config:allowed`, and
 * `RunnerConfigInfo.allowed`): those its code permits
 * (`allowedOverrides.executionModes`) **and** it can adopt. A runner built from a
 * driver instance has no config for a child, so it leaves out every child
 * mode but its code's own — otherwise a controller, the management API or the
 * UI would accept a value the owner is certain to refuse. May be empty, which
 * means no override of the mode can be adopted at all.
 */
export function adoptableExecutionModes(
  /** The modes the code permits, in canonical order. */
  permitted: readonly ExecutionMode[],
  /** The owner's code's own execution mode. */
  codeMode: ExecutionMode,
  /** Whether the runner can hand a child a driver config. */
  hasChildDriver: boolean,
): ExecutionMode[] {
  return permitted.filter((mode) =>
    canSwitchTo(mode, codeMode, hasChildDriver),
  );
}

/** What {@link resolveRunnerConfig} needs to decide what an owner runs with. */
export interface ResolveRunnerConfigInput {
  /** The override exactly as the state hash holds it. */
  override: StoredRunnerOverride;
  /** What the owner's own options asked for. */
  code: RunnerConfigValues;
  /** The execution modes the owner's code permits. */
  allowed: readonly ExecutionMode[];
  /**
   * Whether the runner can hand a child a driver config (`childDriver`).
   * Without one, `spawn` and `worker` reach no backend at all, so an override
   * asking for either is refused rather than silently breaking the handler.
   */
  hasChildDriver: boolean;
}

/**
 * Decides what an owner runs with, dropping any override field it cannot
 * honour rather than refusing to run.
 *
 * A dropped field falls back to the code's value and is reported in
 * `refusals`, which the owner records as `config:error`. The checks are the
 * ones an owner can actually make: the value is one of the enumeration, it is
 * inside `RUNNER_CONFIG_BOUNDS`, the code permits the execution mode, and the
 * runner can reach its backend from the mode asked for. Everything else —
 * a handler that only works in one mode — shows up as a failed first run.
 */
export function resolveRunnerConfig(
  input: ResolveRunnerConfigInput,
): ResolvedRunnerConfig {
  const { override, code, allowed, hasChildDriver } = input;
  const refusals: string[] = [];
  const refused = new Set<RunnerConfigKey>();
  const warnings: string[] = [];
  const refuse = (key: RunnerConfigKey, message: string): void => {
    refusals.push(message);
    refused.add(key);
  };

  let executionMode = code.executionMode;
  const rawMode = override.executionMode;
  if (rawMode !== undefined) {
    if (!isExecutionMode(rawMode)) {
      refuse(
        "executionMode",
        `executionMode "${rawMode}" is not an execution mode`,
      );
    } else if (!allowed.includes(rawMode)) {
      refuse(
        "executionMode",
        `executionMode "${rawMode}" is not one this runner's code permits (${allowed.join(", ")})`,
      );
    } else if (!canSwitchTo(rawMode, code.executionMode, hasChildDriver)) {
      // A runner built from a driver *instance* has no config to hand a
      // child, so a handler moved out of this process reaches no backend.
      refuse(
        "executionMode",
        `executionMode "${rawMode}" needs a driver config for the child, and this runner was built from a driver instance`,
      );
    } else {
      if (
        rawMode !== "in-process" &&
        code.executionMode === "in-process" &&
        hasChildDriver
      ) {
        warnings.push(
          `executionMode "${rawMode}" runs the handler outside this process, so ctx.driver is no longer available to it`,
        );
      }
      executionMode = rawMode;
    }
  }

  let runMode = code.runMode;
  const rawRunMode = override.runMode;
  if (rawRunMode !== undefined) {
    if (isRunMode(rawRunMode)) {
      runMode = rawRunMode;
    } else {
      refuse("runMode", `runMode "${rawRunMode}" is not an overlap policy`);
    }
  }

  let maxConcurrency = code.maxConcurrency;
  const rawConcurrency = override.maxConcurrency;
  if (rawConcurrency !== undefined) {
    const bounds = RUNNER_CONFIG_BOUNDS.maxConcurrency;
    const parsed = Number(rawConcurrency);
    if (rawConcurrency === UNLIMITED_CONCURRENCY) {
      maxConcurrency = null;
    } else if (
      !Number.isInteger(parsed) ||
      parsed < bounds.min ||
      parsed > bounds.max
    ) {
      refuse(
        "maxConcurrency",
        `maxConcurrency "${rawConcurrency}" is not a whole number between ${bounds.min} and ${bounds.max}`,
      );
    } else {
      maxConcurrency = parsed;
    }
  }

  return {
    effective: { executionMode, runMode, maxConcurrency },
    overridden: overriddenKeys(override),
    refusals,
    refusedKeys: RUNNER_CONFIG_KEYS.filter((key) => refused.has(key)),
    warnings,
  };
}

/** Options for {@link runnerConfigFields}. */
export interface RunnerConfigFieldsOptions {
  /**
   * The execution modes the owner's code permits. A patch asking for one
   * outside it is rejected here, before anything is written; `undefined`
   * means the allow-list is unknown, so only the enumeration is checked.
   */
  allowed?: readonly ExecutionMode[];
}

/**
 * Turns a patch into the state fields that store it, rejecting anything the
 * owner would only have to drop again.
 *
 * `null` clears an override, so the field is written as `null` (a delete).
 * `concurrency` writes `runMode` and `maxConcurrency` together, because a cap
 * means nothing without the policy it bounds.
 *
 * @throws ConfigError with `context.reason` — `"empty"`, `"invalid"` or
 * `"not-allowed"` — so a caller can map it to the right status.
 */
export function runnerConfigFields(
  patch: RunnerConfigPatch,
  options: RunnerConfigFieldsOptions = {},
): Record<string, string | null> {
  const fields: Record<string, string | null> = {};

  if ("executionMode" in patch) {
    const mode = patch.executionMode;
    if (mode === null) {
      fields[RUNNER_CONFIG_STATE.executionMode] = null;
    } else if (mode !== undefined) {
      if (!isExecutionMode(mode)) {
        throw new ConfigError(
          `executionMode must be one of ${EXECUTION_MODES.join(", ")}`,
          { reason: "invalid", field: "executionMode", executionMode: mode },
        );
      }
      if (options.allowed && !options.allowed.includes(mode)) {
        throw new ConfigError(
          `This runner's code does not permit executionMode "${mode}"`,
          {
            reason: "not-allowed",
            field: "executionMode",
            executionMode: mode,
            allowed: [...options.allowed],
          },
        );
      }
      fields[RUNNER_CONFIG_STATE.executionMode] = mode;
    }
  }

  if ("concurrency" in patch) {
    const concurrency = patch.concurrency;
    if (concurrency === null) {
      fields[RUNNER_CONFIG_STATE.runMode] = null;
      fields[RUNNER_CONFIG_STATE.maxConcurrency] = null;
    } else if (concurrency !== undefined) {
      if (!isRunMode(concurrency.runMode)) {
        throw new ConfigError('runMode must be "single" or "parallel"', {
          reason: "invalid",
          field: "runMode",
          runMode: concurrency.runMode,
        });
      }
      fields[RUNNER_CONFIG_STATE.runMode] = concurrency.runMode;
      if (concurrency.runMode === "single") {
        // A cap bounds overlap, and `single` has none: storing one would only
        // show up as an override of a setting nothing reads.
        fields[RUNNER_CONFIG_STATE.maxConcurrency] = null;
      } else {
        fields[RUNNER_CONFIG_STATE.maxConcurrency] = storeConcurrency(
          concurrency.maxConcurrency,
        );
      }
    }
  }

  if (Object.keys(fields).length === 0) {
    throw new ConfigError(
      "A runner configuration patch must set executionMode or concurrency",
      { reason: "empty" },
    );
  }

  return fields;
}

/** Validates a cap and spells it for storage; `null` is unlimited. */
function storeConcurrency(value: number | null): string {
  if (value === null) {
    return UNLIMITED_CONCURRENCY;
  }

  const bounds = RUNNER_CONFIG_BOUNDS.maxConcurrency;
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigError(
      `maxConcurrency must be a whole number between ${bounds.min} and ${bounds.max}, or null for unlimited`,
      {
        reason: "invalid",
        field: "maxConcurrency",
        maxConcurrency: value,
        bounds,
      },
    );
  }
  return String(value);
}

/** The fields a reset writes: every override cleared. */
export function runnerConfigResetFields(): Record<string, string | null> {
  return {
    [RUNNER_CONFIG_STATE.executionMode]: null,
    [RUNNER_CONFIG_STATE.runMode]: null,
    [RUNNER_CONFIG_STATE.maxConcurrency]: null,
  };
}

/**
 * Stores an override and bumps its version, returning the new version.
 *
 * The fields are written **before** the version, deliberately. An owner that
 * reads between the two sees the new values under the old version, adopts
 * them and re-adopts at the next version; the other order would let it record
 * the new version against the old values and never look again.
 */
export async function writeRunnerConfig(
  driver: JobsDriver,
  namespace: string,
  key: string,
  fields: Record<string, string | null>,
): Promise<number> {
  await driver.setState(namespace, key, {
    ...fields,
    [RUNNER_CONFIG_STATE.updatedAt]: Date.now(),
    updatedAt: Date.now(),
  });

  const counters = await driver.incrementCounters(namespace, key, {
    [RUNNER_CONFIG_STATE.seq]: 1,
  });

  return counters[RUNNER_CONFIG_STATE.seq] ?? 0;
}

/**
 * What a controller can say about a runner's configuration from what its
 * owner persisted.
 *
 * `undefined` when no owner has written `config:code` — a deployment that
 * predates remote configuration would store an override and never adopt it,
 * so a caller is better told it cannot configure this runner than lied to.
 */
export function describeRunnerConfig(
  state: Record<string, string>,
): RunnerConfigInfo | undefined {
  const stored = readStoredRunnerConfig(state);
  if (!stored.code) {
    return undefined;
  }

  const rawEffectiveMode = state.executionMode;
  const rawEffectiveRunMode = state.runMode;
  const rawEffectiveCap = state.maxConcurrency;
  const parsedCap = Number(rawEffectiveCap);

  return {
    effective: {
      executionMode:
        rawEffectiveMode !== undefined && isExecutionMode(rawEffectiveMode)
          ? rawEffectiveMode
          : stored.code.executionMode,
      runMode:
        rawEffectiveRunMode !== undefined && isRunMode(rawEffectiveRunMode)
          ? rawEffectiveRunMode
          : stored.code.runMode,
      maxConcurrency:
        rawEffectiveCap !== undefined && Number.isFinite(parsedCap)
          ? parsedCap
          : rawEffectiveCap !== undefined
            ? null
            : stored.code.maxConcurrency,
    },
    code: stored.code,
    overridden: overriddenKeys(stored.override),
    ...(stored.allowed ? { allowed: stored.allowed } : {}),
    seq: stored.seq,
    ...(stored.appliedSeq !== undefined
      ? { appliedSeq: stored.appliedSeq }
      : {}),
    ...(stored.error ? { error: stored.error } : {}),
    ...(stored.updatedAt !== undefined ? { updatedAt: stored.updatedAt } : {}),
  };
}
