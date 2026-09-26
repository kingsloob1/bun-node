import type { Subprocess } from "bun";
import type { ExecutionMode } from "../../drivers/index";
import type {
  ChildToParent,
  ParentToChild,
  SerializableContext,
} from "../protocol";
import type { SpawnOptions } from "../types";
import type {
  Executor,
  ExecutorHandle,
  ExecutorStartOptions,
  RunOutcome,
} from "./executor";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDeferred, serializeError } from "@kingsleyweb/bun-common";
import {
  ChildExitError,
  JobTimeoutError,
  RunKilledError,
} from "../../shared/errors";
import { CHILD_ENV } from "../protocol";

/**
 * Runs the handler in a child process.
 *
 * The default mode, and the only one where a wedged handler can be stopped
 * for certain: a run that ignores its abort signal is escalated from an IPC
 * `close` to `SIGTERM` to `SIGKILL`. The implementation this replaces called
 * `kill(0)` — signal zero, which only checks that a process exists — so a
 * stuck job was never actually killed.
 */
export class SpawnExecutor implements Executor {
  /** Which mode this executor implements. */
  readonly mode: ExecutionMode = "child-process";

  /** The protocol-owning entry point the child actually runs. */
  static readonly entry = fileURLToPath(
    new URL("../bootstrap/spawn-entry.ts", import.meta.url),
  );

  constructor(
    /** Child-process options, with defaults already applied. */
    private readonly options: Required<
      Pick<SpawnOptions, "stdout" | "stderr" | "startTimeout">
    > &
      SpawnOptions,
  ) {}

