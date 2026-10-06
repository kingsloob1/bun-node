import type { ChildToParent, ParentToChild } from "../protocol";
import process from "node:process";
import { CHILD_ENV } from "../protocol";
import { runChildProtocol } from "./child-runtime";

/**
 * `@kingsleyweb/bun-jobs/container-entry`: the runner inside a `container`
 * target's image.
 *
 * The worker starts each container as `bun -e <bootstrap> <prefix>
 * <processor>`, and the bootstrap imports this module from the processor's
 * directory, where the image's copy of bun-jobs is. It speaks the child
 * protocol — the same messages, and the same closed list of job operations,
 * as a `child-process` attempt — over the container's stdio:
 *
 * - **stdin** carries the worker's messages, one JSON line each;
 * - **stdout** carries this runner's messages, each line `<prefix> <json>`.
 *   The prefix is random per container and given on the command line, so a
 *   line the processor itself prints — which has none — is taken for its
 *   output, never for a message.
 *
 * A `close` before `start` is honoured as a `child-process` runner honours
 * it: the processor is never imported. So is the end of stdin, which is how
 * a container learns its worker has gone: before `start` it exits at once
 * (143), and after it the run is closed as killed.
 *
 * Importing it does nothing unless the container markers are set
 * (`BUN_JOBS_MODE=container` and a prefix on the command line), so a
 * module graph that merely reaches it starts no protocol.
 */

/** The two arguments the bootstrap passes: the line prefix, then the processor. */
const [prefix, processor] = process.argv.slice(-2);

/** A prefix the worker generated: 32 hex digits. */
const PREFIX = /^[\da-f]{32}$/;

if (
  process.env[CHILD_ENV.mode] === "container" &&
  typeof prefix === "string" &&
  PREFIX.test(prefix) &&
  typeof processor === "string"
) {
  serve(prefix);
}

/** Runs the child protocol over this process's stdio until the run ends. */
function serve(linePrefix: string): void {
  const listeners: ((message: ParentToChild) => void)[] = [];
  /** Writes still on their way to stdout, which an exit waits for. */
  let pending = 0;
  let flushed: (() => void) | undefined;
  /** Whether `start` has arrived. */
  let started = false;
  /** The run id `start` named, for a close the end of stdin stands for. */
  let runId: string | undefined;

  const send = (message: ChildToParent): void => {
    pending++;
    process.stdout.write(`${linePrefix} ${JSON.stringify(message)}\n`, () => {
      pending--;
      if (pending === 0) {
        flushed?.();
      }
    });
  };

  /** Ends the process once every channel line has been written. */
  const exit = (code: number): void => {
    const end = () => process.exit(code);
    if (pending === 0) {
      end();
      return;
    }
    flushed = end;
    // A stdout nobody reads any more must not keep a finished run alive.
    setTimeout(end, 2_000).unref?.();
  };

  const dispatch = (message: ParentToChild): void => {
    if (message?.t === "start") {
      started = true;
      runId = message.runId;
    }
    for (const listener of [...listeners]) {
      listener(message);
    }
  };

  runChildProtocol({
    send,
    onMessage: (listener) => {
      listeners.push(listener);
    },
    exit,
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
          dispatch(message);
        }
      }
    } catch {
      // A stdin that fails is a stdin that ended.
    }
    // The worker is gone: nobody will read a result. Before `start` there is
    // nothing to unwind, and the processor is never imported.
    if (!started || runId === undefined) {
      exit(143);
      return;
    }
    dispatch({ t: "close", runId, reason: "kill" });
  })();
}
