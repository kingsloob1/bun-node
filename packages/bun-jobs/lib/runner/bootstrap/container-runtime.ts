import type { ChildToParent, ParentToChild } from "../protocol";
import { runChildProtocol } from "./child-runtime";

/**
 * The thread a `container` target's processor runs on: the child protocol,
 * spoken to the container entry (`container-entry.ts`) by `postMessage`. The
 * entry, on the main thread, relays it to and from the container's stdio and
 * stays free to stop the process when this thread cannot.
 *
 * Internal; started only by the entry, as a `Worker`. Imported on a main
 * thread it does nothing.
 */

/** What this thread tells the entry: a protocol message to write, or an exit. */
export type RuntimeToEntry =
  | {
      /** A message for the worker, to write to stdout. */
      send: ChildToParent;
    }
  | {
      /** The process should exit with this code, once its writes are out. */
      exit: number;
    };

declare const self: {
  postMessage: (message: RuntimeToEntry) => void;
  onmessage: ((event: MessageEvent<ParentToChild>) => void) | null;
};

if (!Bun.isMainThread) {
  const listeners: ((message: ParentToChild) => void)[] = [];
  self.onmessage = (event) => {
    for (const listener of [...listeners]) {
      listener(event.data);
    }
  };
  runChildProtocol({
    send: (message) => {
      self.postMessage({ send: message });
    },
    onMessage: (listener) => {
      listeners.push(listener);
    },
    exit: (code) => {
      self.postMessage({ exit: code });
    },
  });
}
