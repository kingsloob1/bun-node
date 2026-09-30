#!/usr/bin/env bun
/**
 * Builds what the package ships (run on `prepack`): `dist/index.js`, one
 * bundle of `src/` with bun-jobs left external (it is a peer), and
 * `dist/*.d.ts` from `tsc`.
 *
 * ```bash
 * bun scripts/build.ts
 * ```
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });

const bundle = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir: dist,
  target: "bun",
  format: "esm",
  packages: "external",
});
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log);
  process.exit(1);
}

const declarations = Bun.spawnSync({
  cmd: ["bun", "x", "tsc", "-p", "tsconfig.build.json"],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (declarations.exitCode !== 0) {
  console.error("tsc failed: dist/ has the bundle but not every declaration");
  process.exit(1);
}
console.log(
  `built ${bundle.outputs.length} bundle file(s) and the declarations in dist/`,
);
