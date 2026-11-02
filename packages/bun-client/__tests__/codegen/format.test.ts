/**
 * The generated module is formatted (typed-client plan R10): `bun fmt`
 * (Prettier's layout, the repo's formatter) leaves it unchanged. Checked on
 * the golden files and on a sweep of layouts built to sit either side of
 * the 80-column line, where Prettier's choices change: unions in a
 * property, an alias, an array, a type argument and a tuple; intersections;
 * long names and keys; the manifest's objects.
 *
 * `bun fmt` is the repo's formatter on its development floor (Bun 1.4.4);
 * on a Bun without it both tests skip, visibly.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { generateRoutes } from "../../lib/codegen/index";
import { sweepDocument } from "./fixtures/sweep";

const FIXTURES = join(import.meta.dir, "fixtures");
const dir = await mkdtemp(join(tmpdir(), "bun-client-format-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Whether this Bun has `bun fmt`. */
const hasFmt =
  Bun.spawnSync([process.execPath, "fmt", "--help"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

/** Runs `bun fmt --check` on `files` in `cwd`: its exit status and output. */
function fmtCheck(
  cwd: string,
  files: readonly string[],
): { code: number; output: string } {
  const run = Bun.spawnSync([process.execPath, "fmt", "--check", ...files], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    output: `${run.stdout.toString()}${run.stderr.toString()}`,
  };
}

describe("the generated module is formatted", () => {
  it.skipIf(!hasFmt)("bun fmt leaves the golden files unchanged", () => {
    const result = fmtCheck(FIXTURES, [
      "app.gen.ts",
      "corpus.gen.ts",
      "thirdParty.gen.ts",
    ]);
    expect(result).toEqual({ code: 0, output: expect.any(String) as string });
  });

  it.skipIf(!hasFmt)(
    "bun fmt leaves a sweep of layouts across the 80-column line unchanged",
    async () => {
      const { code } = generateRoutes(sweepDocument());
      const file = join(dir, "sweep.gen.ts");
      await writeFile(file, code);
      const result = fmtCheck(dir, ["sweep.gen.ts"]);
      if (result.code !== 0) {
        // Show what the formatter would change.
        const copy = join(dir, "sweep.formatted.ts");
        await writeFile(copy, code);
        Bun.spawnSync([process.execPath, "fmt", copy], { cwd: dir });
        const diff = Bun.spawnSync(["diff", file, copy], { stdout: "pipe" });
        throw new Error(
          `bun fmt would reformat the sweep:\n${diff.stdout.toString().slice(0, 4000)}`,
        );
      }
      expect(result.code).toBe(0);
    },
  );
});
