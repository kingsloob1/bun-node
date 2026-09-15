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
import type { Job } from "./Job";
import type { JobProcessor, ProcessorContext } from "./types";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deserializeError, serializeError } from "@kingsleyweb/bun-common";
import { toHandler } from "../runner/executors/executor";
import { SpawnExecutor } from "../runner/executors/spawn";
import { WorkerExecutor } from "../runner/executors/worker";
import { JOB_CHANNEL } from "../runner/protocol";
import {
  DEFAULT_CLOSE_TIMEOUT,
  DEFAULT_KILL_TIMEOUT,
  DEFAULT_START_TIMEOUT,
} from "../shared/constants";
import { ConfigError } from "../shared/errors";

/**
 * Running a job's processor somewhere other than the worker's own thread.
 *
 * A worker given a *file* rather than a function can run each attempt in
 * a child process or a `Worker`, through the same executors `BunRunner` uses —
 * so a processor that blocks its thread, leaks, or has to be killable for
 * certain does so away from the claim loop, the heartbeats and every other
 * job. The processor file default-exports the same `(job, ctx)` function it
 * would be in-process; `defineProcessor` types it.
 *
 * The worker keeps the driver. What an isolated processor needs of it — its
 * log, its lock — is asked for over the executor's message channel and
 * answered from here, and its progress is written here too. Everything else
 * that would change the stored job directly is unavailable in the child, and
 * says so.
 */

/** How a job's processor is run. */
export type IsolationMode = "in-process" | "spawn" | "worker";

/** Tuning for isolated processors. */
export interface IsolationOptions {
  /**
   * After asking an isolated processor to stop, how long it has to unwind
   * before it is terminated. Defaults to 5 seconds.
   */
  closeTimeout?: number;
  /** After `SIGTERM`, how long before `SIGKILL` (spawn only). Defaults to 2 seconds. */
  killTimeout?: number;
  /** Child-process options, for `"spawn"`. */
  spawn?: SpawnOptions;
  /** `Worker` options, for `"worker"`. */
  worker?: WorkerOptions;
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

/** Who is running an isolated attempt, for its context and diagnostics. */
interface Runner {
  /** The namespace. */
  namespace: string;
  /** The queue. */
  queue: string;
  /** The worker's id. */
  workerId: string;
}

/** A processor file, and the executor that runs it. */
export class IsolatedProcessor {
  /** The processor file, resolved to an absolute path. */
  readonly file: string;
  /** Where each attempt runs. */
  readonly mode: IsolationMode;

  /** Tuning, with defaults applied where the executors need them. */
  readonly #options: IsolationOptions;
  /** The executor, for `"spawn"` and `"worker"`. */
  #executor: Executor | undefined;
  /** The imported processor, for `"in-process"`: imported once, then reused. */
  #inProcess: Promise<IsolatedJobProcessor> | undefined;

  constructor(
    /** The processor file: a path, relative to the working directory, or a URL. */
    file: string | URL,
    /** Where each attempt runs. */
    mode: IsolationMode,
    /** Tuning. */
    options: IsolationOptions = {},
  ) {
    if (mode !== "in-process" && mode !== "spawn" && mode !== "worker") {
      throw new ConfigError(
        `isolation must be "in-process", "spawn" or "worker", not "${String(mode)}"`,
        { isolation: mode },
      );
    }

    this.file = resolveProcessorFile(file, options.spawn?.cwd);
    this.mode = mode;
    this.#options = options;
  }

  /**
   * Runs one attempt, resolving with the processor's result or rejecting with
   * its error — rebuilt by name when it crossed a boundary, so a worker can
   * still tell an `UnrecoverableJobError` from any other.
   */
  async run(
    job: Job<unknown, unknown>,
    record: JobRecord,
    context: ProcessorContext,
    controller: AbortController,
    runner: Runner,
  ): Promise<unknown> {
    if (this.mode === "in-process") {
      this.#inProcess ??= import(this.file).then((module: unknown) =>
        toHandler(module, this.file, "job"),
      );
      return await (
        await this.#inProcess
      )(job, context);
    }

    const executor = this.#executorFor();
    const runContext = {
      runId: `${record.id}.${record.attemptsMade}`,
      runnerId: runner.queue,
      runnerName: runner.workerId,
      namespace: runner.namespace,
      attempt: record.attemptsMade,
      source: "queued",
      mode: this.mode,
      startedAt: Date.now(),
      deadline: null,
      args: null,
      signal: controller.signal,
      logger: context.logger,
      progress: () => {},
      send: () => {},
      onMessage: () => () => {},
    } satisfies RunContext<null>;

    // `onMessage` below reads `handle`, but only ever after `start()` has
    // returned: a child cannot send anything before it has been started.
    const handle: ExecutorHandle = executor.start({
      context: runContext,
      file: this.file,
      // The worker owns the timeout — it aborts `controller`, which stops the
      // run below — so the executor does not keep a second clock.
      timeout: 0,
      closeTimeout: this.#options.closeTimeout ?? DEFAULT_CLOSE_TIMEOUT,
      killTimeout: this.#options.killTimeout ?? DEFAULT_KILL_TIMEOUT,
      waitToExit: false,
      forwardLogs: true,
      kind: "job",
      job: record,
      events: {
        onProgress: (value) => {
          void job.updateProgress(value).catch(() => undefined);
        },
        onMessage: (data) => {
          void answer(handle, data, job, context, controller);
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

    const stop = () => {
      handle.stop(String(controller.signal.reason ?? "stop"));
    };
    controller.signal.addEventListener("abort", stop, { once: true });
    if (controller.signal.aborted) {
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
            new Error(`The isolated job ended with status ${outcome.status}`),
          ),
      );
    } finally {
      controller.signal.removeEventListener("abort", stop);
    }
  }

  /** The executor for this mode, built on first use. */
  #executorFor(): Executor {
    this.#executor ??=
      this.mode === "spawn"
        ? new SpawnExecutor({
            stdout: "inherit",
            stderr: "inherit",
            startTimeout: DEFAULT_START_TIMEOUT,
            ...this.#options.spawn,
          })
        : new WorkerExecutor({ ...this.#options.worker });
    return this.#executor;
  }
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
 * Answers one request an isolated job made of its worker, using the real
 * `Job` here in the worker, which has the driver the child lacks.
 */
async function answer(
  handle: ExecutorHandle | undefined,
  data: unknown,
  job: Job<unknown, unknown>,
  context: ProcessorContext,
  controller: AbortController,
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
      value: await valueFor(operation, request, job, context, controller),
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
  controller: AbortController,
): Promise<JobChannelReplies[JobChannelOperation]> {
  switch (operation) {
    case "log":
      return await job.log(request.line ?? "");
    case "heartbeat":
      await context.heartbeat();
      return !controller.signal.aborted;
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
function resolveProcessorFile(file: string | URL, cwd?: string): string {
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
