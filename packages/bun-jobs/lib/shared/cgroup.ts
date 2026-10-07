import type { Dirent } from "node:fs";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ConfigError } from "./errors";

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
 * processes are being reaped.
 *
 * It answers `true` once `path` is gone (removed now, or already gone) and
 * `false` when something kept it, a busy cgroup, a permission or an
 * unreadable directory, so a caller can retry within a budget of its own.
 *
 * **It refuses what is not a cgroup**, since it deletes directories: a
 * `path` that is not absolute, or a directory with no `cgroup.procs` file
 * (every cgroup has one), throws a `ConfigError` before anything is
 * removed. That is the only throw.
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
 *
 * @throws {ConfigError} for a relative `path`, or one that exists and is not
 *   a cgroup directory.
 */
export function removeCgroupTree(
  /** The cgroup's directory, absolute, e.g. `/sys/fs/cgroup/…/my-unit`. */
  path: string,
): boolean {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new ConfigError(
      "removeCgroupTree needs an absolute path to a cgroup directory",
      { path },
    );
  }
  if (!existsSync(join(path, "cgroup.procs"))) {
    // Gone (now, or between two reads) is what was asked for.
    if (!existsSync(path)) {
      return true;
    }
    throw new ConfigError(
      "removeCgroupTree refuses a directory that is not a cgroup (it has no cgroup.procs)",
      { path },
    );
  }
  return removeTree(path);
}

/** The removal itself, below a path already known to be a cgroup: deepest first. */
function removeTree(path: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
  for (const entry of entries) {
    // A cgroup's own files are never directories; its children always are.
    if (entry.isDirectory()) {
      removeTree(join(path, entry.name));
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
