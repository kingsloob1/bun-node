import type { RunContext } from "../../../lib/index";
import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";

/**
 * A handler whose module takes exactly as long to import as a test wants.
 *
 * Evaluating it writes the file named by `RUNNER_TEST_IMPORTING` (so a test
 * knows the import has begun), then holds until one of:
 *
 * - `RUNNER_TEST_UNTIL_CLOSE` is set and the runner's `close` has reached
 *   this child — seen by a listener of its own on the same channel, so the
 *   child runtime has seen it too by the time the import goes on. Nothing
 *   else can release it, so a stop is certain to land mid-import. (A gate
 *   file opened after `kill()` was not enough in a worker: under load the
 *   file was visible before the `close` message was delivered, and the
 *   import finished first.)
 * - the file named by `RUNNER_TEST_GATE` exists. For an in-process run, where
 *   `kill()` aborts the signal synchronously, before the test opens it, and
 *   for a test that plays the parent itself.
 *
 * With none of them set it imports at once.
 *
 * Nothing from `lib/` is imported at run time: a static import is evaluated
 * before this module's body, and the barrel is the slow part being avoided.
 * The handler, once called, writes `args.ready` and then unwinds when asked,
 * like `graceful.ts`, so "was it called?" is a file on disk.
 */

const importing = process.env.RUNNER_TEST_IMPORTING;
const gate = process.env.RUNNER_TEST_GATE;
const untilClose = process.env.RUNNER_TEST_UNTIL_CLOSE === "1";

let closed = false;
if (untilClose) {
  const see = (message: unknown) => {
    if ((message as { t?: unknown } | null)?.t === "close") {
      closed = true;
    }
  };
  if (process.env.BUN_JOBS_MODE === "worker-thread") {
    // The worker's own scope: the entry point listens with `onmessage`, and
    // every listener sees each message in the same dispatch.
    (globalThis as unknown as EventTarget).addEventListener(
      "message",
      (event) => see((event as MessageEvent).data),
    );
  } else {
    process.on("message", see);
  }
}

if (importing) {
  writeFileSync(importing, String(process.pid));
}

/** Whether the import may go on: the close was seen, or the gate is open. */
const released = () => closed || (gate !== undefined && existsSync(gate));

if (gate || untilClose) {
  // `closed` is set by the listener above, between the sleeps.
  while (!released()) {
    await Bun.sleep(5);
  }
}

export default async (
  ctx: RunContext<{ ms?: number; ready?: string }>,
): Promise<string> => {
  if (ctx.args?.ready) {
    writeFileSync(ctx.args.ready, "1");
  }

  const until = Date.now() + (ctx.args?.ms ?? 5000);
  while (Date.now() < until) {
    if (ctx.signal.aborted) {
      return "unwound";
    }
    await Bun.sleep(5);
  }

  return "finished";
};
