/**
 * `bun install` resolves a `file:` folder dependency's devDependencies, which
 * npm, Yarn and pnpm ignore, as they do for a registry package. So a `file:`
 * dependency on a workspace member whose devDependencies say `catalog:` (or
 * `workspace:`) cannot be installed from outside its workspace: those
 * protocols only mean something inside it (oven-sh/bun#22879).
 *
 *   bun docs/bun-bugs/file-dependency-resolves-dev-dependencies.ts
 *
 * Builds a two-package tree in a temporary directory and runs `bun install`
 * in the consumer, offline (nothing it needs is on a registry). Exits 1 while
 * the install fails on the devDependency, 0 once it succeeds.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

console.log(`Bun ${Bun.version} (${Bun.revision})`);

const root = mkdtempSync(join(tmpdir(), "bun-file-dev-deps-"));
try {
  const write = (path: string, json: unknown): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(json));
  };
  // A workspace with a catalog, and a member whose dev tooling uses it.
  write("mono/package.json", {
    name: "mono",
    private: true,
    workspaces: { packages: ["packages/*"], catalog: { zod: "^4.0.0" } },
  });
  write("mono/packages/lib/package.json", {
    name: "lib",
    version: "1.0.0",
    devDependencies: { zod: "catalog:" },
  });
  // A project outside the workspace that depends on the member's folder.
  write("app/package.json", {
    name: "app",
    version: "1.0.0",
    dependencies: { lib: "file:../mono/packages/lib" },
  });

  const run = Bun.spawnSync([process.execPath, "install"], {
    cwd: join(root, "app"),
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(root, "cache") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
  console.log(`bun install exited ${run.exitCode}:\n${output}`);
  console.log("npm install on the same tree: exits 0, lib's devDependencies ignored");
  process.exit(run.exitCode === 0 ? 0 : 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
