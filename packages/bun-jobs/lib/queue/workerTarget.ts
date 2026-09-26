import type { JobRecord } from "../drivers/index";
import type {
  Executor,
  ExecutorHandle,
  IsolatedJobProcessor,
} from "../runner/executors/executor";
import type {
  JobChannelOperation,
  JobChannelReplies,
  JobChannelReply,
  JobChannelRequest,
} from "../runner/protocol";
import type { RunContext, SpawnOptions, WorkerOptions } from "../runner/types";
import type { Logger } from "../shared/logger";
import type { WorkerTargetInfo, WorkerTargetKind } from "../shared/workers";
import type { JobDefinition, JobDefinitions } from "./definitions";
import type { Job } from "./Job";
import type { JobProcessor, ProcessorContext } from "./types";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deserializeError, serializeError } from "@kingsleyweb/bun-common";
import { legacyExecutionModeHint } from "../runner/config";
import { toHandler } from "../runner/executors/executor";
import { SpawnExecutor } from "../runner/executors/spawn";
import { WorkerExecutor } from "../runner/executors/worker";
import { JOB_CHANNEL } from "../runner/protocol";
import {
  DEFAULT_CLOSE_TIMEOUT,
  DEFAULT_KILL_TIMEOUT,
  DEFAULT_START_TIMEOUT,
} from "../shared/constants";
import { ConfigError, UnrecoverableJobError } from "../shared/errors";

/**
 * Where a worker's attempts run: the `target` option.
 *
 * The worker always owns the claim, the lease and the settle; a target moves
 * only the *processor call*. A worker given a *file* rather than a function
 * can run each attempt in a `Worker` or a child process, through the same
 * executors `BunRunner` uses — so a processor that blocks its thread, leaks,
 * or has to be killable for certain does so away from the claim loop, the
 * heartbeats and every other job. The processor file default-exports the
 * same `(job, ctx)` function it would be in-process; `defineProcessor` types
 * it, and `defineProcessors` builds one that dispatches on the job's name.
 *
 * The worker keeps the driver. What a processor in a `Worker` or a child
 * needs of it — its log, its lock — is asked for over the executor's message
 * channel and answered from here, and its progress is written here too.
 * Everything else that would change the stored job directly is unavailable in
 * the child, and says so.
 *
 * Progress is the one of those that is *sent* rather than asked: a child's
 * `job.updateProgress()` does not wait for a reply, so an update costs no
 * round trip however often a processor reports one. What the child's `await`
 * buys instead is ordering, and that is not kept here. Every write a child
 * asks for — its progress, its log lines — goes through the worker's real
 * `Job`, which puts it on the attempt's `AttemptWrites`: one record of what a
 * job has in flight, the same for an attempt in a child and one in the
 * worker's own thread. The worker settles that record before it writes how the
 * job ended, including when it gave up on the run and never came back here at
 * all, and an abort ends the attempt for its writes too — so a value a child
 * sends while it is being stopped is dropped rather than written over a job
 * that has already failed. A custom target ({@link WorkerTargetFactory})
 * writes through the same `Job`, so the same holds for it.
 */

/**
 * The three places this machine can run an attempt: the string form of
 * {@link WorkerTarget}, the `kind` of its object form, and three of the values
 * of the heartbeat record's `target.kind`.
 *
 * The same values as a runner's `ExecutionMode`, by design: one mechanism has
 * one name, and an attempt's `ctx.mode` and `BUN_JOBS_MODE` are the target's
 * own spelling. The two are separate declarations on purpose — they match
 * today and may diverge.
 */
export type WorkerTargetMode = "in-process" | "worker-thread" | "child-process";

/**
 * Where a worker's attempts run: one of the three {@link WorkerTargetMode}s, a
 * {@link LocalWorkerTarget} (the same, with its tuning), or a
 * {@link WorkerTargetFactory} for a target this package does not ship.
 */
export type WorkerTarget =
  | WorkerTargetMode
  | LocalWorkerTarget
  | WorkerTargetFactory;

/**
 * A local target with its tuning. The string `"child-process"` is exactly
 * `{ kind: "child-process" }`, and the tuning a kind takes is only its own:
 * `spawn` on a `"worker-thread"` target is a type error, and a `ConfigError`
 * from plain JavaScript.
 */
export type LocalWorkerTarget =
  | InProcessTarget
  | WorkerThreadTarget
  | ChildProcessTarget;

/** `"in-process"` as an object, so every local mode has one. */
export interface InProcessTarget {
  /**
   * Marks the variant: the processor runs on the claim loop's own thread. A
   * processor file is imported once and then called the way a function is.
   */
  kind: "in-process";
}

