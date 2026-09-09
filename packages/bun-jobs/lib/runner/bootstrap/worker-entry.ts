import type { ChildToParent, ParentToChild } from "../protocol";
import { runChildProtocol } from "./child-runtime";

/**
 * Entry point for `executionMode: "worker"`.
 *
 * Same protocol as the spawned child, over `postMessage` instead of IPC. A
 * worker cannot exit itself with a code, so `exit` is deliberately absent:
 * the parent's `terminate()` is what ends it.
 */

declare const self: {
  postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

runChildProtocol({
  send: (message: ChildToParent) => {
    self.postMessage(message);
  },
  onMessage: (listener) => {
    const previous = self.onmessage;
    self.onmessage = (event: MessageEvent) => {
      previous?.(event);
      listener(event.data as ParentToChild);
    };
  },
});
