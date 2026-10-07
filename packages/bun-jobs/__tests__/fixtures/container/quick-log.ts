import type { ProcessorContext } from "../../../lib/queue/types";

/** Logs one line through the channel and returns at once. */
export default async (_job: unknown, ctx: ProcessorContext) => {
  ctx.logger.info("returning");
  return "done";
};