/** A fresh Web `Worker` per attempt, in this process. */
export interface WorkerThreadTarget {
  /** Marks the variant: a fresh `Worker` per attempt, in this process. */
  kind: "worker-thread";
  /**
   * After the worker asks an attempt to stop (a timeout, a lost lock, a
   * close), how long the attempt has to unwind before its `Worker` is
   * terminated, in milliseconds. Defaults to 5000 (`DEFAULT_CLOSE_TIMEOUT`).
   */
  closeTimeout?: number;
  /**
   * Options for each `Worker`: `env`, `argv`, `smol` and `name`. The
   * runner's {@link WorkerOptions}, unchanged.
   */
  worker?: WorkerOptions;
}

/** A fresh child process per attempt. */
export interface ChildProcessTarget {
  /**
   * Marks the variant: a fresh child process per attempt. The only target
   * where a processor that ignores its signal is certain to be killed
   * (`SIGTERM`, then `SIGKILL`).
   */
  kind: "child-process";
  /**
   * After the worker asks an attempt to stop, how long the child has to
   * unwind before it is sent `SIGTERM`, in milliseconds. Defaults to 5000
   * (`DEFAULT_CLOSE_TIMEOUT`).
   */
  closeTimeout?: number;
  /**
   * After `SIGTERM`, how long before `SIGKILL`, in milliseconds. Defaults to
   * 2000 (`DEFAULT_KILL_TIMEOUT`).
   */
  killTimeout?: number;
  /**
   * Options for each child: `cwd`, `env`, `args` and the rest. The runner's
   * {@link SpawnOptions}, unchanged. `cwd` is also where a relative processor
   * file is resolved from.
   */
  spawn?: SpawnOptions;
}

/**
 * Builds the executor for a target this package does not ship: a gRPC pool,
 * a message bus, a platform SDK a published package must not depend on.
 *
 * Called once, from the worker's constructor, after its `id` and logger
 * exist. Synchronous, because the constructor is: connect lazily, in `run()`.
 * Accepted with a function processor and with a processor file alike.
 */
export type WorkerTargetFactory = (
  context: WorkerTargetContext,
) => WorkerTargetExecutor;

/**
 * What a {@link WorkerTargetFactory} is told about the worker it serves.
 *
 * **There is deliberately no driver here, nor any driver configuration.** A
 * custom target reaches the store only through `attempt.job`, whose driver is
 * private to it — which is what keeps every write an attempt makes on the
 * attempt's own write lane, so the ordering and abort guarantees hold for a
 * custom target by construction. Do not add one.
 */
export interface WorkerTargetContext {
  /** The namespace the worker consumes from. */
  namespace: string;
  /** The queue it consumes. */
  queue: string;
  /** The worker's incarnation id, `worker.id`. */
  workerId: string;
  /** The worker's logger, already bound to it. */
  logger: Logger;
  /**
   * What the worker was constructed with: a function, or the absolute path a
   * processor file resolved to. A target that ships attempts to code deployed
   * elsewhere may ignore it; one that wraps a processor (a warm `Worker`
   * pool, a tracing shim) runs it.
   */
  processor:
    | {
        /** The processor is a function. */
        kind: "function";
        /** The function itself. */
        fn: JobProcessor<unknown, unknown>;
      }
    | {
        /** The processor is a file. */
        kind: "file";
        /** Its absolute path, resolved at construction. */
        path: string;
      };
}

/**
 * Runs a worker's attempts somewhere this package does not know about: what a
 * {@link WorkerTargetFactory} returns.
 *
 * It is handed no driver (see {@link WorkerTargetContext}): every write goes
 * through `attempt.job`, deliberately.
 */
export interface WorkerTargetExecutor {
  /**
   * What this target is called, reported as the heartbeat record's
   * `target.name` and in log lines: `"grpc-pool"`, say. Free text, 1 to 64
   * characters. It is **not** a runner's `ExecutionMode`, and it is never
   * written to run history.
   */
  readonly name: string;
  /**
   * Runs one attempt. Resolves with the processor's result; rejects with its
   * error. An error named `UnrecoverableJobError` ends the job's retries,
   * whether or not it is an instance of the class, so one rebuilt from a wire
   * format still does. Must stop promptly when `attempt.context.signal`
   * aborts: the worker aborts it on a timeout, a lost lock or a close, and
   * waits only a bounded time after that.
   */
  run: (attempt: WorkerTargetAttempt) => Promise<unknown>;
  /**
   * Releases what the target holds between attempts: a connection, a pool.
   * Optional. Called once from `worker.close()`, after the worker's attempts
   * have settled or been abandoned, and **bounded** like the built-in kinds'
   * stop: after `DEFAULT_CLOSE_TIMEOUT` (5000 ms) the worker logs a warning
   * and finishes closing without it, so a drain that never ends cannot hang a
   * shutdown. A rejection is logged the same way.
   *
   * `options.force` is `true` when the caller asked for `worker.close({ force:
   * true })` — not to wait — and absent otherwise. A target **may** honour it
   * by skipping its own graceful wind-down (the built-in kinds kill their
   * runs at once instead of asking them to stop first); one that ignores it
   * keeps working, and is simply given the same bound either way.
   */
  close?: (options?: WorkerTargetCloseOptions) => void | Promise<void>;
}

