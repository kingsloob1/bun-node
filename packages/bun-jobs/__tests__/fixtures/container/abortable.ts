import type { ProcessorContext } from "../../../lib/queue/types";
import type { IsolatedJob } from "../../../lib/runner/executors/executor";
import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Notes that it started (`$MARKER_DIR/started`), waits for its signal,
 * notes that it saw it (`$MARKER_DIR/aborted`) and returns `"unwound"`.
 */
export default async (_job: IsolatedJob, ctx: ProcessorContext) => {
  const dir = process.env.MARKER_DIR;
  if (dir) {
    writeFileSync(`${dir}/started`, "1");
  }
  while (!ctx.signal.aborted) {
    await Bun.sleep(5);
  }
  if (dir) {
    writeFileSync(`${dir}/aborted`, "1");
  }
  return "unwound";
};
