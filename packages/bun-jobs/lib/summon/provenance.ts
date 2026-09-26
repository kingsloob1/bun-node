import type { WorkerSummonProvenance } from "../shared/workers";
import { ConfigError } from "../shared/errors";

/**
 * A summoned worker's provenance: the modes a summoner can request, and the
 * check `BunQueueWorker`'s constructor applies to its `summon` option.
 *
 * Internal. The public names are `WorkerSummonProvenance` (the shape) and
 * `summonedFromArgs()` (the usual way to build one).
 */

/**
 * The modes a summoner can request, in the order a reader should list them.
 * Internal: the public spelling is `WorkerSummonProvenance["mode"]`.
 */
export const SUMMON_MODES = [
  "exit-on-idle",
  "until-stopped",
  "in-invocation",
] as const satisfies readonly NonNullable<WorkerSummonProvenance["mode"]>[];

/** Whether `value` is one of {@link SUMMON_MODES}. */
export function isSummonMode(
  value: unknown,
): value is NonNullable<WorkerSummonProvenance["mode"]> {
  return (
    typeof value === "string" &&
    (SUMMON_MODES as readonly string[]).includes(value)
  );
}

/** A string field of the provenance: absent, or a non-empty string. */
function optionalText(
  summon: Record<string, unknown>,
  field: "kind" | "handle",
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
 * whatever object the caller passed (`summonedFromArgs()` adds `namespace`,
 * `queue`, `maxLifetimeMs` and `graceMs`, which must not reach the record).
 *
 * `undefined` stays `undefined`: an ordinary worker writes no `summon`. And
 * nothing inside one is defaulted either: a `mode` or `deadlineAt` the
 * summoner did not request stays absent.
 *
 * @throws {ConfigError} on a malformed value (`id` is required: it is what
 *   makes a worker summoned), and when the worker could never report — with
 *   `reportInterval: 0`, or on a driver that cannot store worker records —
 *   since then it could never release its attempt.
 */
export function resolveSummonProvenance(
  /** The worker's `summon` option, as given. */
  summon: WorkerSummonProvenance | undefined,
  /** The worker's resolved `reportInterval`, in ms; `0` means it never reports. */
  reportInterval: number,
  /** Whether the worker's driver can store worker records (`supportsWorkers`). */
  storesWorkers: boolean,
): Readonly<WorkerSummonProvenance> | undefined {
  if (summon === undefined) {
    return undefined;
  }
  if (typeof summon !== "object" || summon === null || Array.isArray(summon)) {
    throw new ConfigError(
      "summon must be the object summonedFromArgs() returns, or undefined",
      { summon },
    );
  }
  if (reportInterval === 0) {
    throw new ConfigError(
      "summon needs a heartbeat record: with reportInterval 0 the worker never reports, so the summon attempt it came from can never be released",
      { reportInterval },
    );
  }
  if (!storesWorkers) {
    throw new ConfigError(
      "summon needs a heartbeat record: this driver cannot store worker records, so the summon attempt the worker came from can never be released",
    );
  }

  const given = summon as unknown as Record<string, unknown>;
  const id = given.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new ConfigError(
      "summon.id must be a non-empty string: the attempt id is what makes a worker summoned",
      { id },
    );
  }

  const mode = given.mode;
  if (mode !== undefined && !isSummonMode(mode)) {
    throw new ConfigError(
      `summon.mode must be one of ${SUMMON_MODES.map((one) => `"${one}"`).join(", ")} when given`,
      { mode },
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
  const kind = optionalText(given, "kind");
  const handle = optionalText(given, "handle");

  return Object.freeze({
    id,
    ...(kind === undefined ? {} : { kind }),
    ...(handle === undefined ? {} : { handle }),
    ...(mode === undefined ? {} : { mode }),
    ...(deadline === undefined ? {} : { deadlineAt: deadline }),
  });
}
