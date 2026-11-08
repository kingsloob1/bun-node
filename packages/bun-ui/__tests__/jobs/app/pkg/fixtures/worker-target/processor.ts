import { defineProcessor } from "@kingsleyweb/bun-jobs";

/**
 * The processor file `worker-target.integration.test.ts` builds a
 * `target: "child-process"` worker from. The test reads only what the worker
 * reports about where its attempts run, so this never needs to do anything.
 */
export default defineProcessor(async () => "ok");
