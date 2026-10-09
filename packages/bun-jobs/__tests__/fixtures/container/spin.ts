import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Notes that it started (in `$MARKER_DIR/started`), then blocks its thread
 * for good: no timer runs again, so the runner inside cannot even exit
 * itself. Only a kill from outside ends it.
 */
export default async () => {
  if (process.env.MARKER_DIR) {
    writeFileSync(`${process.env.MARKER_DIR}/started`, "1");
  }

  while (true) {
    // Blocks the event loop on purpose.
  }
};
