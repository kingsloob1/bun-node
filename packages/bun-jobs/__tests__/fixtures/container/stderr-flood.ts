import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * Writes `job.data.lines` stderr lines of `job.data.mib` MiB each, notes that
 * it has (`$MARKER_DIR/flooded`), then waits until killed: the container is
 * still running, so whatever the worker kept of those lines is still held.
 */
export default async (job: { data: unknown }) => {
  const { lines, mib } = job.data as { lines: number; mib: number };
  const line = `${"e".repeat(mib * 1024 * 1024)}\n`;
  for (let i = 0; i < lines; i++) {
    await Bun.write(Bun.stderr, line);
  }
  if (process.env.MARKER_DIR) {
    writeFileSync(`${process.env.MARKER_DIR}/flooded`, "1");
  }
  await new Promise(() => {});
};
