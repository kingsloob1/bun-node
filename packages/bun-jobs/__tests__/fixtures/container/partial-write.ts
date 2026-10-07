import process from "node:process";

/**
 * Writes to stdout without a trailing newline, then returns `"ok"`: the
 * runner's result must still be read, and "working..." kept as output.
 */
export default async () => {
  process.stdout.write("working...");
  return "ok";
};
