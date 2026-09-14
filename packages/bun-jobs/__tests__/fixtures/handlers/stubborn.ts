import process from "node:process";
import { defineHandler } from "../../../lib/index";

/**
 * The worst case a runner has to handle: a handler that catches `SIGTERM`
 * and blocks the event loop, so it can neither notice its abort signal nor
 * run its own exit timer. Only `SIGKILL` ends this.
 */
export default defineHandler<{ ms?: number }, string>((ctx) => {
  process.on("SIGTERM", () => {
    // Deliberately ignored.
  });

  const until = Date.now() + (ctx.args?.ms ?? 5000);
  while (Date.now() < until) {
    // Busy-wait: nothing else in this process gets a turn.
  }

  return "survived";
});
