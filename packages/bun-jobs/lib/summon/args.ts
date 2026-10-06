import type { WorkerSummonProvenance } from "../shared/workers";
import process from "node:process";
import { CHILD_ENV } from "../runner/protocol";
import { ConfigError } from "../shared/errors";
import { isSummonMode, SUMMON_MODES } from "./provenance";

/**
 * The command-line arguments a summon passes and {@link summonedFromArgs}
 * reads, each written `--bun-jobs-summon-<key>=<value>` (the `=` form only).
 *
 * **Arguments, never environment variables.** An environment leaks to every
 * descendant: `Bun.spawn` with no `env` hands a child the environment the
 * process *started* with, ignoring the live `process.env`, so deleting a
 * variable after reading it does not stop it (measured on Bun 1.4.3). Any
 * child a processor or user code spawned would then claim the summoned
 * worker's attempt. Arguments are not inherited by a spawned process, and
 * Bun gives a `Worker` thread an empty `argv` too (unlike Node, which copies
 * the parent's). So a summon's identity reaches the one process it was
 * addressed to.
 */
export const SUMMON_ARGS = {
  /** The summon attempt's id. Required: without it a process is not summoned. Comes back as `summon.id`. */
  id: "--bun-jobs-summon-id",
  /** The summoner's kind, e.g. `ecs`; comes back as `summon.kind`. */
  kind: "--bun-jobs-summon-kind",
  /** The mode the summoner requests: `exit-on-idle`, `until-stopped` or `in-invocation`. Absent means none requested. */
  mode: "--bun-jobs-summon-mode",
  /** The namespace the summoned worker should consume. */
  namespace: "--bun-jobs-summon-namespace",
  /**
   * A queue the summoned unit should consume. **Repeated once per queue**, in
   * the policy's order, for a unit that serves several queues; written once
   * for one queue. Comes back as `summon.queues`, and the first as
   * `summon.queue`.
   */
  queue: "--bun-jobs-summon-queue",
  /**
   * The summon group the unit was started for, written only when it serves
   * more than one queue. Comes back as `summon.group`, and is written on the
   * worker's record.
   */
  group: "--bun-jobs-summon-group",
  /** The longest the worker may live, as a duration in ms (never a timestamp). */
  maxLifetimeMs: "--bun-jobs-summon-max-lifetime-ms",
  /** The platform's grace after its stop signal, in ms, when the summoner knows it. */
  graceMs: "--bun-jobs-summon-grace-ms",
} as const;

/**
 * One argument's value: the last `--name=value` for `name`, or `undefined`.
 * An empty value counts as absent.
 */
function read(name: string, argv: readonly string[]): string | undefined {
  const prefix = `${name}=`;
  for (let index = argv.length - 1; index >= 0; index--) {
    const arg = argv[index];
    if (arg?.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/**
 * Every value of a repeated argument, in order: each `--name=value`, with
 * empty values skipped and repeats dropped (the first occurrence keeps its
 * place).
 */
function readAll(name: string, argv: readonly string[]): string[] {
  const prefix = `${name}=`;
  const values: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (value !== "" && !values.includes(value)) {
        values.push(value);
      }
    }
  }
  return values;
}

/** A duration argument: absent, or a non-negative whole number of ms. */
function duration(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
    throw new ConfigError(
      `${name} must be a whole number of milliseconds (a duration, not a timestamp)`,
      { [name]: raw },
    );
  }
  return value;
}

/** What {@link summonedFromArgs} answers for a summoned process. */
export type SummonedArgs = WorkerSummonProvenance & {
  /** `--bun-jobs-summon-namespace`: the namespace to consume. Not written on the record. */
  namespace?: string;
  /**
   * `--bun-jobs-summon-queue`: the queue to consume, or for a unit serving
   * several queues the first of them (`queues[0]`). Not written on the
   * record.
   */
  queue?: string;
  /**
   * Every `--bun-jobs-summon-queue` in the order the summon passed them, with
   * repeats dropped: the queues this unit should run a worker for, one
   * worker per queue (`runSummoned`). `[queue]` for one queue; absent when
   * the summon named none. Not written on the record.
   */
  queues?: readonly string[];
  /** `--bun-jobs-summon-max-lifetime-ms`: the longest the worker may live, in ms. Not written on the record. */
  maxLifetimeMs?: number;
  /** `--bun-jobs-summon-grace-ms`: the platform's grace after its stop signal, in ms. Not written on the record. */
  graceMs?: number;
};

/**
 * The parsing half of {@link summonedFromArgs}, with the runner-child marker
 * passed in rather than read, so each layer can be tested on its own.
 * Internal.
 */
