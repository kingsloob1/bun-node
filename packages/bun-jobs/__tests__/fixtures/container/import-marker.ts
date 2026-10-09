import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Writes `$MARKER_DIR/imported` the moment it is imported: a test that stops
 * an attempt before its start asserts the file never appears.
 */
if (process.env.MARKER_DIR) {
  writeFileSync(`${process.env.MARKER_DIR}/imported`, "1");
}

export default async () => "ran";
