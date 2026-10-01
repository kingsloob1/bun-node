import { mkdirSync, readFileSync } from "node:fs";
import { defineHandler } from "../../../lib/index";

/**
 * Creates a cgroup inside its own, as a job running as the worker's user may:
 * its cgroup is in a tree delegated to that user. A cgroup with a child
 * directory cannot be removed until the child is, so this is what cleanup has
 * to cope with. Returns the path it made.
 */
export default defineHandler(async () => {
  const own = readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1];
  const sub = `/sys/fs/cgroup${own}/sub/deeper`;
  mkdirSync(sub, { recursive: true });
  return { sub };
});
