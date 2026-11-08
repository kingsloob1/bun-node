/**
 * The typed client's route map (`app/jobs/api/routes.gen.ts`) matches the API it
 * was generated from: `bun-client generate --check` over the document
 * `scripts/jobs/routes-openapi.ts` builds from bun-jobs as it is now, the same
 * command as `bun run check:client`. A bun-jobs change to a route, a schema
 * or an error code makes the committed map stale, and this fails until
 * `bun run gen:client` is run and its output committed.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "@kingsleyweb/bun-client/codegen";
import { describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "../../..");
const MAP = join(ROOT, "app/jobs/api/routes.gen.ts");

/** Runs `bun-client generate --check` for `out`, returning its exit code and what it wrote. */
async function check(out: string): Promise<{ code: number; output: string }> {
  let output = "";
  const code = await runCli(
    [
      "generate",
      "--module",
      "scripts/jobs/routes-openapi.ts",
      "--out",
      out,
      "--check",
    ],
    {
      cwd: ROOT,
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        output += text;
      },
    },
  );
  return { code, output };
}

describe("the typed client's route map", () => {
  it("is what bun-jobs' document generates today", async () => {
    const { code, output } = await check(MAP);
    expect(output).toContain("is up to date");
    expect(code).toBe(0);
  });

  it("is refused when stale (the negative control)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-ui-routes-gen-"));
    try {
      // The committed map with one route's type changed, as a map generated
      // before a bun-jobs change would be.
      const stale = (await readFile(MAP, "utf8")).replace(
        '"none" | "skipped" | "summoned" | "released"',
        '"none" | "skipped" | "summoned"',
      );
      const out = join(dir, "routes.gen.ts");
      await writeFile(out, stale);
      const { code, output } = await check(out);
      expect(output).toContain("is stale");
      expect(code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
