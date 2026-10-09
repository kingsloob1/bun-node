import type { Subprocess } from "bun";
import type {
  ExecutorHandle,
  ExecutorStartOptions,
  RunOutcome,
} from "../../runner/executors/executor";
import type { ChildToParent, ParentToChild } from "../../runner/protocol";
import type { ContainerOwner, ResolvedContainerTarget } from "./target";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { createDeferred, serializeError } from "@kingsleyweb/bun-common";
import {
  FRAME_BYTES,
  FrameDecoder,
} from "../../runner/bootstrap/container-frames";
import { toSerializable } from "../../runner/executors/spawn";
import {
  CHILD_ENV,
  JOB_CHANNEL,
  PROTOCOL_VERSION,
} from "../../runner/protocol";
import {
  ChildExitError,
  JobTimeoutError,
  ProtocolError,
  RunKilledError,
  UnrecoverableJobError,
} from "../../shared/errors";
import { stringifyBounded } from "../../shared/json";
import { clipStderr, ContainerEngine, containerName } from "./engine";
import { LineReader } from "./lines";
import {
  CONTAINER_BOOTSTRAP,
  CONTAINER_MAX_MESSAGE_BYTES,
  containerRunArgs,
} from "./target";

/** How long a container has to report `ready`, in ms: a cold start is ~0.3 s, and much more under load. */
export const CONTAINER_START_TIMEOUT = 60_000;

/** How many times a kill retries the removal while the CLI is still creating the container. */
const KILL_RETRIES = 40;

/** How many stderr lines an attempt keeps for its error message. */
const TAIL_LINES = 20;

/** The most characters of one stderr line kept for the error message. */
const TAIL_LINE_CHARS = 2_000;

/** The CLI's own exit codes: the engine refused (125), or the command could not run (126, 127). */
const ENGINE_CODES: ReadonlySet<number> = new Set([125, 126, 127]);

/** How long after the CLI exits its pipes may take to deliver their last lines, in ms. */
const DRAIN_GRACE = 2_000;

/**
 * Runs one attempt per container: the parent half of the stdio channel.
 *
 * **The channel.** The container's stdin carries the worker's messages, one
 * JSON line each. Its stdout carries the runner's messages, in frames of at
 * most 4096 bytes, each written whole on a line of its own starting with a
 * random prefix generated per container and passed on its command line
 * (`container-frames.ts`), so nothing else writing to stdout can land inside
 * one. Every other line — one containing the prefix included — is the job's
 * own output (a stray `console.log`, a subprocess) and becomes a job log
 * line, as stderr's lines do. A job can forge frames, but only for its own
 * attempt, whose result it could misreport anyway. The messages are the
 * child channel's, unchanged.
 *
 * **Bounds.** Every message sent is bounded by `stringifyBounded`, and every
 * message read by {@link CONTAINER_MAX_MESSAGE_BYTES}, from its first frame's
 * count: a message past it fails the attempt for good (an
 * `UnrecoverableJobError`), never truncated.
 * The job's own output is kept up to the target's `maxLogBytes`.
 *
 * **Stopping.** `stop` sends `close` on the channel; after `closeTimeout` the
 * container is killed by name (`kill`, then `rm --force`), which also covers
 * a container still being created: removal is retried until the CLI exits.
 * A forced `stop` kills at once, with no `close` first. A `stop` that lands
 * after the result arrived kills nothing: the runner is already exiting. One
 * that lands before it decides the attempt (`killed`); if the processor
 * still finished and its container exited 0 before the kill took, the
 * outcome is `killed` with exit code 0 — what happened, both halves of it.
 * The CLI process itself is never the thing killed while it has a container,
 * since killing it leaves the container running. A killed attempt reports
 * exit code 137, as the container's own kill does.
 *
 * `done` settles when the CLI has exited and the outcome is known; `exited`
 * once the container is gone, which for an attached `docker run --rm` is
 * when the CLI exits by itself — after a kill too, without waiting for the
 * `kill` and `rm` commands to return. A CLI that died of a signal is
 * followed by a removal by name before `exited` settles.
 */
