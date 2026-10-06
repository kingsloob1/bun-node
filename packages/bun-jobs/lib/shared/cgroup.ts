import type { Dirent } from "node:fs";
import { readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Cgroup removal shared by everything in the package that gives a child
 * process a cgroup of its own: the `child-process` target's hardening
 * (`lib/runner/executors/spawnHardening.ts`) and `localCompute`, which
 * reaches it through the `./provider` entry, as a third-party provider can.
 */

/**
 * Removes a cgroup v2 directory and every cgroup below it, **deepest
 * first**: a cgroup with a child cannot be removed, and a process inside a
 * cgroup can make cgroups of its own there (a job running as this user, in a
 * cgroup this user created), which a single `rmdir` would leave in the way.
 *
 * It **never kills, only removes**. A cgroup that still holds a process is
 * busy (`EBUSY`) and stays, along with everything above it; so kill what is
 * inside first, with `cgroup.kill` (write `"1"` to it, Linux 5.14+, which
 * reaches every cgroup below too), and call this again while the killed
 * processes are being reaped. A cgroup that is already gone counts as
 * removed.
 *
 * Never throws: it answers `true` once `path` is gone (removed now or never
 * there), and `false` when anything kept it, a busy cgroup, a permission or
 * an unreadable directory, so a caller can retry within a budget of its own.
 *
 * ```ts
 * import { writeFileSync } from "node:fs";
 * import { removeCgroupTree } from "@kingsleyweb/bun-jobs/provider";
 *
 * writeFileSync(`${unitCgroup}/cgroup.kill`, "1");
 * while (!removeCgroupTree(unitCgroup) && Date.now() < deadline) {
 *   await Bun.sleep(10);
 * }
 * ```
 */
export function removeCgroupTree(
  /** The cgroup's directory, e.g. `/sys/fs/cgroup/…/my-unit`. */
  path: string,
): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
  for (const entry of entries) {
    // A cgroup's own files are never directories; its children always are.
    if (entry.isDirectory()) {
      removeCgroupTree(join(path, entry.name));
    }
  }
  return rmdirQuietly(path);
}

/** Internal: removes an empty cgroup directory; `true` when it is gone. Never throws. */
export function rmdirQuietly(
  /** The directory. */
  path: string,
): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
}
