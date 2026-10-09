import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Notes that it started (in `$MARKER_DIR/started`), then never returns and
 * ignores its signal: only a kill stops it.
 */
export default async () => {
  if (process.env.MARKER_DIR) {
    writeFileSync(`${process.env.MARKER_DIR}/started`, "1");
  }
  await new Promise(() => {});
};
