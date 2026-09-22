import type {
  ExecutionModeDto,
  RunnerConfigBody,
  RunnerConfigDto,
  RunnerConfigKey,
  RunnerConfigValues,
} from "../../../api/types";
import { EXECUTION_MODES, RUNNER_CONFIG_BOUNDS } from "../../../api/contract";
import { formatNumber } from "../../../format";

/**
 * The runner configuration editor's pure half: the form value behind
 * "Settings…", its prefill from `RunnerInfoDto.config`, its validation, the
 * `PUT /runners/:runner/config` **merge patch** it becomes, and the warnings
 * the API asks the UI to surface.
 *
 * The API stays the authority — it answers 409 `CONFIG_NOT_ALLOWED` for a
 * mode the runner's code does not permit, and an owner may still refuse an
 * override it has not adopted (`RunnerConfigDto.error`). This catches what
 * can be caught before sending, and says what a change will and will not do.
 */

/**
 * Every execution mode, in the order the picker offers them: the contract's
 * own list, so a mode the API gains reaches the picker without an edit here.
 * `EXECUTION_MODE_LABELS` is keyed by it, so a new one is a compile error
 * until it is given words.
 */
export { EXECUTION_MODES };

/** What each execution mode means, for the picker's hint. */
export const EXECUTION_MODE_LABELS: Readonly<Record<ExecutionModeDto, string>> =
  {
    spawn: "spawn — a child process per run",
    worker: "worker — a Worker thread per run",
    "in-process": "in-process — in the runner's own process",
  };

/** The two overlap policies, in the order the picker offers them. */
export const RUN_MODES: readonly {
  /** The value sent. */
  value: RunnerConfigValues["runMode"];
  /** The text shown. */
  label: string;
}[] = [
  { value: "parallel", label: "parallel — runs may overlap" },
  { value: "single", label: "single — one run at a time, cluster-wide" },
];

/**
 * The inclusive range a concurrency cap **sent from here** must fall in,
 * straight from the contract, so the field's `min`/`max` are the very numbers
 * the route validates against (400 `VALIDATION`).
 *
 * The ceiling is the API's cap on a remote change, not the runner's: a runner
 * configured in its own code has no ceiling at all, and "unlimited" is
 * `maxConcurrency: null` — an empty field — which is not capped either.
 */
export const CONCURRENCY_BOUNDS = RUNNER_CONFIG_BOUNDS.maxConcurrency;

/** The two keys `RunnerConfigBody.concurrency` sets together. */
export const CONCURRENCY_KEYS: readonly RunnerConfigKey[] = [
  "runMode",
  "maxConcurrency",
];

/** How each key is named on screen. */
export const CONFIG_KEY_LABELS: Readonly<Record<RunnerConfigKey, string>> = {
  executionMode: "Execution mode",
  runMode: "Run mode",
  maxConcurrency: "Max concurrency",
};

/**
 * The editor's state. Each of the two patch fields carries its own "is this
 * an override?" flag, because clearing an override (`null`) and setting one
 * are different writes; the values stay filled in either way, so turning an
 * override back on loses nothing.
 */
export interface ConfigForm {
  /** Whether the execution mode is an override; `false` leaves it to the runner's code. */
  executionModeOverridden: boolean;
  /** The execution mode shown: the override's, or the one in force. */
  executionMode: ExecutionModeDto;
  /** Whether the overlap settings are an override. `runMode` and `maxConcurrency` are one patch field, so they share the flag. */
  concurrencyOverridden: boolean;
  /** Whether runs may overlap. */
  runMode: RunnerConfigValues["runMode"];
  /** The cap in `parallel`, or `undefined` for unlimited. Meaningless in `single`. */
  maxConcurrency: number | undefined;
}

/** Errors per form field. */
export interface ConfigErrors {
  /** Why the cap is unusable. */
  maxConcurrency?: string;
}

/** Whether `config` overrides either of the two overlap settings. */
export function isConcurrencyOverridden(config: RunnerConfigDto): boolean {
  return CONCURRENCY_KEYS.some((key) => config.overridden.includes(key));
}

/** The form for a runner's stored configuration. */
export function formFromConfig(config: RunnerConfigDto): ConfigForm {
  return {
    executionModeOverridden: config.overridden.includes("executionMode"),
    executionMode: config.effective.executionMode,
    concurrencyOverridden: isConcurrencyOverridden(config),
    runMode: config.effective.runMode,
    maxConcurrency: config.effective.maxConcurrency ?? undefined,
  };
}