  start<TArgs>(options: ExecutorStartOptions<TArgs>): ExecutorHandle {
    const outcome = createDeferred<RunOutcome>();
    const context = toSerializable(options);

    /** Set once the child reports a result, so exit is only the finaliser. */
    let reported: RunOutcome | undefined;
    /** Guards the escalation and the deferred against double settling. */
    let settled = false;
    let ready = false;

    // Declared here because `settle` closes over them and is defined
    // before they are armed; they are only ever read after that.
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    // `child` and the callbacks below are mutually recursive: the spawn's
    // `ipc`/`onExit` handlers call them, and they call the subprocess. The
    // declaration comes first; nothing reads it until the spawn returns.
    let child: Subprocess<
      "ignore",
      "pipe" | "inherit" | "ignore",
      "pipe" | "inherit" | "ignore"
    >;

    // Defined before `Bun.spawn` because its `ipc` and `onExit` callbacks
    // call them; they only read `child` once it has been assigned.
    /** Sends a protocol message, ignoring a channel that is already gone. */
    const send = (message: ParentToChild): boolean => {
      try {
        child.send(message);
        return true;
      } catch {
        return false;
      }
    };

    /** Settles the run exactly once. */
    const settle = (result: RunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(readyTimer);
      clearTimeout(timeoutTimer);
      outcome.resolve(result);
    };

    child = Bun.spawn(
      [
        this.options.execPath ?? process.execPath,
        SpawnExecutor.entry,
        ...(this.options.args ?? []),
      ],
      {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...this.options.env,
          [CHILD_ENV.marker]: "1",
          // From the executor itself, so `BUN_JOBS_MODE` can never disagree
          // with the `RunRecord.mode` of the run it started.
          [CHILD_ENV.mode]: this.mode,
          [CHILD_ENV.namespace]: context.namespace,
          [CHILD_ENV.runnerId]: context.runnerId,
          [CHILD_ENV.runId]: context.runId,
          [CHILD_ENV.file]: context.file,
        },
        stdin: "ignore",
        stdout: this.options.stdout,
        stderr: this.options.stderr,
        serialization: "json",
        ipc: (message: ChildToParent) => {
          this.#onMessage(message, options, {
            onReady: () => {
              ready = true;
              send({ t: "start", runId: context.runId, ctx: context });
            },
            onResult: (result) => {
              // A timeout or a kill already decided how this run ended; a
              // child that unwinds afterwards does not undo that.
              reported ??= result;
            },
          });
        },
        onExit: (_proc, exitCode) => {
          // `onExit`'s third argument is the signal *number*; the
          // subprocess carries the name, which is what a reader wants.
          const signal = child.signalCode ?? null;

          settle({
            ...(reported ?? {
              status: "failed",
              error: serializeError(
                new ChildExitError(exitCode, signal, {
                  runId: context.runId,
                }),
              ),
            }),
            exitCode,
            signal,
            pid: child.pid,
          });
        },
      },
    );

    options.events.onPid(child.pid);

    if (!options.waitToExit) {
      child.unref();
    }

    /**
     * Asks the child to stop, then escalates. Each step is armed only if the
     * previous one has not ended the process.
     */
    const escalate = (
      reason: "timeout" | "stop" | "kill" | "lock-lost",
      force = false,
    ): void => {
      if (settled) {
        return;
      }

      if (force) {
        child.kill("SIGKILL");
        return;
      }

      send({ t: "close", runId: context.runId, reason });

      const term = setTimeout(() => {
        if (!settled) {
          child.kill("SIGTERM");
        }
      }, options.closeTimeout);
      term.unref?.();

      const kill = setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, options.closeTimeout + options.killTimeout);
      kill.unref?.();
    };

    // No `ready` within the budget means the child never got as far as the
    // protocol; there is nothing to ask politely.
    readyTimer = setTimeout(() => {
      if (!ready && !settled) {
        reported = {
          status: "failed",
          error: serializeError(
            new ChildExitError(null, null, {
              runId: context.runId,
              reason: "the child never reported ready",
            }),
          ),
        };
        child.kill("SIGKILL");
      }
    }, this.options.startTimeout);
    readyTimer.unref?.();

    timeoutTimer =
      options.timeout > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            // A timed-out run stays a timeout even if the child then exits
            // cleanly: the deadline is what it missed.
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

    this.#pipe(child, options);

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

  /** Routes one child message to the run's callbacks. */
  #onMessage<TArgs>(
    message: ChildToParent,
    options: ExecutorStartOptions<TArgs>,
    hooks: {
      onReady: () => void;
      onResult: (outcome: RunOutcome) => void;
    },
  ): void {
    switch (message.t) {
      case "ready":
        hooks.onReady();
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
      case "done":
        hooks.onResult({ status: "success", result: message.result });
        break;
      case "error":
        hooks.onResult({ status: "failed", error: message.error });
        break;
      default:
        break;
    }
  }

  /** Tees a piped stream to the parent's own stdio and the `output` event. */
  #pipe<TArgs>(
    child: Subprocess<any, any, any>,
    options: ExecutorStartOptions<TArgs>,
  ): void {
    const forward = (
      stream: ReadableStream<Uint8Array> | number | undefined | null,
      name: "stdout" | "stderr",
    ): void => {
      if (!stream || typeof stream === "number") {
        // Asked for a pipe and given a descriptor: there is nothing to read,
        // and saying so beats leaving a reader waiting out its grace window.
        options.events.onOutputEnd?.(name);
        return;
      }

      void (async () => {
        const decoder = new TextDecoder();
        try {
          for await (const chunk of stream) {
            const text = decoder.decode(chunk, { stream: true });
            options.events.onOutput(name, text);
            // Keep the child's output visible: piping it must not swallow it.
            if (name === "stdout") {
              process.stdout.write(text);
            } else {
              process.stderr.write(text);
            }
          }
        } catch {
          // The stream ends when the child does; nothing to report.
        } finally {
          // Reported however the loop left, so a reader waiting for the tail
          // of a crashed child's output is never left waiting.
          options.events.onOutputEnd?.(name);
        }
      })();
    };

    if (this.options.stdout === "pipe") {
      forward(child.stdout as ReadableStream<Uint8Array>, "stdout");
    }
    if (this.options.stderr === "pipe") {
      forward(child.stderr as ReadableStream<Uint8Array>, "stderr");
    }
  }
}

/** The part of a start request that can cross the boundary. */
export function toSerializable<TArgs>(
  options: ExecutorStartOptions<TArgs>,
): SerializableContext<TArgs> {
  const { context } = options;

  return {
    runId: context.runId,
    runnerId: context.runnerId,
    runnerName: context.runnerName,
    namespace: context.namespace,
    attempt: context.attempt,
    source: context.source,
    mode: context.mode,
    startedAt: context.startedAt,
    deadline: context.deadline,
    args: context.args,
    ...(context.driverConfig ? { driverConfig: context.driverConfig } : {}),
    file: options.file,
    closeTimeout: options.closeTimeout,
    forwardLogs: options.forwardLogs ?? false,
    ...(options.captureConsole ? { captureConsole: true } : {}),
    ...(options.kind === "job" && options.job
      ? { kind: "job" as const, job: options.job }
      : {}),
  };
}
