import type { WorkerSummonProvenance } from "../shared/workers";
import process from "node:process";
import { CHILD_ENV } from "../runner/protocol";
import { ConfigError } from "../shared/errors";
import { isSummonMode, SUMMON_MODES } from "./provenance";

/**
 * The environment keys a summon passes and {@link summonedFromEnv} reads.
 *
 * Every key is under `BUN_JOBS_SUMMON_*`, never a bare `BUN_JOBS_*`:
 * `BUN_JOBS_NAMESPACE` is already `CHILD_ENV.namespace`, set on every runner
 * and worker-target child, so a summon key must never be mistaken for a
 * runner-child one. A platform that passes only a command line gives the
 * same values as `--bun-jobs-summon-<key>=<value>` arguments, the key
 * lower-cased with `-` for `_` (`--bun-jobs-summon-id=…`).
 */
export const SUMMON_ENV = {
  /** The summon attempt's id; comes back on the heartbeat record as `summon.id`. */
  id: "BUN_JOBS_SUMMON_ID",
  /** The summoner's kind, e.g. `ecs`; comes back as `summon.kind`. */
  kind: "BUN_JOBS_SUMMON_KIND",
  /** `exit-on-idle` (the default when unset), `until-stopped` or `in-invocation`. */
  mode: "BUN_JOBS_SUMMON_MODE",
  /** The namespace the summoned worker should consume. */
  namespace: "BUN_JOBS_SUMMON_NAMESPACE",
  /** The queue the summoned worker should consume. */
  queue: "BUN_JOBS_SUMMON_QUEUE",
  /** The longest the worker may live, as a duration in ms (never a timestamp). */
  maxLifetimeMs: "BUN_JOBS_SUMMON_MAX_LIFETIME_MS",
  /** The platform's grace after its stop signal, in ms, when the summoner knows it. */
  graceMs: "BUN_JOBS_SUMMON_GRACE_MS",
} as const;

/** The `--bun-jobs-summon-*=` argument prefix a key is also read from. */
function argvPrefix(key: string): string {
  return `--${key.toLowerCase().replaceAll("_", "-")}=`;
}

/**
 * One key's value: the environment first, then the matching argument (the
 * last one, when repeated). An empty string counts as unset.
 */
function read(
  key: string,
  env: Record<string, string | undefined>,
  argv: readonly string[],
): string | undefined {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const prefix = argvPrefix(key);
  for (let index = argv.length - 1; index >= 0; index--) {
    const arg = argv[index]!;
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/** A duration key: absent, or a non-negative integer number of ms. */
function duration(key: string, raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
    throw new ConfigError(
      `${key} must be a whole number of milliseconds (a duration, not a timestamp)`,
      { [key]: raw },
    );
  }
  return value;
}

/**
 * The summon provenance in the environment and command line, or `undefined`
 * when this process was not summoned. Pass it straight to a worker:
 *
 * ```ts
 * const summon = summonedFromEnv();
 * const worker = jobs.worker(summon?.queue ?? "emails", handlers, { summon });
 * ```
 *
 * - **Reads only `BUN_JOBS_SUMMON_*`** ({@link SUMMON_ENV}) and the matching
 *   `--bun-jobs-summon-*=` arguments; the environment wins over an argument.
 *   A process is summoned when at least one of those keys is set (non-empty).
 * - **`undefined` inside a runner child**, whatever the keys say. A runner's
 *   child process or `Worker`, and a worker target's, inherits its parent's
 *   environment — summon keys included — and is marked with
 *   `CHILD_ENV.marker` (`BUN_JOBS_CHILD=1`). The child was started by the
 *   runner, not summoned, and must not claim the parent's attempt.
 * - `mode` defaults to `"exit-on-idle"` when unset. `deadlineAt` is computed
 *   here, from this process's clock, as now + `BUN_JOBS_SUMMON_MAX_LIFETIME_MS`.
 * - `handle` is never read from the environment: the platform variables that
 *   would carry it are unverified per platform, so a worker that knows its
 *   handle passes it itself (`{ ...summon, handle }`).
 *
 * @throws {ConfigError} when a key is set to something malformed (an unknown
 *   mode, a duration that is not a whole number): a misconfigured summon
 *   fails at startup rather than recording nonsense.
 */
export function summonedFromEnv(
  /** Where to read the keys. Defaults to `process.env`. */
  env: Record<string, string | undefined> = process.env,
  /** The command line to read `--bun-jobs-summon-*=` from. Defaults to `process.argv`. */
  argv: readonly string[] = process.argv,
):
  | (WorkerSummonProvenance & {
      /** `BUN_JOBS_SUMMON_NAMESPACE`: the namespace to consume. Not written on the record. */
      namespace?: string;
      /** `BUN_JOBS_SUMMON_QUEUE`: the queue to consume. Not written on the record. */
      queue?: string;
      /** `BUN_JOBS_SUMMON_MAX_LIFETIME_MS`: the longest the worker may live, in ms. Not written on the record. */
      maxLifetimeMs?: number;
      /** `BUN_JOBS_SUMMON_GRACE_MS`: the platform's grace after its stop signal, in ms. Not written on the record. */
      graceMs?: number;
    })
  | undefined {
  if (env[CHILD_ENV.marker] === "1") {
    return undefined;
  }

  const raw = {
    id: read(SUMMON_ENV.id, env, argv),
    kind: read(SUMMON_ENV.kind, env, argv),
    mode: read(SUMMON_ENV.mode, env, argv),
    namespace: read(SUMMON_ENV.namespace, env, argv),
    queue: read(SUMMON_ENV.queue, env, argv),
    maxLifetimeMs: read(SUMMON_ENV.maxLifetimeMs, env, argv),
    graceMs: read(SUMMON_ENV.graceMs, env, argv),
  };
  if (Object.values(raw).every((value) => value === undefined)) {
    return undefined;
  }

  const mode = raw.mode ?? "exit-on-idle";
  if (!isSummonMode(mode)) {
    throw new ConfigError(
      `${SUMMON_ENV.mode} must be one of ${SUMMON_MODES.join(", ")}`,
      { [SUMMON_ENV.mode]: raw.mode },
    );
  }
  const maxLifetimeMs = duration(SUMMON_ENV.maxLifetimeMs, raw.maxLifetimeMs);
  const graceMs = duration(SUMMON_ENV.graceMs, raw.graceMs);

  return {
    ...(raw.id === undefined ? {} : { id: raw.id }),
    ...(raw.kind === undefined ? {} : { kind: raw.kind }),
    mode,
    ...(maxLifetimeMs === undefined
      ? {}
      : { deadlineAt: Date.now() + maxLifetimeMs, maxLifetimeMs }),
    ...(raw.namespace === undefined ? {} : { namespace: raw.namespace }),
    ...(raw.queue === undefined ? {} : { queue: raw.queue }),
    ...(graceMs === undefined ? {} : { graceMs }),
  };
}
