import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { removeCgroupTree } from "@kingsleyweb/bun-jobs/provider";
import { isAlive } from "../backend";

/**
 * The cgroup the media `localCompute()` instance starts its units under, when
 * `PLAYGROUND_CGROUP` asks for one. Off by default: `localCompute()`'s
 * `cgroup` is optional, and needs Linux with cgroup v2 and a subtree the user
 * may write.
 *
 * - `PLAYGROUND_CGROUP=auto` makes one for this run in the subtree systemd
 *   delegates to the user, `…/user@<uid>.service/app.slice/bun-node-playground-<pid>`,
 *   with `memory.max` 1 GiB and `pids.max` 512 binding every unit together,
 *   and removes it when the playground stops (and, at the next start, any a
 *   killed playground left behind). bun-jobs never creates or configures the
 *   directory itself; this is the playground doing what a deployment would.
 * - `PLAYGROUND_CGROUP=/sys/fs/cgroup/…` uses that existing directory as it
 *   is, and never removes it.
 *
 * With one, each unit runs in a cgroup of its own inside it, removed when the
 * unit exits, and stopping a unit kills its whole cgroup.
 */
export interface PlaygroundCgroup {
  /** The directory to pass as `cgroup`, or `undefined` for none. */
  path: string | undefined;
  /** Removes the directory if this run made it, once its units' cgroups are gone. */
  release: () => Promise<void>;
}

/** The prefix of the directories `auto` makes. */
const PREFIX = "bun-node-playground-";

/** The user's delegated `app.slice`, where `auto` makes its directory. */
function appSlice(): string {
  const uid = process.getuid?.() ?? 0;
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
}

/** Removes a cgroup tree, retrying while its processes are reaped, for at most `budgetMs`. */
async function removeTree(path: string, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      if (!existsSync(path) || removeCgroupTree(path)) {
        return true;
      }
    } catch {
      return false;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await Bun.sleep(50);
  }
}

/** The cgroup for this run, per `PLAYGROUND_CGROUP`. */
export async function playgroundCgroup(): Promise<PlaygroundCgroup> {
  const asked = process.env.PLAYGROUND_CGROUP;
  if (asked === undefined || asked === "" || asked === "off") {
    return { path: undefined, release: async () => {} };
  }
  if (asked !== "auto") {
    return { path: asked, release: async () => {} };
  }
  const slice = appSlice();
  // What a killed playground left behind: its pid is gone.
  for (const name of readdirSafe(slice)) {
    const pid = Number(name.slice(PREFIX.length));
    if (name.startsWith(PREFIX) && pid > 0 && !isAlive(pid)) {
      await removeTree(join(slice, name), 1_000);
    }
  }
  const path = join(slice, `${PREFIX}${process.pid}`);
  mkdirSync(path);
  // Limits on the directory bind every unit together. Best effort: a
  // controller not delegated here leaves its file absent.
  for (const [file, value] of [
    ["memory.max", String(1024 * 1024 * 1024)],
    ["pids.max", "512"],
  ] as const) {
    try {
      writeFileSync(join(path, file), value);
    } catch {
      // Not delegated: the cgroup still holds and kills the units.
    }
  }
  return {
    path,
    release: async () => {
      if (!(await removeTree(path))) {
        console.error(`playground: could not remove the cgroup ${path}`);
      }
    },
  };
}

/** A directory's entries, or none when it cannot be read. */
function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
