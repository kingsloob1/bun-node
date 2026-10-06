import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "bun:test";

/**
 * Each queue module loads on its own, whichever is imported first.
 *
 * `JobBuilder`, `JobDraft` and `BunQueue` import each other, and the published
 * `./lib/*.ts` export lets a consumer import any one of them directly. A value
 * one of them used at class definition (the `JOB_ROUTER` symbol as a computed
 * field) was once still uninitialised when another of the cycle was loaded
 * first, so `import ".../JobBuilder.ts"` threw `ReferenceError`. Each case runs
 * in a fresh process: inside this one, the modules are long since loaded.
 */

const LIB = join(import.meta.dir, "..", "lib");

const ENTRIES = [
  "queue/JobBuilder.ts",
  "queue/JobDraft.ts",
  "queue/BunQueue.ts",
  "queue/jobRouter.ts",
  "BunJobs.ts",
  "index.ts",
];

describe("queue modules load in any order", () => {
  for (const entry of ENTRIES) {
    it(`loads lib/${entry} first`, () => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `await import(${JSON.stringify(join(LIB, entry))});`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    });
  }
});
