import { defineProcessor } from "../../../lib/index";

/** Every worker that ran this processor in this process, by id, in order. */
const store = globalThis as { __jobRanBy?: string[] };

/**
 * Notes which worker ran it and returns `"ran"`. Loaded in-process (the
 * `"in-process"` target imports it), so a test reads `globalThis.__jobRanBy`
 * to see whether — and where — a job actually ran.
 */
export default defineProcessor(async (_job, context) => {
  (store.__jobRanBy ??= []).push(context.workerId);
  return "ran";
});