export class ContainerExecutor {
  /** The engine every attempt's container runs on. */
  readonly engine: ContainerEngine;
  /**
   * The kills still running after their attempt's `exited` has settled: the
   * `docker kill` and `docker rm --force` commands, which return after the
   * container they removed is already gone. Kept so they are not lost track
   * of; nothing waits for them.
   */
  readonly removals = new Set<Promise<void>>();

  constructor(
    /** The resolved target. */
    private readonly target: ResolvedContainerTarget,
    /** Whose containers these are, for their labels. */
    private readonly owner: ContainerOwner,
    /** The processor's path inside the image. */
    private readonly processor: string,
    /** How long a container has to report ready, in ms. */
    private readonly startTimeout: number = CONTAINER_START_TIMEOUT,
  ) {
    this.engine = new ContainerEngine(target);
  }

  /** The variables bun-jobs sets in every container, for one run. */
  markers(runId: string): Record<string, string> {
    return containerMarkers(this.owner, runId, this.processor);
  }

  /** Starts one attempt in a fresh container. */
  start<TArgs>(options: ExecutorStartOptions<TArgs>): ExecutorHandle {
    const outcome = createDeferred<RunOutcome>();
    const gone = createDeferred<void>();
    const context = { ...toSerializable(options), file: this.processor };
    const { runId } = context;
    const name = containerName();
    const prefix = randomBytes(16).toString("hex");
    const marker = `${prefix} `;
    const events = options.events;
    const { maxLogBytes } = this.target;

    /** How the run ended, once something decided it. */
    let reported: RunOutcome | undefined;
    let settled = false;
    let ready = false;
    let cliExited = false;
    /** The forced removal, once begun. */
    let killing: Promise<void> | undefined;
    /** The job's own output kept so far, in bytes. */
    let logBytes = 0;
    let logCut = false;
    /**
     * The last lines of stderr, for an error that names why: at most
     * {@link TAIL_LINES} lines of at most {@link TAIL_LINE_CHARS} characters
     * each, so a container writing huge stderr lines costs the worker a few
     * kilobytes here, not the lines.
     */
    const tail: string[] = [];
    /** Set when the runner's result (`done` or `error`) has arrived. */
    let resulted = false;
    /**
     * Channel messages dropped as cut off or unreadable, each once however
     * many frames it had (the decoder reports a message, not its frames).
     * The first is warned about at once, the rest only counted: a processor
     * forging frames could otherwise write the worker's log a warning per
     * line.
     */
    let dropped = 0;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: unknown): RunOutcome => ({
      status: "failed",
      error: serializeError(error),
    });

    const failToStart = (error: unknown): ExecutorHandle => {
      const done = Promise.resolve(fail(error));
      return {
        done,
        exited: Promise.resolve(),
        stop: () => {},
        send: () => false,
      };
    };

