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
 *   delegates to the user, `…/user@<uid>.service/app.slice/bun-node-playground-<pid>`
 *   (`PLAYGROUND_CGROUP_SLICE` names another parent), with `memory.max`
 *   1 GiB and `pids.max` 512 binding every unit together, and removes it
 *   when the playground stops. Where it cannot be made (no systemd user
 *   slice — a container, WSL, no cgroup v2 — or no permission), the
 *   playground says so once and runs its units without a cgroup.
 * - Before making it, `auto` kills and removes what an earlier run left:
 *   every `bun-node-playground-<pid>` whose pid is gone (a playground killed
 *   with SIGKILL, whose units may still be running in it), and one carrying
 *   this process's own pid (a `bun --watch` reload re-executes in place, with
 *   the same pid).
 * - `PLAYGROUND_CGROUP=/sys/fs/cgroup/…` uses that existing directory as it
 *   is, and never removes it; one that is not a cgroup v2 directory is
 *   `localCompute()`'s `ConfigError` at startup.
 *
 * bun-jobs never creates or configures the directory itself; this is the
 * playground doing what a deployment would. With one, each unit runs in a
 * cgroup of its own inside it, removed when the unit exits, and stopping a
 * unit kills its whole cgroup.
 */
export interface PlaygroundCgroup {
  /** The directory to pass as `cgroup`, or `undefined` for none. */
  path: string | undefined;
  /** Removes the directory if this run made it, once its units' cgroups are gone. */
  release: () => Promise<void>;
}

/** The prefix of the directories `auto` makes. */
const PREFIX = "bun-node-playground-";

/** No cgroup: nothing to release. */
const NONE: PlaygroundCgroup = { path: undefined, release: async () => {} };

/** The parent `auto` makes its directory in: `PLAYGROUND_CGROUP_SLICE`, else the user's delegated `app.slice`. */
function appSlice(): string {
  const override = process.env.PLAYGROUND_CGROUP_SLICE;
  if (override !== undefined && override !== "") {
    return override;
  }
  const uid = process.getuid?.() ?? 0;
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
}

/** An errno code of a thrown error, or `"error"`. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "error";
}

/**
 * `cgroup.kill` (Linux 5.14+): `SIGKILL` to every process in the cgroup and
 * below. `removeCgroupTree` never kills, so a cgroup with live processes in
 * it would only answer `EBUSY`.
 */
function killCgroup(path: string): void {
  try {
    if (existsSync(join(path, "cgroup.kill"))) {
      writeFileSync(join(path, "cgroup.kill"), "1");
    }
  } catch {
    // Already gone, or an older kernel: the removal below says whether it went.
  }
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

/**
 * Kills everything in an earlier run's cgroup and removes it. Says so when it
 * will not go, rather than leaving it silently.
 */
async function sweep(path: string): Promise<void> {
  killCgroup(path);
  if (!(await removeTree(path))) {
    console.warn(
      `playground: could not remove ${path}, left by an earlier run; remove it by hand`,
    );
  }
}

/** The cgroup for this run, per `PLAYGROUND_CGROUP`. */
export async function playgroundCgroup(): Promise<PlaygroundCgroup> {
  const asked = process.env.PLAYGROUND_CGROUP;
  if (asked === undefined || asked === "" || asked === "off") {
    return NONE;
  }
  if (asked !== "auto") {
    return { path: asked, release: async () => {} };
  }
  const slice = appSlice();
  // What an earlier run left: a playground killed outright (its pid gone),
  // or this very process before a `--watch` reload (the same pid).
  for (const name of readdirSafe(slice)) {
    if (!name.startsWith(PREFIX)) {
      continue;
    }
    const pid = Number(name.slice(PREFIX.length));
    if (pid > 0 && (pid === process.pid || !isAlive(pid))) {
      await sweep(join(slice, name));
    }
  }
  const path = join(slice, `${PREFIX}${process.pid}`);
  try {
    mkdirSync(path);
  } catch (error) {
    console.warn(
      `playground: PLAYGROUND_CGROUP=auto, but ${path} could not be made (${codeOf(error)}): running the units without a cgroup. It needs Linux with cgroup v2 and a subtree this user may write (PLAYGROUND_CGROUP_SLICE names another parent).`,
    );
    return NONE;
  }
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
      // Every unit has exited by now; kill anything a unit left behind in
      // its cgroup all the same, so the removal cannot be refused.
      killCgroup(path);
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
