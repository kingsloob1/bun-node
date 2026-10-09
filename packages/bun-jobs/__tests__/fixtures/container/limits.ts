import { readFileSync, statfsSync } from "node:fs";
import process from "node:process";

/** Reports the container's cgroup memory limits, the /tmp size, its uid and gid. */
export default async () => {
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
  };
  const tmp = statfsSync("/tmp");
  return {
    memoryMax: read("/sys/fs/cgroup/memory.max"),
    swapMax: read("/sys/fs/cgroup/memory.swap.max"),
    tmpBytes: tmp.blocks * tmp.bsize,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  };
};