    let proc: Subprocess<"pipe", "pipe", "pipe">;
    try {
      const env = this.engine.env();
      proc = Bun.spawn(
        [
          this.engine.path(env),
          ...containerRunArgs(this.target, {
            name,
            owner: this.owner,
            prefix,
            processor: this.processor,
            script: CONTAINER_BOOTSTRAP,
            markers: this.markers(runId),
          }),
        ],
        { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
    } catch (error) {
      return failToStart(error);
    }
    if (!options.waitToExit) {
      proc.unref();
    }

    /** Writes one message to the container's stdin; `false` when it could not. */
    const write = (message: ParentToChild): "sent" | "too-large" | "closed" => {
      const json = stringifyBounded(message, CONTAINER_MAX_MESSAGE_BYTES);
      if (json.startsWith('{"__truncated":true')) {
        return "too-large";
      }
      try {
        proc.stdin.write(`${json}\n`);
        void Promise.resolve(proc.stdin.flush()).catch(() => undefined);
        return "sent";
      } catch {
        return "closed";
      }
    };

    /** Removes the container by name, for certain, once. */
    const kill = (): Promise<void> => {
      killing ??= (async () => {
        await this.engine
          .exec(["kill", "--signal=KILL", name])
          .catch(() => undefined);
        await this.engine.exec(["rm", "--force", name]).catch(() => undefined);
        // Removing a container that does not exist yet does nothing, and the
        // CLI may still be creating it: try again until the CLI, which waits
        // on the container it started, has exited.
        const gone = () => cliExited;
        for (let tries = 1; !gone() && tries <= KILL_RETRIES; tries++) {
          // Woken by the CLI's exit, so a removal that took is seen at once.
          await Promise.race([
            proc.exited,
            Bun.sleep(Math.min(tries, 4) * 250),
          ]);
          if (!gone()) {
            await this.engine
              .exec(["rm", "--force", name])
              .catch(() => undefined);
          }
        }
        if (!cliExited) {
          // Nothing left to remove after all that: the CLI is stuck, not a
          // container, so the CLI goes.
          proc.kill("SIGKILL");
        }
      })();
      return killing;
    };

    const settle = (result: RunOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(readyTimer);
      clearTimeout(timeoutTimer);
      outcome.resolve(result);
    };

    const tooLarge = (what: string, bytes: number): UnrecoverableJobError =>
      new UnrecoverableJobError(
        `The container channel refused ${what} of ${bytes} bytes, over its limit of ${CONTAINER_MAX_MESSAGE_BYTES}`,
        {
          runId,
          bytes,
          maxBytes: CONTAINER_MAX_MESSAGE_BYTES,
          reason: "payload-too-large",
        },
      );

    /** The job's own output, kept up to `maxLogBytes`. */
    const output = (stream: "stdout" | "stderr", line: string): void => {
      if (logCut) {
        return;
      }
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (logBytes + bytes > maxLogBytes) {
        logCut = true;
        events.onOutputLimit?.(maxLogBytes, logBytes + bytes);
        return;
      }
      logBytes += bytes;
      events.onOutput(stream, line);
    };

    const onChannel = (message: ChildToParent): void => {
      switch (message?.t) {
        case "ready":
          if (message.protocol !== PROTOCOL_VERSION) {
            reported ??= fail(
              new ProtocolError(
                "container channel",
                `the image's bun-jobs speaks protocol ${String(message.protocol)}, this worker ${PROTOCOL_VERSION}`,
                { runId },
              ),
            );
            void kill();
            return;
          }
          if (ready) {
            return;
          }
          ready = true;
          clearTimeout(readyTimer);
          if (killing) {
            return;
          }
          // Sent even when a stop has already been asked for: the runner
          // inside has the `close` already, and ends the run without
          // importing the processor.
          if (write({ t: "start", runId, ctx: context }) === "too-large") {
            const bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
            reported ??= fail(tooLarge("the job's input", bytes));
            void kill();
          }
          break;
        case "progress":
          events.onProgress(message.value);
          break;
        case "message":
          events.onMessage(message.data);
          break;
        case "log":
          events.onLog(message.level, message.message, message.fields);
          break;
        case "done":
          resulted = true;
          reported ??= { status: "success", result: message.result };
          break;
        case "error":
          resulted = true;
          reported ??= { status: "failed", error: message.error };
          break;
        default:
          break;
      }
    };

    /** Warns about the first dropped channel message; counts the rest. */
    const drop = (message: string, fields: Record<string, unknown>): void => {
      dropped++;
      if (dropped === 1) {
        events.onLog("warn", message, fields);
      }
    };

    /**
     * The longest line read from the container: `maxLogBytes`, since no line
     * longer than that can be kept as output anyway and no frame is longer
     * than {@link FRAME_BYTES}; never under a frame, never over 16 MiB. A
     * longer line is kept as its first bytes and its length, so a container
     * writing long lines, forged frames among them, costs the worker this
     * much per stream rather than the lines.
     */
    const lineCap = Math.min(
      CONTAINER_MAX_MESSAGE_BYTES,
      Math.max(FRAME_BYTES, maxLogBytes),
    );
    const frames = new FrameDecoder(
      marker.trimEnd(),
      CONTAINER_MAX_MESSAGE_BYTES,
    );
    const stdout = new LineReader(
      lineCap,
      (line) => {
        // A channel frame is a whole line starting with the prefix
        // (`container-frames.ts`); every other line — a line the processor
        // printed with the prefix in it included — is its output.
        const read = frames.push(line);
        if (read === undefined) {
          return;
        }
        if ("text" in read) {
          // The runner's own newline before each frame leaves an empty line
          // whenever the output before it had ended its own.
          if (line.length > 0) {
            output("stdout", line);
          }
          return;
        }
        if ("tooLarge" in read) {
          reported ??= fail(
            tooLarge("a message from the container", read.tooLarge),
          );
          void kill();
          return;
        }
        if ("broken" in read) {
          drop("A message on the container channel was cut off and dropped", {
            runId,
          });
          return;
        }
        if (read.cutOff) {
          drop("A message on the container channel was cut off and dropped", {
            runId,
          });
        }
        let message: ChildToParent;
        try {
          message = JSON.parse(read.message) as ChildToParent;
        } catch {
          drop("An unreadable message on the container channel was dropped", {
            runId,
            bytes: read.message.length,
          });
          return;
        }
        onChannel(message);
      },
      (head, bytes) => {
        // No frame is this long: whatever its start, it is output.
        output("stdout", `${head}… [a line of ${bytes} bytes, cut]`);
      },
    );
    const stderr = new LineReader(
      lineCap,
      (line) => {
        // Clipped on the way in, and copied: the line itself can be up to
        // `lineCap`, and a slice of a long string can keep the whole of it
        // alive.
        tail.push(
          line.length > TAIL_LINE_CHARS
            ? Buffer.from(line.slice(0, TAIL_LINE_CHARS), "utf8").toString(
                "utf8",
              )
            : line,
        );
        if (tail.length > TAIL_LINES) {
          tail.shift();
        }
        output("stderr", line);
      },
      (head, bytes) =>
        output("stderr", `${head}… [a line of ${bytes} bytes, cut]`),
    );

    const drain = async (
      stream: ReadableStream<Uint8Array>,
      reader: LineReader,
    ): Promise<void> => {
      try {
        for await (const chunk of stream) {
          reader.push(chunk);
        }
      } catch {
        // The stream ends with the CLI; nothing to report.
      } finally {
        reader.end();
      }
    };
    const drained = Promise.all([
      drain(proc.stdout, stdout),
      drain(proc.stderr, stderr),
    ]);

    readyTimer = setTimeout(() => {
      if (!ready && !settled) {
        reported ??= fail(
          new ChildExitError(null, null, {
            runId,
            reason: "the container never reported ready",
            stderr: clipStderr(tail.join("\n")),
          }),
        );
        void kill();
      }
    }, this.startTimeout);
    readyTimer.unref?.();

    const escalate = (
      reason: "timeout" | "stop" | "kill" | "lock-lost",
      force = false,
    ): void => {
      if (settled) {
        return;
      }
      if (force) {
        void kill();
        return;
      }
      write({ t: "close", runId, reason });
      const timer = setTimeout(() => {
        if (!settled) {
          void kill();
        }
      }, this.target.closeTimeout);
      timer.unref?.();
    };

    timeoutTimer =
      options.timeout > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            reported ??= {
              status: "timeout",
              error: serializeError(
                new JobTimeoutError(options.timeout, { runId }),
              ),
            };
            escalate("timeout");
          }, options.timeout)
        : undefined;
    timeoutTimer?.unref?.();

