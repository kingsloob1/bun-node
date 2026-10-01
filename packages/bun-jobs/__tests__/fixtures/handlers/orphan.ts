import process from "node:process";
import { defineHandler } from "../../../lib/index";

/**
 * Starts a `sleep` it never waits for, and returns its pid: the process a job
 * leaves behind when it exits. Its own child exits with it; the `sleep` does
 * not, unless something kills it.
 */
export default defineHandler(async () => {
  const proc = Bun.spawn(["sleep", "30"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
  return { orphan: proc.pid };
});
