/**
 * A job processor file that fails unrecoverably. Run by `10-options/errors.ts`
 * with `isolation: "spawn"`, so the error crosses a process boundary and the
 * worker has to recognise it by name. Not meant to be run alone.
 */
import { defineProcessor, UnrecoverableJobError } from "@kingsleyweb/bun-jobs";

/** What a charge job carries. */
interface Charge {
  /** The order being charged. */
  orderId: string;
}

export default defineProcessor<Charge, never>((job) => {
  throw new UnrecoverableJobError("card expired", {
    orderId: job.data.orderId,
  });
});