    void (async () => {
      const code = await proc.exited;
      cliExited = true;
      // The pipes close with the CLI; a bounded wait for their last lines.
      await Promise.race([drained, Bun.sleep(DRAIN_GRACE)]);
      const killed = killing !== undefined;
      // The CLI's own codes — 125 the engine refused, 126 and 127 the
      // command could not run — before the runner said `ready`: no container
      // ran a runner, so there is no container exit code to report.
      const engineError = ENGINE_CODES.has(code) && !ready;
      // A container this worker killed reports what the kill made of it:
      // 137, or 143 when the runner inside stopped itself first, or 0 when
      // its result had arrived and it exited cleanly before the kill took.
      // Never the CLI's own code, nor a signal the CLI died of.
      const exitCode = killed
        ? code === 143 || (code === 0 && resulted)
          ? code
          : 137
        : proc.signalCode !== null || engineError
          ? null
          : code;
      const stderrText = clipStderr(tail.join("\n"));
      if (dropped > 1) {
        events.onLog(
          "warn",
          `${dropped} messages on the container channel were dropped as cut off or unreadable in all`,
          { runId, dropped },
        );
      }
      settle({
        ...(reported ??
          fail(
            engineError
              ? new ChildExitError(null, null, {
                  runId,
                  reason: "the container could not be started",
                  stderr: stderrText,
                })
              : new ChildExitError(exitCode, null, {
                  runId,
                  stderr: stderrText,
                }),
          )),
        exitCode,
        signal: killed && exitCode === 137 ? "SIGKILL" : null,
      });

      // Gone, not merely decided. The CLI is attached and runs with `--rm`,
      // so when it exits by itself the engine has already destroyed the
      // container — killed by name or not: the `kill` and `rm` commands of a
      // kill go on in the background (tracked in `removals`), and `exited`
      // does not wait for those CLIs to return, which took longer than the
      // container itself. One whose CLI did not end normally is removed by
      // name first.
      if (killing) {
        if (proc.signalCode !== null) {
          await killing;
        } else {
          this.removals.add(killing);
          void killing.finally(() => this.removals.delete(killing!));
        }
      } else if (proc.signalCode !== null || engineError) {
        await this.engine.exec(["rm", "--force", name]).catch(() => undefined);
      }
      gone.resolve();
    })();

