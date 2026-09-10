import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * What a runner child loads before it reaches the user's handler.
 *
 * A fresh process or Worker is created per run, so every module in the child's
 * graph is imported again on every dispatch — the start-up cost *is* the
 * dispatch latency. `bootstrap/child-runtime.ts` needs exactly two things from
 * bun-common, `createLogger` and `serializeError`, and taking them from the
 * package barrel drags in the whole HTTP layer with them: `busboy`, `accepts`,
 * `type-is`, `parse-domain`, `file-type` and the router, none of which a child
 * ever touches.
 *
 * Measured on Bun 1.4.3: the barrel costs 58.5ms to import against 9.4ms for
 * the two deep paths, which took dispatch from 56.4ms to 9.0ms.
 *
 * This is easy to undo by accident — a barrel import is the obvious thing to
 * write — so it is asserted rather than left to a comment. Bundling the child
 * entry point is the check: with the deep imports the bundle is ~11KB, with the
 * barrel it is ~568KB.
 */

/** Bundles a child entry point and returns its single output as source. */
async function bundleChild(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "..", "lib", "runner", "bootstrap", entry),
    ],
    target: "bun",
  });

  expect(result.success).toBe(true);
  return await result.outputs[0]!.text();
}

/** Anything here means the HTTP layer came along for the ride. */
const HTTP_LAYER = ["busboy", "accepts", "@routejs/router", "BunRouter"];

/**
 * Generous: the child is ~11KB today and the barrel is ~568KB, so this leaves
 * plenty of room to grow while still catching a whole framework.
 */
const MAX_BYTES = 120_000;

describe("runner child start-up", () => {
  for (const entry of ["spawn-entry.ts", "worker-entry.ts"]) {
    it(`${entry} does not pull in bun-common's HTTP layer`, async () => {
      const code = await bundleChild(entry);

      for (const marker of HTTP_LAYER) {
        expect(code).not.toContain(marker);
      }
    });

    it(`${entry} stays small enough to import per run`, async () => {
      const code = await bundleChild(entry);
      expect(code.length).toBeLessThan(MAX_BYTES);
    });
  }
});