/**
 * The values the runner would use once `form` is saved and adopted: an
 * overridden key takes the form's value, one left to the code takes `code`'s
 * (falling back to what is in force, for an API that does not send `code`).
 */
export function targetValues(
  form: ConfigForm,
  config: RunnerConfigDto,
): RunnerConfigValues {
  const fromCode = config.code ?? config.effective;
  return {
    executionMode: form.executionModeOverridden
      ? form.executionMode
      : fromCode.executionMode,
    runMode: form.concurrencyOverridden ? form.runMode : fromCode.runMode,
    maxConcurrency: form.concurrencyOverridden
      ? (form.maxConcurrency ?? null)
      : fromCode.maxConcurrency,
  };
}

/** What the runner's own code asks for, when the API said; `null` otherwise. */
export function codeValue(
  config: RunnerConfigDto,
  key: RunnerConfigKey,
): string | null {
  if (config.code === undefined) {
    return null;
  }
  if (key === "maxConcurrency") {
    return describeCap(config.code.maxConcurrency);
  }
  return config.code[key];
}

/** A cap in words: a number, or "unlimited" for `null`/`undefined`. */
export function describeCap(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "unlimited"
    : formatNumber(value);
}

/** What holds the form back, per field. */
export function validateConfigForm(form: ConfigForm): ConfigErrors {
  if (!form.concurrencyOverridden || form.runMode !== "parallel") {
    return {};
  }
  const cap = form.maxConcurrency;
  if (cap === undefined) {
    return {};
  }
  if (!Number.isInteger(cap)) {
    return {
      maxConcurrency: "A whole number of runs, or empty for unlimited.",
    };
  }
  if (cap < CONCURRENCY_BOUNDS.min || cap > CONCURRENCY_BOUNDS.max) {
    return {
      maxConcurrency: `Between ${CONCURRENCY_BOUNDS.min} and ${formatNumber(CONCURRENCY_BOUNDS.max)}, or empty for unlimited.`,
    };
  }
  return {};
}

/**
 * The `PUT /runners/:runner/config` body: **only what changed**, since the
 * route is a merge patch. A key whose override is being dropped is sent as
 * `null`; an unchanged one is left out entirely. An empty object means there
 * is nothing to save.
 */
export function configBody(
  form: ConfigForm,
  config: RunnerConfigDto,
): RunnerConfigBody {
  const stored = formFromConfig(config);
  const body: RunnerConfigBody = {};
  if (
    form.executionModeOverridden !== stored.executionModeOverridden ||
    (form.executionModeOverridden &&
      form.executionMode !== stored.executionMode)
  ) {
    body.executionMode = form.executionModeOverridden
      ? form.executionMode
      : null;
  }
  const capChanged =
    form.runMode === "parallel" &&
    form.maxConcurrency !== stored.maxConcurrency;
  if (
    form.concurrencyOverridden !== stored.concurrencyOverridden ||
    (form.concurrencyOverridden &&
      (form.runMode !== stored.runMode || capChanged))
  ) {
    body.concurrency = !form.concurrencyOverridden
      ? null
      : form.runMode === "single"
        ? { runMode: "single" }
        : {
            runMode: "parallel",
            maxConcurrency: form.maxConcurrency ?? null,
          };
  }
  return body;
}

/** Whether `form` differs from what is stored, i.e. whether there is anything to send. */
export function hasConfigChanges(
  form: ConfigForm,
  config: RunnerConfigDto,
): boolean {
  return Object.keys(configBody(form, config)).length > 0;
}

/** One thing a change will (or will not) do, shown before it is saved. */
export interface ConfigWarning {
  /** A stable id, also the note's `data-testid` suffix. */
  id: "execution-mode" | "to-single" | "lower-concurrency";
  /** The sentence shown. */
  message: string;
}

/**
 * What the API asks the UI to say about a pending change. All three are
 * about *when* a change takes hold, never whether it is accepted:
 *
 * - an execution mode applies from the next run, since a run in flight keeps
 *   the mode it started with;
 * - `parallel` → `single` is not immediate across processes, because a
 *   parallel run holds no lock;
 * - a lowered cap gates new runs only.
 */
