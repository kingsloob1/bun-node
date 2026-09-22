import type { ConsoleSink } from "./consolePatch";
import { AsyncLocalStorage } from "node:async_hooks";
import { patchConsole } from "./consolePatch";

/**
 * Capturing what an `in-process` run writes with `console.*`, which it shares
 * with the host and with every other in-process run.
 *
 * A spawned run needs none of this — its console writes to its own pipes,
 * which capture already reads — and a `worker` run is alone in its realm, so
 * it uses the lighter `realmConsole.ts` instead: no `AsyncLocalStorage`, no
 * `node:async_hooks` to load per run. Here the `console` is shared, so one patch
 * serves every run, and the question for each call is *whose* it is. That is
 * answered by `AsyncLocalStorage`: a run's code is started inside
 * {@link runWithConsoleSink}, the store follows it through every `await`,
 * timer and callback it schedules, and the patched method asks the store for
 * the current sink. Two concurrent in-process runs therefore each land in their
 * own log, and code outside any run — the host application, the runner's own
 * bookkeeping — has no sink and is never captured.
 *
 * The patch tees and never redirects, and capture cannot fail the call (see
 * `consolePatch.ts`). **It is removed when nobody needs it.** Installs are counted; the last
 *   {@link installConsoleCapture} release restores each original method — but
 *   only one that is still this patch. A method something else wrapped after
 *   us (a test spy, another library) is left alone, and our wrapper underneath
 *   it simply passes through, since no run is current.
 *
 * What escapes, deliberately: `process.stdout.write` and `Bun.write` to the
 * standard streams, native code writing to file descriptors 1 and 2, a program
 * the handler launches with its own stdio, the console methods not listed in
 * {@link CONSOLE_STREAMS}, and a reference to a console method taken before
 * the patch was installed.
 */

export {
  type CapturedConsoleMethod,
  CONSOLE_STREAMS,
  type ConsoleSink,
} from "./consolePatch";

/** Whose console output the current async context is. */
const storage = new AsyncLocalStorage<ConsoleSink>();

/** How many holders want the patch installed right now. */
let installs = 0;

/** Undoes the installed patch, while it is installed. */
let unpatch: (() => void) | undefined;

/** The sink of the current async context, if a run's. */
const currentSink = (): ConsoleSink | undefined => storage.getStore();

/**
 * Installs the console patch, if it is not installed already, and returns the
 * function that releases this hold on it. Releasing twice is a no-op.
 */
export function installConsoleCapture(): () => void {
  if (installs === 0) {
    unpatch = patchConsole(currentSink);
  }
  installs++;

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    installs--;
    if (installs > 0) {
      return;
    }

    unpatch?.();
    unpatch = undefined;
  };
}

/** Whether the console patch is installed right now. For tests. */
export function isConsoleCaptureInstalled(): boolean {
  return installs > 0;
}

/**
 * How many holds on the console patch are live right now — one per in-process
 * executor that has captured and not been closed, plus any direct
 * {@link installConsoleCapture}. For tests, which should assert on the change
 * their own code makes rather than on {@link isConsoleCaptureInstalled}: a
 * runner some other test left running holds the patch too.
 */
export function consoleCaptureHolds(): number {
  return installs;
}

/**
 * Runs `fn` with `sink` as the destination of every captured console call it
 * makes — synchronously or from anything it schedules. The patch must be
 * installed for the calls to reach it.
 */
export function runWithConsoleSink<T>(
  /** Where this run's console output goes. */
  sink: ConsoleSink,
  /** The run's code. */
  fn: () => T,
): T {
  return storage.run(sink, fn);
}
