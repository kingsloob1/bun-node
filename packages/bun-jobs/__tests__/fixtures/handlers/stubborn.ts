import { writeFileSync } from "node:fs";
import process from "node:process";
import { defineHandler } from "../../../lib/index";

/**
 * The worst case a runner has to handle: a handler that catches `SIGTERM`
 * and blocks the event loop, so it can neither notice its abort signal nor
 * run its own exit timer. Only `SIGKILL` ends this.
 *
 * `ready`, when given, is a file written once the `SIGTERM` handler is
 * installed — synchronously, because the loop is about to block and an IPC
 * message sent now might never leave. A test waits for it before stopping
 * the run, instead of guessing how long start-up takes.
 */
export default defineHandler<{ ms?: number; ready?: string }, string>((ctx) => {
  process.on("SIGTERM", () => {
    // Deliberately ignored.
  });

  if (ctx.args?.ready) {
    writeFileSync(ctx.args.ready, String(process.pid));
  }

  const until = Date.now() + (ctx.args?.ms ?? 5000);
  while (Date.now() < until) {
    // Busy-wait: nothing else in this process gets a turn.
  }

  return "survived";
});
