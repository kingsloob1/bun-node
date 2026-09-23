import { defineProcessor } from "../../../lib/index";

/**
 * Logs without waiting for the line to be stored, then returns at once.
 *
 * `job.log()` puts its request on the channel synchronously, so the worker has
 * the line before it has the result — but the write it starts is still in
 * flight when the attempt ends. This is the ordinary completion path's half of
 * the same race the deadline showed.
 */
export default defineProcessor<unknown, string>((job) => {
  // Deliberately not awaited: nothing here waits for the line to be stored.
  void job.log("in flight").catch(() => undefined);
  return "done";
});