/** What `worker.close()` tells a target's {@link WorkerTargetExecutor.close}. */
export interface WorkerTargetCloseOptions {
  /**
   * `true` when the worker is closing with `force`: the caller asked it not
   * to wait. Absent on an ordinary close, including one whose `timeout` ran
   * out.
   */
  force?: boolean;
}

/** One attempt, as a {@link WorkerTargetExecutor} is handed it. */
export interface WorkerTargetAttempt {
  /**
   * The worker's own `Job` for this attempt. **Every write the attempt makes
   * goes through it, never around it**: progress, a log line, a lock
   * extension, `fail()`. That is what puts those writes on the attempt's
   * write lane, which the worker settles before it records how the job ended,
   * and which drops a progress value reported after the attempt was aborted.
   */
  job: Job<unknown, unknown>;
  /**
   * The claimed record, as stored: the serialisable view to send across a
   * boundary — the same value `job.toJSON()` returns, without the copy. Do
   * not mutate it.
   */
  record: JobRecord;
  /**
   * The processor context: `signal`, `logger`, `heartbeat`, `log`,
   * `workerId`, `attempt`. `signal` is the worker's own abort signal for the
   * attempt.
   */
  context: ProcessorContext;
}

/**
 * Types a processor file's default export.
 *
 * ```ts
 * // jobs/resize.ts
 * export default defineProcessor<{ path: string }, { width: number }>(
 *   async (job, ctx) => resize(job.data.path, ctx.signal),
 * );
 * ```
 */
export function defineProcessor<TData = unknown, TResult = unknown>(
  processor: JobProcessor<TData, TResult>,
): JobProcessor<TData, TResult> {
  return processor;
}

/**
 * One entry {@link defineProcessors} dispatches to: a name and its handler,
 * which is the part of a {@link JobDefinition} a processor file needs. Any
 * handler fits — its job's data and result types are its own.
 */
interface ProcessorDefinition {
  /** The job name it runs. */
  readonly name: string;
  /**
   * What runs a job of that name. A method, deliberately: its parameter is
   * then checked both ways, so a handler typed for its own data fits, and an
   * inline one is still handed a `Job` rather than `never`.
   */
  // eslint-disable-next-line ts/method-signature-style
  handler(job: Job<unknown, unknown>, ctx: ProcessorContext): unknown;
}

/**
 * A processor that dispatches on the job's name: one processor file for
 * many job names.
 *
 * Takes the same definitions `BunJobs.define()` records — `jobs.definitions()`,
 * a {@link JobDefinitions}, or plain `{ name, handler }` objects — so one
 * module of definitions can be imported by the producer (which needs the names
 * and options) and default-exported here (which needs the handlers):
 *
 * ```ts
 * // jobs/processor.ts
 * import { sendEmail, resize } from "./definitions";
 * export default defineProcessors([sendEmail, resize]);
 * ```
 *
 * A job whose name has no definition fails with an
 * {@link UnrecoverableJobError}: no number of retries will find a handler that
 * was not deployed. A name given twice keeps the later handler, as a second
 * `define()` does.
 */
export function defineProcessors(
  definitions: readonly ProcessorDefinition[] | JobDefinitions,
): JobProcessor<unknown, unknown> {
  const byName = new Map<string, JobProcessor<unknown, unknown>>();
  const list: readonly ProcessorDefinition[] = Array.isArray(definitions)
    ? definitions
    : (definitions as JobDefinitions).all();

  for (const definition of list) {
    if (
      typeof definition?.name !== "string" ||
      definition.name.length === 0 ||
      typeof definition.handler !== "function"
    ) {
      throw new ConfigError(
        "defineProcessors() takes definitions of the form { name, handler }",
        { name: definition?.name },
      );
    }
    // Each handler's own types are its definition's, which the dispatcher
    // cannot know; it hands every one the job it was given.
    byName.set(
      definition.name,
      definition.handler as JobProcessor<unknown, unknown>,
    );
  }

  return async (job, context) => {
    const handler = byName.get(job.name);
    if (!handler) {
      throw new UnrecoverableJobError(
        `No processor is defined for "${job.name}" in this processor file`,
        { name: job.name, defined: [...byName.keys()] },
      );
    }
    return await handler(job, context);
  };
}

