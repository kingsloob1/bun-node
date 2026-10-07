import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { ConfigError } from "../lib/index";
import { removeCgroupTree } from "../lib/provider/index";
import { removeCgroupTree as shared } from "../lib/shared/cgroup";
import { makeTmpDir } from "./helpers";

/**
 * `removeCgroupTree`'s contract. It is public (`./provider`), so it refuses
 * anything that is not a cgroup: a relative path, or a directory with no
 * `cgroup.procs`, is a `ConfigError` and nothing is removed. On a real
 * cgroup (in a subtree delegated to this user, when the machine has one) it
 * removes deepest first, never kills, and answers whether the path is gone.
 */

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

async function tmp(): Promise<string> {
  const dir = await makeTmpDir("bun-jobs-cgroup-tree");
  cleanups.push(dir.cleanup);
  return dir.path;
}

/** Where this user may make cgroups (a delegated subtree), or `undefined`. */
function delegatedBase(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const uid = process.getuid?.();
  const base = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
  const probe = join(base, `bun-jobs-tree-probe-${process.pid}`);
  try {
    mkdirSync(probe);
    removeCgroupTree(probe);
    return existsSync(probe) ? undefined : base;
  } catch {
    return undefined;
  }
}

describe("removeCgroupTree refuses what is not a cgroup", () => {
  it("is the ./provider entry's, the one the child-process target uses", () => {
    expect(removeCgroupTree).toBe(shared);
  });

  it("leaves an ordinary directory and its empty directories alone", async () => {
    const root = join(await tmp(), "ordinary");
    mkdirSync(join(root, "inner", "deeper"), { recursive: true });
    mkdirSync(join(root, "sibling"));
    expect(() => removeCgroupTree(root)).toThrow(ConfigError);
    expect(existsSync(join(root, "inner", "deeper"))).toBe(true);
    expect(existsSync(join(root, "sibling"))).toBe(true);
  });

  it("refuses a relative path, `.` and the empty string", async () => {
    const dir = await tmp();
    mkdirSync(join(dir, "empty-here"));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      for (const path of [".", "", "empty-here", "./empty-here"]) {
        expect(() => removeCgroupTree(path)).toThrow(ConfigError);
      }
    } finally {
      process.chdir(cwd);
    }
    expect(existsSync(join(dir, "empty-here"))).toBe(true);
  });

  it("answers true for an absolute path already gone", async () => {
    expect(removeCgroupTree(join(await tmp(), "never-made"))).toBe(true);
  });
});

const base = delegatedBase();

describe("removeCgroupTree on a real cgroup", () => {
  it.skipIf(base === undefined)(
    "removes a cgroup and the cgroups inside it, deepest first",
    () => {
      const root = join(base!, `bun-jobs-tree-${process.pid}-a`);
      mkdirSync(join(root, "inner", "deeper"), { recursive: true });
      mkdirSync(join(root, "sibling"));
      expect(removeCgroupTree(root)).toBe(true);
      expect(existsSync(root)).toBe(false);
    },
  );

  it.skipIf(base === undefined)(
    "answers false while a process holds one, kills nothing, and removes it once that is gone",
    async () => {
      const root = join(base!, `bun-jobs-tree-${process.pid}-b`);
      mkdirSync(join(root, "busy"), { recursive: true });
      mkdirSync(join(root, "empty"));
      const proc = Bun.spawn({
        cmd: ["sleep", "987"],
        env: { PATH: process.env.PATH ?? "" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        cgroup: join(root, "busy"),
      });
      try {
        expect(removeCgroupTree(root)).toBe(false);
        expect(existsSync(join(root, "empty"))).toBe(false);
        expect(existsSync(join(root, "busy"))).toBe(true);
        // It killed nothing: that is cgroup.kill's job.
        expect(proc.exitCode).toBeNull();
        writeFileSync(join(root, "busy", "cgroup.kill"), "1");
        await proc.exited;
        const by = Date.now() + 5_000;
        while (!removeCgroupTree(root) && Date.now() < by) {
          await Bun.sleep(10);
        }
        expect(existsSync(root)).toBe(false);
      } finally {
        proc.kill("SIGKILL");
        try {
          removeCgroupTree(root);
        } catch {
          // Gone already.
        }
      }
    },
  );
});
