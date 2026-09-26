#!/usr/bin/env bun
import type { ChildToParent, ParentToChild } from "../protocol";
import process from "node:process";
import { runChildProtocol } from "./child-runtime";

/**
 * Entry point for `executionMode: "child-process"`.
 *
 * The child is this file, not the handler: it owns the protocol, so a
 * handler file stays an ordinary module that default-exports a function and
 * can be imported and tested directly.
 */

runChildProtocol({
  send: (message: ChildToParent) => {
    process.send?.(message);
  },
  onMessage: (listener) => {
    process.on("message", (message) => listener(message as ParentToChild));
  },
  disconnect: () => {
    process.disconnect?.();
  },
  exit: (code: number) => {
    process.exit(code);
  },
});