/** The three local kinds, for checking a value off the options. */
const LOCAL_KINDS: ReadonlySet<string> = new Set<WorkerTargetMode>([
  "in-process",
  "worker-thread",
  "child-process",
]);

/** The tuning keys each local kind takes, beside `kind`. */
const LOCAL_KEYS: Readonly<Record<WorkerTargetMode, readonly string[]>> = {
  "in-process": [],
  "worker-thread": ["closeTimeout", "worker"],
  "child-process": ["closeTimeout", "killTimeout", "spawn"],
};

/** The allowed modes, as the messages below spell them. */
const MODES_TEXT = '"in-process", "worker-thread" or "child-process"';

/**
 * A `target` option after validation: what the worker dispatches on and
 * describes in its heartbeat record. Internal.
 */
export interface ResolvedWorkerTarget {
  /** Where the attempts run. */
  kind: WorkerTargetKind;
  /** The local target, normalised to its object form; for the three local kinds. */
  local?: LocalWorkerTarget;
  /** The factory, for `"custom"`. */
  factory?: WorkerTargetFactory;
  /** The processor file's absolute path, when the processor is a file. */
  file?: string;
}

/** Describes a bad `target` value for a message. */
function describe(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (value && typeof value === "object" && "kind" in value) {
    return `{ kind: ${describe((value as { kind: unknown }).kind)} }`;
  }
  return String(value);
}

/** The `ConfigError` for a value that is not a target, with a hint when one helps. */
function notATarget(value: unknown): ConfigError {
  const mode =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as { kind?: unknown }).kind
        : undefined;
  // The old spellings get their own hint: runners used them before 1r, so a
  // user who knew runners will type them.
  const hint = legacyExecutionModeHint(mode);
  return new ConfigError(
    `target must be ${MODES_TEXT}, not ${describe(value)}${hint}`,
    { target: typeof value === "function" ? "function" : value },
  );
}

/**
 * Validates a worker's `target` against its processor, and resolves a
 * processor file. Throws a `ConfigError` for a bad value, before the worker
 * has any side effects; builds nothing.
 */
export function resolveWorkerTarget(
  /** The worker's options, read as plain JavaScript may have written them. */
  options: {
    target?: unknown;
    isolation?: unknown;
    isolationOptions?: unknown;
  },
  /** The worker's processor: a function, or a file's path or URL. */
  processor: unknown,
): ResolvedWorkerTarget {
  // Not an alias: silently ignoring the old key would run a file meant for a
  // child process on the claim loop's own thread, with nothing to say so.
  if (options.isolation !== undefined) {
    throw new ConfigError(
      'isolation was replaced by target: use target: "child-process" (was "spawn") or "worker-thread" (was "worker")',
      { isolation: options.isolation },
    );
  }
  if (options.isolationOptions !== undefined) {
    throw new ConfigError(
      'isolationOptions was replaced by target: give the settings on the target itself, as { kind: "child-process", closeTimeout, killTimeout, spawn } or { kind: "worker-thread", closeTimeout, worker }',
      { isolationOptions: options.isolationOptions },
    );
  }

  const target = options.target ?? "in-process";
  const isFunction = typeof processor === "function";

  if (typeof target === "function") {
    return {
      kind: "custom",
      factory: target as WorkerTargetFactory,
      ...(isFunction ? {} : { file: resolveProcessorFile(processor) }),
    };
  }

  const local = toLocalTarget(target);

  if (isFunction) {
    if (local.kind !== "in-process") {
      throw new ConfigError(
        `target "${local.kind}" needs a processor file: a function cannot be sent to another process or Worker`,
        { target: local.kind },
      );
    }
    return { kind: "in-process", local };
  }

  return {
    kind: local.kind,
    local,
    file: resolveProcessorFile(
      processor,
      local.kind === "child-process" ? local.spawn?.cwd : undefined,
    ),
  };
}

