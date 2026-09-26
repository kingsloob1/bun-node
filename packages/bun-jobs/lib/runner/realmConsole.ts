import type { ConsoleSink } from "./consolePatch";
import { patchConsole } from "./consolePatch";

/**
 * Console capture for a `worker-thread` run, which has its realm to itself.
 *
 * `consoleCapture.ts` attributes each call by `AsyncLocalStorage` because an
 * in-process run shares its console with the host and with other runs. A
 * worker realm runs exactly one run and is then terminated, so every call made
 * in it while the run is live is that run's: a module variable says the same
 * thing, without loading `node:async_hooks` (and, through `consolePatch.ts`'s
 * lazy formatter, usually without `node:util`) into every worker. Measured on
 * Bun 1.4.3, those two modules cost ~4 ms to load in a fresh realm.
 *
 * Imported dynamically by `bootstrap/child-runtime.ts`, only when capture is
 * on, so a spawned child (whose console is in its pipes) never loads it.
 */

/** The live run's sink, while one is being captured. */
let current: ConsoleSink | undefined;

/** The current sink, as the patch asks for it. */
const currentSink = (): ConsoleSink | undefined => current;

/**
 * Sends every captured console call in this realm to `sink` until the returned
 * function is called, which restores the console and drops the sink. Only one
 * capture at a time: a second call replaces the first's sink.
 */
export function captureRealmConsole(
  /** Where the run's console output goes. */
  sink: ConsoleSink,
): () => void {
  current = sink;
  const unpatch = patchConsole(currentSink);
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    if (current === sink) {
      current = undefined;
    }
    unpatch();
  };
}
