import type { SerializedError } from "@kingsleyweb/bun-common";
import type { ExecutionMode } from "../../drivers/index";
import type { RunProgress } from "../types";
import type {
  Executor,
  ExecutorHandle,
  ExecutorStartOptions,
  RunOutcome,
} from "./executor";
import process from "node:process";
import { serializeError, withTimeout } from "@kingsleyweb/bun-common";
import { JobTimeoutError, RunKilledError } from "../../shared/errors";
import { toHandler } from "./executor";

/**
 * Runs the handler in the current process.
 *
 * The fastest mode and the only one where `ctx.driver` is a live instance —
 * and the only one that cannot guarantee a run actually stops. A handler that
 * ignores `ctx.signal` keeps running after a timeout; the outcome then says
 * `detached: true` rather than pretending the run is over. Anything that must
 * be killable belongs in `spawn` or `worker` mode.
 */
export class InProcessExecutor implements Executor {
  /** Which mode this executor implements. */
  readonly mode: ExecutionMode = "in-process";

  /** Bumped per run when `reloadOnEachRun` is on, to bust the module cache. */
  #reload = 0;

  constructor(
    /** In-process specific options. */
    private readonly options: { reloadOnEachRun?: boolean } = {},
  ) {}

  start<TArgs>(options: ExecutorStartOptions<TArgs>): ExecutorHandle {
    const controller = new AbortController();
    // Messages are `unknown` here: an executor is transport and never knows a
    // handler's declared message types (see `ExecutorEvents`).
    const listeners = new Set<(message: unknown) => void>();
    // The handler is not listening until its module has been imported and it
    // has called `onMessage`, which is after `start()` returns. Buffering
    // means a message sent immediately after `trigger()` is delivered rather
    // than dropped on the floor.
    const pending: unknown[] = [];

    // The context's signal and callbacks are wired to this process directly;
    // in the other modes the equivalents travel over IPC.
    const context = {
      ...options.context,
      signal: controller.signal,
      progress: (value: RunProgress) => options.events.onProgress(value),
      send: (message: unknown) => options.events.onMessage(message),
      onMessage: (listener: (message: unknown) => void) => {
        listeners.add(listener);

        // Flush anything that arrived before this listener existed.
        while (pending.length > 0) {
          listener(pending.shift());
        }

        return () => listeners.delete(listener);
      },
    };

    options.events.onPid(process.pid);

    /** Why the run was asked to stop, once it has been. */
    let stopReason: string | undefined;
    const done = this.#run(options, context, controller, () => stopReason);

    return {
      done,
      stop: (reason, _stopOptions) => {
        stopReason ??= reason;
        controller.abort();
      },
      send: (message: unknown) => {
        if (listeners.size === 0) {
          pending.push(message);
          return true;
        }

        for (const listener of listeners) {
          listener(message);
        }
        return true;
      },
    };
  }

  /** Imports the handler, runs it under the timeout, and classifies the end. */
  async #run<TArgs>(
    options: ExecutorStartOptions<TArgs>,
    context: ExecutorStartOptions<TArgs>["context"],
    controller: AbortController,
    stopReason: () => string | undefined,
  ): Promise<RunOutcome> {
    let settled = false;

    try {
      const specifier = this.options.reloadOnEachRun
        ? `${options.file}?v=${++this.#reload}`
        : options.file;

      const handler = toHandler(await import(specifier), options.file);

      const work = Promise.resolve(handler(context)).then(
        (result) => {
          settled = true;
          return result;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );

      const result = await withTimeout(work, options.timeout, {
        onTimeout: () => controller.abort(),
      });

      // A run stopped on request is a kill even when the handler saw its
      // signal and returned cleanly, exactly as in the other two modes.
      const reason = controller.signal.aborted ? stopReason() : undefined;
      if (reason !== undefined) {
        return {
          status: "killed",
          error: serializeError(
            new RunKilledError(reason, { runId: context.runId }),
          ),
          pid: process.pid,
        };
      }

      return { status: "success", result, pid: process.pid };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return await this.#afterTimeout(options, () => settled);
      }

      const reason = controller.signal.aborted ? stopReason() : undefined;

      return {
        status: controller.signal.aborted ? "killed" : "failed",
        // A stop is reported as a stop, whatever the handler threw on its way
        // out — usually just the abort it was told about.
        error: serializeError(
          reason === undefined
            ? error
            : new RunKilledError(reason, { runId: context.runId }),
        ),
        pid: process.pid,
      };
    }
  }

  /**
   * Gives an aborted handler until `closeTimeout` to unwind. If it is still
   * running after that, the run is reported as detached — this process cannot
   * take it any further, and saying so beats implying the work stopped.
   */
  async #afterTimeout<TArgs>(
    options: ExecutorStartOptions<TArgs>,
    hasSettled: () => boolean,
  ): Promise<RunOutcome> {
    const deadline = Date.now() + options.closeTimeout;
    while (!hasSettled() && Date.now() < deadline) {
      await Bun.sleep(5);
    }

    const error: SerializedError = serializeError(
      new JobTimeoutError(options.timeout, {
        runId: options.context.runId,
        detached: !hasSettled(),
      }),
    );

    return {
      status: "timeout",
      error,
      pid: process.pid,
      ...(hasSettled() ? {} : { detached: true }),
    };
  }
}
