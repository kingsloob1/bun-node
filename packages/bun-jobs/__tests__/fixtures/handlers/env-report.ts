import { readFileSync } from "node:fs";
import process from "node:process";
import { defineHandler } from "../../../lib/index";

/**
 * Reports the environment and identity the run's process actually has: every
 * variable, its uid, gid and groups, and its cgroup. What the child-process
 * hardening tests assert on — read from the child itself, never from the
 * options the parent was given.
 */
export default defineHandler(async () => {
  let cgroup: string | null = null;
  const limits: Record<string, string | null> = {};
  try {
    cgroup = readFileSync("/proc/self/cgroup", "utf8").trim();
    // cgroup v2: one line, `0::<path>`; its limit files sit in that directory.
    const dir = `/sys/fs/cgroup${cgroup.split("::")[1] ?? ""}`;
    for (const file of [
      "memory.max",
      "memory.swap.max",
      "pids.max",
      "cpu.max",
    ]) {
      try {
        limits[file] = readFileSync(`${dir}/${file}`, "utf8").trim();
      } catch {
        limits[file] = null;
      }
    }
  } catch {
    // Not Linux: no cgroup to report.
  }
  // On Linux a same-user child can read its parent's startup environment
  // here, whatever its own environment is: the limit the docs state.
  let parentEnviron: boolean | null = null;
  try {
    readFileSync(`/proc/${process.ppid}/environ`);
    parentEnviron = true;
  } catch (error) {
    parentEnviron =
      (error as { code?: string }).code === "ENOENT" ? null : false;
  }
  return {
    env: { ...process.env } as Record<string, string>,
    parentEnviron,
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    groups: process.getgroups?.() ?? null,
    cgroup,
    limits,
    pid: process.pid,
  };
});
