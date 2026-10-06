import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { removeCgroupTree } from "../lib/provider/index";
import { removeCgroupTree as shared } from "../lib/shared/cgroup";
import { makeTmpDir } from "./helpers";

/**
 * `removeCgroupTree`'s contract, on plain directories (a cgroup's children
 * are directories and its own entries files, and `rmdir` treats both alike):
 * deepest first, never throws, `true` only once the path is gone. The
 * cgroup cases, a unit's cgroup with one made inside it, are in
 * `provider/local-compute.test.ts` and `spawn-hardening.test.ts`.
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

describe("removeCgroupTree", () => {
  it("is the ./provider entry's, the one the child-process target uses", () => {
    expect(removeCgroupTree).toBe(shared);
  });

  it("removes a tree of empty directories, deepest first", async () => {
    const root = join(await tmp(), "unit");
    mkdirSync(join(root, "inner", "deeper"), { recursive: true });
    mkdirSync(join(root, "sibling"));
    expect(removeCgroupTree(root)).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it("answers true for a path already gone", async () => {
    expect(removeCgroupTree(join(await tmp(), "never-made"))).toBe(true);
  });

  it("answers false without throwing when something keeps it, removing what it can", async () => {
    const root = join(await tmp(), "unit");
    mkdirSync(join(root, "busy"), { recursive: true });
    mkdirSync(join(root, "empty"));
    // A file stands in for a cgroup that still holds a process.
    writeFileSync(join(root, "busy", "held"), "1");
    expect(removeCgroupTree(root)).toBe(false);
    expect(existsSync(join(root, "empty"))).toBe(false);
    expect(existsSync(join(root, "busy"))).toBe(true);
  });
});