/** A string or object target as its object form, or a `ConfigError`. */
function toLocalTarget(target: unknown): LocalWorkerTarget {
  if (typeof target === "string") {
    if (!LOCAL_KINDS.has(target)) {
      throw notATarget(target);
    }
    return { kind: target as WorkerTargetMode };
  }

  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw notATarget(target);
  }

  const { kind } = target as { kind?: unknown };
  if (typeof kind !== "string" || !LOCAL_KINDS.has(kind)) {
    throw notATarget(target);
  }

  const allowed = LOCAL_KEYS[kind as WorkerTargetMode];
  for (const [key, value] of Object.entries(target)) {
    if (key === "kind" || value === undefined) {
      continue;
    }
    if (!allowed.includes(key)) {
      throw new ConfigError(
        `target { kind: "${kind}" } does not take ${key}${
          allowed.length === 0
            ? ": it takes no settings"
            : `: it takes ${allowed.join(", ")}`
        }`,
        { target: kind, key },
      );
    }
    if (
      (key === "closeTimeout" || key === "killTimeout") &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    ) {
      throw new ConfigError(
        `target ${key} must be a number of milliseconds, not ${String(value)}`,
        { target: kind, [key]: value },
      );
    }
  }

  // A copy, so a caller changing its object later cannot change a running
  // worker's tuning under it.
  return { ...(target as LocalWorkerTarget) };
}

/**
 * How much sooner than the worker's bound on a target's `close()` the built-in
 * target's deadline ends. See {@link TARGET_CLOSE_GRACE}.
 */
const TARGET_CLOSE_MARGIN = 1_000;

/**
 * How long the built-in target's `close()` waits for killed runs to be reaped:
 * half the margin, so that wait too ends strictly inside the worker's bound.
 */
export const TARGET_CLOSE_REAP = TARGET_CLOSE_MARGIN / 2;

/**
 * How long the built-in target's `close()` lets a run still going unwind,
 * after asking it to stop, before it kills it: 4000 ms.
 *
 * Three numbers, one timeline, all from `DEFAULT_CLOSE_TIMEOUT` (5000 ms), the
 * bound the worker puts on a target's `close()`:
 *
 * - at `TARGET_CLOSE_GRACE` (4000 ms) anything still running is killed;
 * - by `TARGET_CLOSE_GRACE + TARGET_CLOSE_REAP` (4500 ms) `close()` has
 *   resolved, whether or not the killed children were seen reaped;
 * - at `DEFAULT_CLOSE_TIMEOUT` (5000 ms) the worker would give up.
 *
 * The order matters because when the worker's bound wins, it stops waiting
 * and forces nothing. A deadline at or past it could let `worker.close()`
 * return, and the process exit, with the kill still pending: #166 by another
 * route. The kill itself runs synchronously when the deadline fires, so the
 * margin is not what makes it certain. It is the room for a timer a loaded
 * machine fires late and a reap it delays — and the half left after the reap
 * keeps a close that succeeded from racing the bound and being logged as one
 * that "did not close".
 */
export const TARGET_CLOSE_GRACE = DEFAULT_CLOSE_TIMEOUT - TARGET_CLOSE_MARGIN;

/** Who is running an attempt off-thread, for its context and diagnostics. */
interface Runner {
  /** The namespace. */
  namespace: string;
  /** The queue. */
  queue: string;
  /** The worker's id. */
  workerId: string;
}

/**
 * The built-in executor for a processor file, in any of the three local
 * kinds: imported once and called in-process, or run per attempt in a fresh
 * `Worker` or child process. Internal; a worker builds one from its `target`.
 */
export class FileTargetExecutor implements WorkerTargetExecutor {
  /** The kind, as the executor's name: `"child-process"`, say. */
  readonly name: WorkerTargetMode;
  /** The processor file, resolved to an absolute path. */
  readonly file: string;

  /** The target with its tuning. */
  readonly #target: LocalWorkerTarget;
  /** Who runs the attempts, for the run context the executors need. */
  readonly #runner: Runner;
  /** The executor, for `"worker-thread"` and `"child-process"`. */
  #executor: Executor | undefined;
  /** The imported processor, for `"in-process"`: imported once, then reused. */
  #inProcess: Promise<IsolatedJobProcessor> | undefined;
  /**
   * Every run started and not yet ended, including one the worker has given
   * up on: a timed-out attempt leaves the worker's books straight away, but
   * its child is still being killed until its handle's `done` settles.
   */
  readonly #live = new Set<ExecutorHandle>();
  /**
   * The live runs already asked to stop — by their attempt's signal — whose
   * escalation is under way. A graceful close leaves them to it rather than
   * asking again and arming a second set of timers.
   */
  readonly #stopping = new Set<ExecutorHandle>();
  /** Set by {@link close}; a run asked for after it is refused. */
  #closed = false;

  constructor(
    /** The local target, in its object form. */
    target: LocalWorkerTarget,
    /** The processor file, already resolved to an absolute path. */
    file: string,
    /** Who runs the attempts. */
    runner: Runner,
  ) {
    this.name = target.kind;
    this.file = file;
    this.#target = target;
    this.#runner = runner;
  }

