import { isServer } from "@tanstack/react-query";

/**
 * Preloaded by `queryIsolation.test.ts` ahead of any DOM, this is what a
 * DOM-less test file does when it happens to run first in a whole-package
 * run: TanStack Query evaluates with no `window`, and records for good that
 * it runs on a server.
 */
if (!isServer) {
  throw new Error(
    "loadQueryFirst must load TanStack Query before any DOM exists",
  );
}