export function configWarnings(
  form: ConfigForm,
  config: RunnerConfigDto,
): ConfigWarning[] {
  const target = targetValues(form, config);
  const current = config.effective;
  const warnings: ConfigWarning[] = [];
  if (target.executionMode !== current.executionMode) {
    warnings.push({
      id: "execution-mode",
      message: `A run already in flight keeps the mode it started with, so ${target.executionMode} applies from the next run.`,
    });
  }
  if (current.runMode === "parallel" && target.runMode === "single") {
    warnings.push({
      id: "to-single",
      message:
        "Switching from parallel to single is not immediate across processes: a parallel run holds no lock, so overlap can persist for as long as the longest run in flight, plus however long an owner takes to adopt the change. Pause the runner first if exclusivity matters.",
    });
  }
  const before = current.maxConcurrency ?? Infinity;
  const after = target.maxConcurrency ?? Infinity;
  if (target.runMode === "parallel" && after < before) {
    warnings.push({
      id: "lower-concurrency",
      message: `Lowering the cap from ${describeCap(current.maxConcurrency)} to ${describeCap(target.maxConcurrency)} only gates new runs: runs already in flight keep going.`,
    });
  }
  return warnings;
}

/**
 * The stored override an owner has not picked up yet (`appliedSeq` below
 * `seq`), or `null` when everything in force is adopted. An API that sends no
 * `appliedSeq` has nothing adopted, so a stored override counts as pending.
 */
export function pendingAdoption(
  config: RunnerConfigDto,
): { applied: number; seq: number } | null {
  const applied = config.appliedSeq ?? 0;
  return config.seq > 0 && applied < config.seq
    ? { applied, seq: config.seq }
    : null;
}

/** The execution modes this runner's code does not permit; `[]` when it permits all of them. */
export function unavailableModes(config: RunnerConfigDto): ExecutionModeDto[] {
  const allowed = config.allowed;
  return allowed === undefined
    ? []
    : EXECUTION_MODES.filter((mode) => !allowed.includes(mode));
}

/** The execution modes to offer: the runner's `allowed`, else all three. */
export function availableModes(config: RunnerConfigDto): ExecutionModeDto[] {
  const allowed = config.allowed;
  return allowed === undefined
    ? [...EXECUTION_MODES]
    : EXECUTION_MODES.filter((mode) => allowed.includes(mode));
}

/**
 * Which settings are overridden, in words: `"None: as the runner's code
 * asks"`, else the overridden keys' labels. Shown on the runner's summary.
 */
export function describeOverridden(config: RunnerConfigDto): string {
  if (config.overridden.length === 0) {
    return "None: as the runner's code asks";
  }
  return config.overridden
    .map((key) => CONFIG_KEY_LABELS[key] ?? key)
    .join(", ");
}

/**
 * The note beside one summary row: whether that setting is an override, and
 * what the runner's code asks for instead. `undefined` when it is the code's
 * own value, or when the runner reports no configuration at all.
 */
export function describeOverride(
  config: RunnerConfigDto | undefined,
  key: RunnerConfigKey,
): string | undefined {
  if (config === undefined || !config.overridden.includes(key)) {
    return undefined;
  }
  const code = codeValue(config, key);
  // Stored but not in force: the owner reported a refusal and this setting
  // still runs what the code asks for. Saying "Overridden here" would read as
  // an override in effect. (The error does not name its keys, so a refused
  // override is recognised by the value it left in place.)
  if (
    config.error !== undefined &&
    config.code !== undefined &&
    config.effective[key] === config.code[key]
  ) {
    return code === null
      ? "Override refused by the owner; it runs what its code asks for"
      : `Override refused by the owner; it runs what its code asks for, ${code}`;
  }
  return code === null
    ? "Overridden here"
    : `Overridden here; its code asks for ${code}`;
}

/**
 * Where the stored override stands with the owner: waiting to be adopted,
 * refused, or `null` when there is nothing to say. A refusal wins, since it
 * is why nothing was adopted.
 */
export function describeAdoption(config: RunnerConfigDto): string | null {
  if (config.error !== undefined) {
    return `The owner refused these settings: ${config.error.message}`;
  }
  const pending = pendingAdoption(config);
  return pending === null
    ? null
    : `Version ${pending.seq} has not been adopted yet (the owner is on ${pending.applied}); it takes effect at its next sync`;
}