export function parseSummonArgs(
  /** The command line to read. */
  argv: readonly string[],
  /** `BUN_JOBS_CHILD` as this process sees it; `"1"` refuses provenance. */
  childMarker: string | undefined,
): SummonedArgs | undefined {
  // Refuse only, never grant: see `summonedFromArgs`.
  if (childMarker === "1") {
    return undefined;
  }

  const id = read(SUMMON_ARGS.id, argv);
  if (id === undefined) {
    return undefined;
  }

  const kind = read(SUMMON_ARGS.kind, argv);
  const rawMode = read(SUMMON_ARGS.mode, argv);
  if (rawMode !== undefined && !isSummonMode(rawMode)) {
    throw new ConfigError(
      `${SUMMON_ARGS.mode} must be one of ${SUMMON_MODES.join(", ")}`,
      { [SUMMON_ARGS.mode]: rawMode },
    );
  }
  const namespace = read(SUMMON_ARGS.namespace, argv);
  const group = read(SUMMON_ARGS.group, argv);
  // Every queue, in order: a unit serving several queues gets one argument
  // per queue. With one, this is the single value `read` would give.
  const queues = readAll(SUMMON_ARGS.queue, argv);
  const maxLifetimeMs = duration(
    SUMMON_ARGS.maxLifetimeMs,
    read(SUMMON_ARGS.maxLifetimeMs, argv),
  );
  const graceMs = duration(
    SUMMON_ARGS.graceMs,
    read(SUMMON_ARGS.graceMs, argv),
  );

  return {
    id,
    ...(kind === undefined ? {} : { kind }),
    ...(rawMode === undefined ? {} : { mode: rawMode }),
    ...(maxLifetimeMs === undefined
      ? {}
      : { deadlineAt: Date.now() + maxLifetimeMs, maxLifetimeMs }),
    ...(group === undefined ? {} : { group }),
    ...(namespace === undefined ? {} : { namespace }),
    ...(queues.length === 0
      ? {}
      : { queue: queues[0]!, queues: Object.freeze(queues) }),
    ...(graceMs === undefined ? {} : { graceMs }),
  };
}

/**
 * The summon provenance on this process's command line, or `undefined` when
 * this process was not summoned. Pass it straight to a worker:
 *
 * ```ts
 * const summon = summonedFromArgs();
 * const worker = jobs.worker(summon?.queue ?? "emails", handlers, { summon });
 * ```
 *
 * A unit summoned for several queues (a summon group with a shared unit)
 * gets one `--bun-jobs-summon-queue=` per queue: `queues` lists them in
 * order, and `queue` is the first. Build one worker per queue.
 *
 * - **Reads only `--bun-jobs-summon-*=` arguments** ({@link SUMMON_ARGS}),
 *   never an environment variable for provenance: an environment leaks to
 *   every descendant, arguments do not (see {@link SUMMON_ARGS}).
 * - **Summoned means a summon id.** Without `--bun-jobs-summon-id=` the
 *   answer is `undefined`, whatever other summon arguments say.
 * - **Nothing is defaulted.** `mode` is present only when the summoner
 *   requested one; `deadlineAt` only when it passed a maximum lifetime, and
 *   is then computed here, on this process's clock, as now + that duration.
 *   `handle` is never read: a worker that knows its platform handle passes
 *   it itself (`{ ...summon, handle }`).
 * - **Call it in the main thread.** Bun gives a `Worker` thread an empty
 *   `argv`, so inside one this answers `undefined`. Build the workers in the
 *   main thread and pass `summon` to them; a worker's `target` option runs
 *   its jobs in threads without moving the worker itself.
 * - **`undefined` inside a runner child**, whatever the arguments say. A
 *   runner's or worker target's child process or `Worker` is marked
 *   `BUN_JOBS_CHILD=1` (`CHILD_ENV.marker`), and that is the one variable
 *   read — **only to refuse provenance, never to grant it**, so it cannot
 *   reintroduce the leak. It is defence in depth: a `Worker` thread runs in
 *   its parent's process, and today Bun gives it an empty `argv`, but Node
 *   copies the parent's, and bun-jobs does not rely on that behaviour alone.
 *   It also keeps a runner child's own arguments from reading as a summon.
 *
 * @throws {ConfigError} when a summon argument is malformed (an unknown mode,
 *   a duration that is not a whole number): a misconfigured summon fails at
 *   startup rather than recording nonsense.
 */
export function summonedFromArgs(
  /** The command line to read. Defaults to `process.argv`. */
  argv: readonly string[] = process.argv,
): SummonedArgs | undefined {
  return parseSummonArgs(argv, process.env[CHILD_ENV.marker]);
}
