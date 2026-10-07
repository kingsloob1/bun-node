import type { ChildToParent, ParentToChild } from "../protocol";
import type { RuntimeToEntry } from "./container-runtime";
import process from "node:process";
// The deep path, as in `child-runtime.ts`: the barrel's HTTP layer is slow to
// load and a runner never uses it.
import { serializeError } from "@kingsleyweb/bun-common/lib/utils/native";
import { RunKilledError } from "../../shared/errors";
import { CHILD_ENV, CLOSE_EXIT_CODE } from "../protocol";

/**
 * `@kingsleyweb/bun-jobs/container-entry`: the runner inside a `container`
 * target's image.
 *
 * The worker starts each container as `bun -e <bootstrap> <prefix>
 * <processor>` (under the engine's `--init`), and the bootstrap imports this
 * module from the processor's directory, where the image's copy of bun-jobs
 * is. It speaks the child protocol — the same messages, and the same closed
 * list of job operations, as a `child-process` attempt — over the
 * container's stdio:
 *
 * - **stdin** carries the worker's messages, one JSON line each;
 * - **stdout** carries this runner's messages, each on a line of its own —
 *   a newline first, so output the processor left without one cannot run
 *   into it — as `<prefix> <json>`. The prefix is random per container and
 *   given on the command line, so a line the processor itself prints — which
 *   has none — is taken for its output, never for a message.
 *
 * **Two threads.** The processor runs in a `Worker` (`container-runtime.ts`),
 * and this module, on the main thread, only relays the channel and watches.
 * So a processor that blocks its thread for good still cannot keep the
 * container alive once nobody wants it: the main thread's event loop stays
 * free to see stdin end or a `SIGTERM`, and to exit the process.
 *
 * - A `close` before `start` is honoured as a `child-process` runner
 *   honours it: the processor is never imported.
 * - **The end of stdin** is how a container learns its worker has gone.
 *   Before `start` it exits at once (143). After it, the run is closed as
 *   killed, which ends a processor that honours its signal, and the process
 *   exits 143 at `closeTimeout` at the latest, whatever the processor is
 *   doing.
 * - **`SIGTERM`** (a `docker stop`) is handled the same way, with the run's
 *   outcome reported as a `RunKilledError` whatever the processor then
 *   returns — the stop decides, as a worker's own stop does — and an exit of
 *   143.
 *
 * Importing it does nothing unless the container markers are set
 * (`BUN_JOBS_MODE=container` and a prefix on the command line), so a
 * module graph that merely reaches it starts no protocol.
 */

/** The two arguments the bootstrap passes: the line prefix, then the processor. */
const [prefix, processor] = process.argv.slice(-2);

/** A prefix the worker generated: 32 hex digits. */
const PREFIX = /^[\da-f]{32}$/;

/** The `closeTimeout` a run has when its `start` has not said, in ms. */
const DEFAULT_RUN_CLOSE_TIMEOUT = 5_000;

if (
  process.env[CHILD_ENV.mode] === "container" &&
  typeof prefix === "string" &&
  PREFIX.test(prefix) &&
  typeof processor === "string"
) {
  serve(prefix);
}

/** Relays the child protocol between stdio and the runtime's `Worker`. */
function serve(linePrefix: string): void {
  /** Writes still on their way to stdout, which an exit waits for. */
  let pending = 0;
  let flushed: (() => void) | undefined;
  /** Whether `start` has arrived. */
  let started = false;
  /** The run id `start` named, for a close the watchdog sends. */
  let runId: string | undefined;
  /** The run's `closeTimeout`, from its `start`. */
  let closeTimeout = DEFAULT_RUN_CLOSE_TIMEOUT;
  /** Set by `SIGTERM`: the run's outcome is a kill, and the exit 143. */
  let terminated = false;
  /** Set once the watchdog has closed the run and armed its hard exit. */
  let closing = false;
  /** Set once the run's outcome (`done` or `error`) has been written. */
  let reported = false;

  const send = (outgoing: ChildToParent): void => {
    // After a `SIGTERM` the stop decides how the run ended, as a worker's
    // stop does: a result the processor returns while unwinding is not one.
    const message: ChildToParent =
      terminated && (outgoing.t === "done" || outgoing.t === "error")
        ? {
            t: "error",
            runId: outgoing.runId,
            error: serializeError(
              new RunKilledError("SIGTERM", { runId: outgoing.runId }),
            ),
          }
        : outgoing;
    if (message.t === "done" || message.t === "error") {
      reported = true;
    }
    pending++;
    process.stdout.write(`\n${linePrefix} ${JSON.stringify(message)}\n`, () => {
      pending--;
      if (pending === 0) {
        flushed?.();
      }
    });
  };

  /** Ends the process once every channel line has been written. */
  const exit = (code: number): void => {
    // A stopped run whose processor never let go — the runtime exiting
    // itself, or the watchdog — still ends as stopped, for anyone reading.
    if (terminated && started && !reported && runId !== undefined) {
      send({
        t: "error",
        runId,
        error: serializeError(new RunKilledError("SIGTERM", { runId })),
      });
    }
    const end = () => process.exit(terminated ? CLOSE_EXIT_CODE : code);
    if (pending === 0) {
      end();
      return;
    }
    flushed = end;
    // A stdout nobody reads any more must not keep a finished run alive.
    setTimeout(end, 2_000).unref?.();
  };

  // The same last two arguments as this process, so a processor reading its
  // argv sees what it would on the main thread; a `Worker` is otherwise
  // given none.
  const runtime = new Worker(
    new URL("./container-runtime.ts", import.meta.url).href,
    { argv: process.argv.slice(-2) },
  );
  runtime.onmessage = (event: MessageEvent<RuntimeToEntry>) => {
    const data = event.data;
    if ("send" in data) {
      send(data.send);
    } else if ("exit" in data) {
      exit(data.exit);
    }
  };
  runtime.onerror = () => {
    // The runtime could not load or crashed outside the protocol, which
    // reports every processor failure itself.
    exit(1);
  };

  const toRuntime = (message: ParentToChild): void => {
    if (message?.t === "start") {
      started = true;
      runId = message.runId;
      if (typeof message.ctx?.closeTimeout === "number") {
        closeTimeout = message.ctx.closeTimeout;
      }
    }
    runtime.postMessage(message);
  };

  /**
   * The watchdog: closes the run, and exits 143 at `closeTimeout` whatever
   * the processor's thread is doing. Before `start` there is nothing to
   * unwind, and the processor is never imported.
   */
  const closeRun = (reason: "kill" | "stop"): void => {
    if (!started || runId === undefined) {
      exit(CLOSE_EXIT_CODE);
      return;
    }
    if (closing) {
      return;
    }
    closing = true;
    runtime.postMessage({ t: "close", runId, reason } satisfies ParentToChild);
    // Ref'd: it may be the only thing left on this thread's loop.
    setTimeout(exit, closeTimeout, CLOSE_EXIT_CODE);
  };

  // With `--init`, the engine's init forwards a `docker stop` here; without
  // one, Bun is PID 1, which ignores a signal it has no handler for.
  process.on("SIGTERM", () => {
    terminated = true;
    closeRun("stop");
  });

  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const chunk of Bun.stdin.stream()) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
          if (line.trim().length === 0) {
            continue;
          }
          let message: ParentToChild;
          try {
            message = JSON.parse(line) as ParentToChild;
          } catch {
            continue;
          }
          toRuntime(message);
        }
      }
    } catch {
      // A stdin that fails is a stdin that ended.
    }
    // The worker is gone: nobody will read a result.
    closeRun("kill");
  })();
}
