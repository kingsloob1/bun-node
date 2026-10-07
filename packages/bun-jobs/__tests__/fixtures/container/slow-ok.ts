import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Notes that it started (`$MARKER_DIR/started`), then takes 400 ms whatever
 * its signal says, and returns `"done"`: a processor that finishes despite a
 * stop.
 */
export default async () => {
  if (process.env.MARKER_DIR) {
    writeFileSync(`${process.env.MARKER_DIR}/started`, "1");
  }
  await Bun.sleep(400);
  return "done";
};
