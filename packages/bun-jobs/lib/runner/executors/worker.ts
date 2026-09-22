import type { ExecutionMode } from "../../drivers/index";
import type { ChildToParent, ParentToChild } from "../protocol";
import type { WorkerOptions } from "../types";
import type {
  Executor,
  ExecutorHandle,
  ExecutorStartOptions,
  RunOutcome,
} from "./executor";
import process from "node:process";
import { createDeferred, serializeError } from "@kingsleyweb/bun-common";
import {
  ChildExitError,
  JobTimeoutError,
  RunKilledError,
} from "../../shared/errors";
import { CHILD_ENV } from "../protocol";
import { toSerializable } from "./spawn";

/**
 * Runs the handler in a `Worker`.
 *
 * The middle ground: a separate JavaScript context, so a run can be
 * terminated outright, but the same process — cheaper to start than a child,
 * and it shares the process's memory limits and file descriptors. `close`
 * gives the handler a chance to unwind; `terminate()` is what actually ends
 * it, since a worker cannot exit itself with a status.
 */
export class WorkerExecutor implements Executor {
  /** Which mode this executor implements. */
  readonly mode: ExecutionMode = "worker";

  /** The protocol-owning entry point the worker actually runs. */
  static readonly entry = new URL(
    "../bootstrap/worker-entry.ts",
    import.meta.url,
  );

  constructor(
    /** Worker options. */
    private readonly options: WorkerOptions,
  ) {}

  start<TArgs>(options: ExecutorStartOptions<TArgs>): ExecutorHandle {
    const outcome = createDeferred<RunOutcome>();
    const context = toSerializable(options);

    let reported: RunOutcome | undefined;
    let settled = false;

    // Declared here because `settle` and `escalate` close over them and are
    // defined before they are armed.
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;

    const worker = new Worker(WorkerExecutor.entry, {
      name: this.options.name ?? `${context.runnerId}:${context.runId}`,
      smol: this.options.smol,
      argv: this.options.argv,
      env: {
        ...process.env,
        ...this.options.env,
        [CHILD_ENV.marker]: "1",
        [CHILD_ENV.mode]: "worker",
        [CHILD_ENV.namespace]: context.namespace,
        [CHILD_ENV.runnerId]: context.runnerId,
        [CHILD_ENV.runId]: context.runId,
        [CHILD_ENV.file]: context.file,
      },
    });

    options.events.onPid(process.pid);

    if (!options.waitToExit) {
      worker.unref();
    }

    /** Settles the run exactly once and disposes of the worker. */
    const settle = (result: RunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeTimer);
      worker.terminate();
      outcome.resolve(result);
    };

    const send = (message: ParentToChild): boolean => {
      try {
        worker.postMessage(message);
        return true;
      } catch {
        return false;
      }
    };

    /** Asks the worker to stop, then terminates it when it does not. */
    const escalate = (
      reason: "timeout" | "stop" | "kill" | "lock-lost",
      force = false,
    ): void => {
      if (settled) {
        return;
      }

      if (force) {
        settle(
          reported ?? {
            status: "killed",
            error: serializeError(
              new ChildExitError(null, null, {
                runId: context.runId,
                reason,
              }),
            ),
          },
        );
        return;
      }

      send({ t: "close", runId: context.runId, reason });

      closeTimer = setTimeout(() => {
        settle(
          reported ?? {
            status: reason === "timeout" ? "timeout" : "killed",
            error: serializeError(
              new ChildExitError(null, null, {
                runId: context.runId,
                reason,
              }),
            ),
          },
        );
      }, options.closeTimeout);
      closeTimer.unref?.();
    };

    worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as ChildToParent;

      switch (message.t) {
        case "ready":
          send({ t: "start", runId: context.runId, ctx: context });
          break;
        case "progress":
          options.events.onProgress(message.value);
          break;
        case "message":
          options.events.onMessage(message.data);
          break;
        case "log":
          options.events.onLog(message.level, message.message, message.fields);
          break;
        case "output":
          options.events.onConsole?.(message.stream, message.chunk);
          break;
        case "done":
          // A timeout or a kill already decided how this run ended; a worker
          // that unwinds afterwards does not undo that.
          settle(reported ?? { status: "success", result: message.result });
          break;
        case "error":
          settle(reported ?? { status: "failed", error: message.error });
          break;
        default:
          break;
      }
    });

    worker.addEventListener("error", (event: ErrorEvent) => {
      settle({
        status: "failed",
        error: serializeError(event.error ?? new Error(event.message)),
      });
    });

    worker.addEventListener("close", () => {
      settle(
        reported ?? {
          status: "failed",
          error: serializeError(
            new ChildExitError(null, null, {
              runId: context.runId,
              reason: "the worker closed before reporting a result",
            }),
          ),
        },
      );
    });

    timeoutTimer =
      options.timeout > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            reported = {
              status: "timeout",
              error: serializeError(
                new JobTimeoutError(options.timeout, { runId: context.runId }),
              ),
            };
            escalate("timeout");
          }, options.timeout)
        : undefined;
    timeoutTimer?.unref?.();

    return {
      done: outcome.promise,
      stop: (reason, stopOptions) => {
        if (!reported) {
          reported = {
            status: "killed",
            error: serializeError(
              new RunKilledError(reason, { runId: context.runId }),
            ),
          };
        }
        escalate("kill", stopOptions?.force);
      },
      send: (message) =>
        send({ t: "message", runId: context.runId, data: message }),
    };
  }
}
