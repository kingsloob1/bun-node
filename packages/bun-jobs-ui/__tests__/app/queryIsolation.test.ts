import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

/** The package root, where `bun test` resolves its paths from. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `bun test` shares modules across files, and TanStack Query decides once, at
 * load, whether it runs on a server — where it schedules no polling timers.
 * A DOM-less file that loads it first used to break every later polling test,
 * but only in whole-package runs and only in some orders. File order cannot
 * be forced inside this run, so this runs a fresh process that loads TanStack
 * Query before any DOM exists (the poisoned state) and then a polling test.
 */
describe("test isolation: TanStack Query loaded before the DOM", () => {
  it("does not stop a later file's polling", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--preload",
        "./__tests__/app/isolation/loadQueryFirst.ts",
        "./__tests__/app/isolation/pollsAfterEarlyLoad.fixture.tsx",
      ],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = stdout + stderr;
    expect({ code, output }).toMatchObject({ code: 0 });
    expect(output).toContain(" 3 pass");
    expect(output).toContain(" 0 fail");
  }, 30_000);
});
