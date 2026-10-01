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
import { buildChildEnv } from "../../shared/childEnv";
import {
  ChildExitError,
  JobTimeoutError,
  OutputLimitError,
  RunKilledError,
} from "../../shared/errors";
import { CHILD_ENV } from "../protocol";
import { closeChildCgroup, openChildCgroup } from "./spawnHardening";

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

    // Built now, from the live `process.env`, and always passed: `Bun.spawn`
    // with no `env` would hand the child the environment this process
    // *started* with. The allowlist is the default; see `SpawnOptions.env`.
    const inherit = this.options.env === "inherit";

    /** This run's own cgroup, when `cgroup` asks for one. */
    let cgroup: string | undefined;
    /** Set when the child's output went over `maxBuffer`. */
    let overflowed = false;

    /**
     * Ends a run whose child never started — its cgroup could not be made,
     * or the spawn itself failed — as a failed run rather than a throw, so a
     * caller sees it the way it sees any other failure.
     */
    const failToStart = (error: unknown): ExecutorHandle => {
      const release = cgroup ? closeChildCgroup(cgroup) : Promise.resolve();
      for (const name of ["stdout", "stderr"] as const) {
        if (this.options[name] === "pipe") {
          options.events.onOutputEnd?.(name);
        }
      }
      return {
        done: release.then(() => ({
          status: "failed",
          error: serializeError(error),
        })),
        stop: () => {},
        send: () => false,
      };
    };

    try {
      if (this.options.cgroup) {
        cgroup = openChildCgroup(this.options.cgroup, context.runId);
      }
    } catch (error) {
      return failToStart(error);
    }

    try {
      child = Bun.spawn(
        [
          this.options.execPath ?? process.execPath,
          // Under the allowlist, Bun must not load a `.env` from the child's
          // cwd: measured on 1.4.3, a child given only `PATH` still read every
          // variable in it. A flag before the entry, so it reaches Bun.
          ...(inherit ? [] : ["--no-env-file"]),
          SpawnExecutor.entry,
          ...(this.options.args ?? []),
        ],
        {
          cwd: this.options.cwd,
          ...(this.options.uid === undefined ? {} : { uid: this.options.uid }),
          ...(this.options.gid === undefined ? {} : { gid: this.options.gid }),
          ...(cgroup === undefined ? {} : { cgroup }),
          env: {
            ...buildChildEnv(this.options),
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
            const outcome: RunOutcome = {
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
            };

            if (cgroup === undefined) {
              settle(outcome);
              return;
            }
            // The run is over only once what it left in its cgroup is gone:
            // a process it started and did not wait for is killed here.
            void closeChildCgroup(cgroup).then(() => settle(outcome));
          },
        },
      );
    } catch (error) {
      return failToStart(error);
    }

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

    this.#pipe(child, options, (outputBytes) => {
      // Over `maxBuffer`: the child is killed outright, and the run fails
      // with the limit — unless something else already decided how it ended.
      if (overflowed || settled) {
        return;
      }
      overflowed = true;
      reported ??= {
        status: "failed",
        error: serializeError(
          new OutputLimitError(this.options.maxBuffer!, outputBytes, {
            runId: context.runId,
          }),
        ),
      };
      child.kill("SIGKILL");
    });

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

  /**
   * Tees a piped stream to the parent's own stdio and the `output` event.
   *
   * With `maxBuffer`, output is forwarded a whole line at a time and counted
   * across both streams; the chunk that crosses the limit is cut after its
   * last newline that fits, nothing after it is forwarded, and `onOverflow`
   * is called once with the bytes written so far. Cutting only at a newline
   * keeps every stored line whole, so redaction — which matches within a
   * line — never sees half a secret it would have caught in full.
   */
  #pipe<TArgs>(
    child: Subprocess<any, any, any>,
    options: ExecutorStartOptions<TArgs>,
    onOverflow: (bytes: number) => void,
  ): void {
    const limit = this.options.maxBuffer;
    /** Bytes read from both streams so far. */
    let total = 0;
    /** Set once over the limit: from then on nothing is forwarded. */
    let over = false;

    /** Hands text on to the `output` event and this process's own stream. */
    const emit = (name: "stdout" | "stderr", text: string): void => {
      if (text.length === 0) {
        return;
      }
      options.events.onOutput(name, text);
      // Keep the child's output visible: piping it must not swallow it.
      if (name === "stdout") {
        process.stdout.write(text);
      } else {
        process.stderr.write(text);
      }
    };

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
        /** With a limit: the text after this stream's last newline. */
        let pending = "";
        try {
          for await (const chunk of stream) {
            if (limit === undefined) {
              emit(name, decoder.decode(chunk, { stream: true }));
              continue;
            }
            if (over) {
              // Drained, so the child is never blocked on a full pipe while
              // it is being killed, but no longer forwarded.
              continue;
            }
            total += chunk.byteLength;
            if (total <= limit) {
              const text = pending + decoder.decode(chunk, { stream: true });
              const end = text.lastIndexOf("\n") + 1;
              emit(name, text.slice(0, end));
              pending = text.slice(end);
              continue;
            }
            // The part of this chunk that fits, cut after its last newline.
            // A newline byte is never inside a UTF-8 sequence, so the cut is
            // on a character boundary.
            const fits = chunk.byteLength - (total - limit);
            const newline = chunk.subarray(0, fits).lastIndexOf(0x0a);
            if (newline >= 0) {
              emit(
                name,
                pending +
                  decoder.decode(chunk.subarray(0, newline + 1), {
                    stream: true,
                  }),
              );
            }
            pending = "";
            over = true;
            onOverflow(total);
          }
          if (limit !== undefined && !over) {
            // The stream's last, unterminated line: whole, since it fitted.
            emit(name, pending + decoder.decode());
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
    ...(options.collationChecked?.length
      ? { collationChecked: [...options.collationChecked] }
      : {}),
    file: options.file,
    closeTimeout: options.closeTimeout,
    forwardLogs: options.forwardLogs ?? false,
    ...(options.captureConsole ? { captureConsole: true } : {}),
    ...(options.kind === "job" && options.job
      ? { kind: "job" as const, job: options.job }
      : {}),
  };
}
