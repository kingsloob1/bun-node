import { defineProcessor } from "../../../lib/index";

/**
 * Logs a burst of lines without waiting for any of them, then returns.
 *
 * A chatty processor is the case the attempt's barrier must not serialise:
 * every one of these lines has to be stored before the completion record, but
 * they are independent of one another and go to the driver at once.
 */
export default defineProcessor<{ lines?: number }, number>((job) => {
  const lines = job.data.lines ?? 50;

  for (let index = 0; index < lines; index++) {
    void job.log(`line ${index}`).catch(() => undefined);
  }

  return lines;
});