  /**
   * Runs one attempt, resolving with the processor's result or rejecting with
   * its error — rebuilt by name when it crossed a boundary, so a worker can
   * still tell an `UnrecoverableJobError` from any other.
   */
  async run({ job, record, context }: WorkerTargetAttempt): Promise<unknown> {
    const target = this.#target;
    if (this.#closed) {
      // Only reachable through a claim still in flight when a forced close
      // ran. Starting a child now would start one nothing will ever stop.
      throw new Error(
        `The ${target.kind} target of worker ${this.#runner.workerId} is closed`,
      );
    }
    if (target.kind === "in-process") {
      this.#inProcess ??= import(this.file).then((module: unknown) =>
        toHandler(module, this.file, "job"),
      );
      return await (
        await this.#inProcess
      )(job, context);
    }

    const { signal } = context;
    const runner = this.#runner;
    const executor = this.#executorFor(target);
    const runContext = {
      runId: `${record.id}.${record.attemptsMade}`,
      runnerId: runner.queue,
      runnerName: runner.workerId,
      namespace: runner.namespace,
      attempt: record.attemptsMade,
      source: "queued",
      // The target's own kind, which is also what the shared executors and
      // the child's `BUN_JOBS_MODE` call it.
      mode: target.kind,
      startedAt: Date.now(),
      deadline: null,
      args: null,
      signal,
      logger: context.logger,
      // An off-thread *job* has no run log: run logs are keyed by a runner's
      // run id, and this context stands in for one only so the executors can
      // be shared. A processor logs through `ctx.logger` and `job.log()`.
      log: () => {},
      flushLogs: async () => {},
      progress: () => {},
      send: () => {},
      onMessage: () => () => {},
    } satisfies RunContext<null>;

    // `onMessage` below reads `handle`, but only ever after `start()` has
    // returned: a child cannot send anything before it has been started.
    const handle: ExecutorHandle = executor.start({
      context: runContext,
      file: this.file,
      // The worker owns the timeout — it aborts the attempt's signal, which
      // stops the run below — so the executor does not keep a second clock.
      timeout: 0,
      closeTimeout: target.closeTimeout ?? DEFAULT_CLOSE_TIMEOUT,
      killTimeout:
        (target.kind === "child-process" ? target.killTimeout : undefined) ??
        DEFAULT_KILL_TIMEOUT,
      waitToExit: false,
      forwardLogs: true,
      kind: "job",
      job: record,
      events: {
        onProgress: (value) => {
          // Sent, not asked, so nothing here waits for the store: the
          // ordering the child's `await` used to buy is the attempt's now —
          // `updateProgress` joins its lane, which the worker settles before
          // it records how the job ended, and which drops what arrives after.
          // The `catch` is what it always was: a progress write that fails
          // does not fail the job.
          void job.updateProgress(value).catch(() => undefined);
        },
        onMessage: (data) => {
          void answer(handle, data, job, context, signal);
        },
        onLog: (level, message, fields) => {
          // `level` is typed by the protocol but arrives over IPC, so the
          // fallback to `info` stays for a child that sends something else.
          const write = context.logger[level] ?? context.logger.info;
          write.call(context.logger, message, fields);
        },
        onOutput: () => {},
        onPid: () => {},
      },
    });

    this.#live.add(handle);

    const stop = () => {
      this.#stopping.add(handle);
      handle.stop(String(signal.reason ?? "stop"));
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      stop();
    }

