import type { WorkerSummonProvenance } from "../shared/workers";
import { ConfigError } from "../shared/errors";

/**
 * A summoned worker's provenance: the modes it can run in, and the check
 * `BunQueueWorker`'s constructor applies to its `summon` option.
 *
 * Internal. The public names are `WorkerSummonProvenance` (the shape) and
 * `summonedFromEnv()` (the usual way to build one).
 */

/**
 * The modes a summoned worker runs in, in the order a reader should list
 * them. Internal: the public spelling is `WorkerSummonProvenance["mode"]`.
 */
export const SUMMON_MODES = [
  "exit-on-idle",
  "until-stopped",
  "in-invocation",
] as const satisfies readonly WorkerSummonProvenance["mode"][];

/** Whether `value` is one of {@link SUMMON_MODES}. */
export function isSummonMode(
  value: unknown,
): value is WorkerSummonProvenance["mode"] {
  return (
    typeof value === "string" &&
    (SUMMON_MODES as readonly string[]).includes(value)
  );
}

/** A string field of the provenance: absent, or a non-empty string. */
function optionalText(
  summon: Record<string, unknown>,
  field: "id" | "kind" | "handle",
): string | undefined {
  const value = summon[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(
      `summon.${field} must be a non-empty string when given`,
      { [field]: value },
    );
  }
  return value;
}

/**
 * Checks a worker's `summon` option and copies the five fields the record
 * carries, so the record is written from a resolved value rather than
 * whatever object the caller passed (`summonedFromEnv()` adds `namespace`,
 * `queue`, `maxLifetimeMs` and `graceMs`, which must not reach the record).
 *
 * `undefined` stays `undefined`: an ordinary worker writes no `summon`, and
 * nothing is defaulted.
 *
 * @throws {ConfigError} on a malformed value, and when `reportInterval` is
 *   `0` — a worker that never reports can never release its attempt.
 */
export function resolveSummonProvenance(
  /** The worker's `summon` option, as given. */
  summon: WorkerSummonProvenance | undefined,
  /** The worker's resolved `reportInterval`, in ms; `0` means it never reports. */
  reportInterval: number,
): Readonly<WorkerSummonProvenance> | undefined {
  if (summon === undefined) {
    return undefined;
  }
  if (typeof summon !== "object" || summon === null || Array.isArray(summon)) {
    throw new ConfigError(
      "summon must be the object summonedFromEnv() returns, or undefined",
      { summon },
    );
  }
  if (reportInterval === 0) {
    throw new ConfigError(
      "summon needs a heartbeat record: with reportInterval 0 the worker never reports, so the summon attempt it came from can never be released",
      { reportInterval },
    );
  }

  const given = summon as unknown as Record<string, unknown>;
  if (!isSummonMode(given.mode)) {
    throw new ConfigError(
      `summon.mode must be one of ${SUMMON_MODES.map((mode) => `"${mode}"`).join(", ")}`,
      { mode: given.mode },
    );
  }

  const deadlineAt = given.deadlineAt;
  if (
    deadlineAt !== undefined &&
    (typeof deadlineAt !== "number" ||
      !Number.isSafeInteger(deadlineAt) ||
      deadlineAt < 0)
  ) {
    throw new ConfigError(
      "summon.deadlineAt must be an epoch-ms timestamp (a whole number) when given",
      { deadlineAt },
    );
  }

  // Checked just above: absent, or a non-negative whole number.
  const deadline = deadlineAt as number | undefined;
  const id = optionalText(given, "id");
  const kind = optionalText(given, "kind");
  const handle = optionalText(given, "handle");

  return Object.freeze({
    ...(id === undefined ? {} : { id }),
    ...(kind === undefined ? {} : { kind }),
    ...(handle === undefined ? {} : { handle }),
    mode: given.mode,
    ...(deadline === undefined ? {} : { deadlineAt: deadline }),
  });
}