    return {
      done: outcome.promise,
      exited: gone.promise,
      stop: (reason, stopOptions) => {
        if (resulted) {
          // The result is in, and the runner exits by itself once it has
          // written it: killing now would only report a kill that did not
          // decide anything. A backstop, in case it never exits.
          const backstop = setTimeout(() => {
            if (!cliExited) {
              void kill();
            }
          }, this.target.closeTimeout);
          backstop.unref?.();
          return;
        }
        reported ??= {
          status: "killed",
          error: serializeError(new RunKilledError(reason, { runId })),
        };
        escalate("kill", stopOptions?.force);
      },
      send: (message) => {
        const sent = write({ t: "message", runId, data: message });
        if (sent !== "too-large") {
          return sent === "sent";
        }
        // A reply too large to send goes back as the error it is, so the
        // processor's request rejects rather than waiting for ever.
        const reply = message as Record<string, unknown> | null;
        if (
          reply &&
          typeof reply === "object" &&
          reply[JOB_CHANNEL] === "reply"
        ) {
          const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
          return (
            write({
              t: "message",
              runId,
              data: {
                [JOB_CHANNEL]: "reply",
                seq: reply.seq,
                error: serializeError(tooLarge("a reply", bytes)),
              },
            }) === "sent"
          );
        }
        return false;
      },
    };
  }
}

/** The job log line that says a container attempt's output was cut. */
export function containerOutputCutNotice(maxLogBytes: number): string {
  return `[bun-jobs] container output cut at maxLogBytes (${maxLogBytes} bytes): the rest of this attempt's stdout and stderr was dropped`;
}

/** The variables bun-jobs sets in a container for one run. */
export function containerMarkers(
  owner: ContainerOwner,
  runId: string,
  processor: string,
): Record<string, string> {
  return {
    [CHILD_ENV.marker]: "1",
    [CHILD_ENV.mode]: "container",
    [CHILD_ENV.namespace]: owner.namespace,
    [CHILD_ENV.runnerId]: owner.queue,
    [CHILD_ENV.runId]: runId,
    [CHILD_ENV.file]: processor,
  };
}