    try {
      const outcome = await handle.done;

      if (outcome.status === "success") {
        return outcome.result;
      }

      throw deserializeError(
        outcome.error ??
          serializeError(
            new Error(
              `The ${target.kind} job ended with status ${outcome.status}`,
            ),
          ),
      );
    } finally {
      signal.removeEventListener("abort", stop);
      this.#live.delete(handle);
      this.#stopping.delete(handle);
    }
  }

  /**
   * Stops every run still going, for `worker.close()`. By the time the worker
   * calls this, an attempt it was waiting for has already ended; what is left
   * is a run it gave up on — a timeout, a lost lock, a close out of patience —
   * whose kill sequence (`closeTimeout`, then `SIGTERM`, then `killTimeout`,
   * then `SIGKILL`) may still be running on timers.
   *
   * Those timers are unref'd and the child is too, so nothing keeps the
   * process alive on the child's account: a process that exits straight after
   * `worker.close()` used to lose them, and a child ignoring its signal
   * outlived it, reparented and still running (#166). So this owns the end of
   * every run itself.
   *
   * With `options.force` — the caller asked not to wait — every run is killed
   * at once, synchronously, before this returns anything to await; the only
   * wait is `TARGET_CLOSE_REAP` at most, to see them reaped. A child's cleanup
   * is skipped, which is what `force` asks for.
   *
   * Otherwise, in three steps:
   *
   * 1. Each run is asked to stop, gracefully: a child gets its `close` and
   *    the chance to clean up that `closeTimeout` exists to give it.
   * 2. The runs get until {@link TARGET_CLOSE_GRACE} to end, and this
   *    resolves as soon as they all have.
   * 3. At the deadline, anything still running is killed — synchronously, in
   *    the timer's own callback, before this resolves — and this waits, up
   *    to `TARGET_CLOSE_REAP`, for it to be reaped. Nothing outlives it.
   *
   * The deadline ends before the worker's bound on this call, which forces
   * nothing when it wins; see {@link TARGET_CLOSE_GRACE}. A child's own
   * escalation may end it sooner, when its `closeTimeout` and `killTimeout`
   * are shorter than the deadline.
   */
  close(options?: WorkerTargetCloseOptions): void | Promise<void> {
    this.#closed = true;
    if (this.#live.size === 0) {
      return;
    }

    const live = [...this.#live];
    // `done` never rejects: it resolves with how the run ended.
    const ended = Promise.all(live.map(async (handle) => await handle.done));

    if (options?.force) {
      // Killed here, synchronously, before anything is awaited: a forced
      // close is typically a shutdown hook's, and the process may exit on
      // the very next line.
      for (const handle of live) {
        handle.stop("close", { force: true });
      }
      return this.#reaped(ended);
    }

    for (const handle of live) {
      if (!this.#stopping.has(handle)) {
        this.#stopping.add(handle);
        handle.stop("close");
      }
    }

    return new Promise<void>((resolve) => {
      // Ref'd, deliberately — unlike every timer in `spawn.ts`, which unrefs
      // its escalation so a run never holds the process on its own account.
      // Here that is the point: while `close()` is pending, this timer can be
      // the only thing keeping the process alive, and an unref'd one would
      // let it exit before the kill below ever ran.
      const deadline = setTimeout(() => {
        for (const handle of live) {
          if (this.#live.has(handle)) {
            handle.stop("close", { force: true });
          }
        }
        void this.#reaped(ended).then(resolve);
      }, TARGET_CLOSE_GRACE);

      void ended.then(() => {
        clearTimeout(deadline);
        resolve();
      });
    });
  }

  /**
   * Resolves once killed runs have ended, or after `TARGET_CLOSE_REAP` at
   * most. The kills are already sent; this is seeing the children reaped, so
   * `close()` resolves with nothing alive. Its timer is ref'd for the same
   * reason as the deadline's, and bounded so the wait ends strictly inside
   * the worker's own bound.
   */
  async #reaped(ended: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ended,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TARGET_CLOSE_REAP);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The executor for this kind, built on first use. */
  #executorFor(target: WorkerThreadTarget | ChildProcessTarget): Executor {
    this.#executor ??=
      target.kind === "child-process"
        ? new SpawnExecutor({
            stdout: "inherit",
            stderr: "inherit",
            startTimeout: DEFAULT_START_TIMEOUT,
            ...target.spawn,
          })
        : new WorkerExecutor({ ...target.worker });
    return this.#executor;
  }
}

/**
 * The executor a resolved target dispatches to: `undefined` only for a
 * function processor run in-process, which the worker calls directly.
 * Called from the worker's constructor once its id and logger exist.
 */
export function buildTargetExecutor(
  /** The resolved target. */
  resolved: ResolvedWorkerTarget,
  /** The worker's processor, handed to a factory. */
  processor: unknown,
  /** The worker, as a factory's context describes it. */
  worker: Runner & { logger: Logger },
): WorkerTargetExecutor | undefined {
  if (resolved.factory) {
    const executor = resolved.factory({
      namespace: worker.namespace,
      queue: worker.queue,
      workerId: worker.workerId,
      logger: worker.logger,
      processor:
        resolved.file === undefined
          ? {
              kind: "function",
              fn: processor as JobProcessor<unknown, unknown>,
            }
          : { kind: "file", path: resolved.file },
    }) as Partial<WorkerTargetExecutor> | null | undefined;

    if (
      !executor ||
      typeof executor !== "object" ||
      typeof executor.run !== "function" ||
      typeof executor.name !== "string" ||
      executor.name.length === 0 ||
      executor.name.length > 64 ||
      (executor.close !== undefined && typeof executor.close !== "function")
    ) {
      throw new ConfigError(
        "A target factory must return { name, run, close? }, with a name of 1 to 64 characters",
        {
          name:
            executor && typeof executor === "object"
              ? executor.name
              : undefined,
        },
      );
    }
    return executor as WorkerTargetExecutor;
  }

  if (resolved.file === undefined) {
    return undefined;
  }

  return new FileTargetExecutor(resolved.local!, resolved.file, worker);
}

