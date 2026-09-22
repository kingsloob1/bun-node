import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { JOB_DEFAULT_KEYS } from "../lib/api/contract/constants";
import * as JobDefaults from "../lib/queue/jobDefaults";
import {
  ALL_JOB_OPTION_BITS,
  explicitMaskOf,
  JOB_OPTION_BITS,
} from "../lib/queue/optionBits";

/**
 * What a spawned runner child loads (fix round A1).
 *
 * A fresh process is created per spawned run, so every module in the child's
 * graph is imported again on every dispatch. Two imports this round made it
 * ~5 ms slower per spawn, measured: the console-capture module (which loads
 * `node:util` and `node:async_hooks`), imported statically though a spawned
 * child never captures, and `jobDefaults.ts` — with the API contract's
 * constants and `windows.ts` behind it — reached through `options.ts` for one
 * function, `explicitMaskOf`. Capture is now imported on demand by a worker
 * run that captures, and the mask lives in the import-free `optionBits.ts`.
 *
 * `runner-startup.test.ts` guards the bun-common barrel; this guards these.
 */

const LIB = join(import.meta.dir, "..", "lib");

/** The lib-relative paths of every module importing the child runtime loads, in a fresh process. */
async function childModules(): Promise<string[]> {
  const entry = join(LIB, "runner", "bootstrap", "child-runtime.ts");
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `await import(${JSON.stringify(entry)}); console.log(JSON.stringify(Object.keys(require.cache)))`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  return (JSON.parse(out) as string[]).map((path) =>
    path.startsWith(LIB) ? path.slice(LIB.length + 1) : path,
  );
}

describe("spawned child module graph", () => {
  it("loads no console capture and no job-defaults graph", async () => {
    const modules = await childModules();

    for (const unwanted of [
      "runner/consoleCapture.ts",
      "runner/consolePatch.ts",
      "runner/realmConsole.ts",
      "queue/jobDefaults.ts",
      "queue/windows.ts",
    ]) {
      expect(modules).not.toContain(unwanted);
    }
    // develop's eleven, plus `optionBits.ts` and the contract constants that
    // `shared/constants.ts` now re-exports run-log values from (measured: no
    // difference beyond noise, 24.0 vs 24.3 ms).
    expect(modules.length).toBeLessThanOrEqual(13);
  });
});

describe("optionBits", () => {
  it("names exactly the editable option keys", () => {
    expect(Object.keys(JOB_OPTION_BITS).sort()).toEqual(
      [...JOB_DEFAULT_KEYS].sort(),
    );
    expect(Object.values(JOB_OPTION_BITS).reduce((a, b) => a | b, 0)).toBe(
      ALL_JOB_OPTION_BITS,
    );
  });

  it("is what jobDefaults exports, so the public names are unchanged", () => {
    expect(JobDefaults.JOB_OPTION_BITS).toBe(JOB_OPTION_BITS);
    expect(JobDefaults.explicitMaskOf).toBe(explicitMaskOf);
    expect(JobDefaults.ALL_JOB_OPTION_BITS).toBe(ALL_JOB_OPTION_BITS);
  });

  it("masks only the keys a call passed, whatever their order", () => {
    expect(explicitMaskOf(undefined)).toBe(0);
    expect(explicitMaskOf({})).toBe(0);
    expect(explicitMaskOf({ attempts: undefined })).toBe(0);
    expect(
      explicitMaskOf({ keepStacktraces: 1, priority: 2, delay: 5, jobId: "x" }),
    ).toBe(JOB_OPTION_BITS.keepStacktraces | JOB_OPTION_BITS.priority);
    const all = Object.fromEntries(JOB_DEFAULT_KEYS.map((key) => [key, 1]));
    expect(explicitMaskOf(all)).toBe(ALL_JOB_OPTION_BITS);
  });

  it("has no runtime imports", async () => {
    const source = await Bun.file(join(LIB, "queue", "optionBits.ts")).text();
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).toStartWith("import type ");
    }
  });
});