/**
 * The heartbeat record's `target`: derived from the very target the worker
 * dispatches to, so the record cannot disagree with what the worker does.
 */
export function describeTarget(
  /** The resolved target. */
  resolved: ResolvedWorkerTarget,
  /** The executor built for it, for a custom target's name. */
  executor: WorkerTargetExecutor | undefined,
): WorkerTargetInfo {
  return {
    kind: resolved.kind,
    processor: resolved.file === undefined ? "function" : "file",
    ...(resolved.kind === "custom" && executor ? { name: executor.name } : {}),
    ...(resolved.file === undefined ? {} : { file: resolved.file }),
  };
}

/** Every operation the job channel carries, for checking a request off the wire. */
const JOB_CHANNEL_OPERATIONS: ReadonlySet<string> =
  new Set<JobChannelOperation>([
    "log",
    "heartbeat",
    "childrenValues",
    "childrenFailures",
  ]);

/** Whether a request's operation is one this worker answers. */
function isJobChannelOperation(value: unknown): value is JobChannelOperation {
  return typeof value === "string" && JOB_CHANNEL_OPERATIONS.has(value);
}

/**
 * Answers one request an off-thread job made of its worker, using the real
 * `Job` here in the worker, which has the driver the child lacks.
 */
async function answer(
  handle: ExecutorHandle | undefined,
  data: unknown,
  job: Job<unknown, unknown>,
  context: ProcessorContext,
  signal: AbortSignal,
): Promise<void> {
  const request = data as Partial<JobChannelRequest> | null;

  if (!handle || !request || typeof request !== "object") {
    return;
  }

  const operation = request[JOB_CHANNEL];
  if (!isJobChannelOperation(operation)) {
    return;
  }

  const seq = request.seq ?? -1;
  let reply: JobChannelReply;

  try {
    reply = {
      [JOB_CHANNEL]: "reply",
      seq,
      value: await valueFor(operation, request, job, context, signal),
    };
  } catch (error) {
    // `log` and `heartbeat` keep their long-standing fallbacks: a line that
    // could not be counted, a lock that may not be held. Reading a flow's
    // children has no honest fallback, so the failure itself goes back.
    reply =
      operation === "log" || operation === "heartbeat"
        ? {
            [JOB_CHANNEL]: "reply",
            seq,
            value: operation === "log" ? 0 : false,
          }
        : { [JOB_CHANNEL]: "reply", seq, error: serializeError(error) };
  }

  handle.send(reply);
}

/** What one job-channel operation answers, from the worker's real `Job`. */
async function valueFor(
  operation: JobChannelOperation,
  request: Partial<JobChannelRequest>,
  job: Job<unknown, unknown>,
  context: ProcessorContext,
  signal: AbortSignal,
): Promise<JobChannelReplies[JobChannelOperation]> {
  switch (operation) {
    case "log":
      return await job.log(request.line ?? "");
    case "heartbeat":
      // No duration: `ctx.heartbeat()`, or a child that predates `ms` —
      // renew for the worker's own lockDuration, as before.
      if (request.ms === undefined) {
        await context.heartbeat();
        return !signal.aborted;
      }
      // `job.extendLock(ms)` in the child. A given-up attempt keeps no lock.
      if (signal.aborted) {
        return false;
      }
      return (
        (await job.extendLock(
          // A non-number (NaN arrives as null over JSON) falls back to
          // extendLock's own default, as it would in-process.
          typeof request.ms === "number" ? request.ms : undefined,
        )) && !signal.aborted
      );
    case "childrenValues":
      return await job.getChildrenValues();
    case "childrenFailures":
      return Object.fromEntries(
        Object.entries(await job.getChildrenFailures()).map(([key, error]) => [
          key,
          serializeError(error),
        ]),
      );
  }
}

/** An absolute path for a processor file, or a `ConfigError` saying why not. */
function resolveProcessorFile(file: unknown, cwd?: string): string {
  if (typeof file !== "string" && !(file instanceof URL)) {
    throw new ConfigError(
      "A worker's processor must be a function, or a processor file's path or URL",
      { processor: typeof file },
    );
  }

  if (file instanceof URL) {
    return fileURLToPath(file);
  }

  if (file.startsWith("file://")) {
    return fileURLToPath(file);
  }

  try {
    return Bun.resolveSync(file, cwd ?? process.cwd());
  } catch (error) {
    throw new ConfigError(
      `Cannot resolve the processor file "${file}": ${(error as Error).message}`,
      { file, cwd },
    );
  }
}
