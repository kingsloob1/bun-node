/**
 * The bundle budget: builds the real app exactly as `scripts/build.ts` does
 * and fails when the entry module, or any lazily loaded chunk, grows past
 * {@link BUNDLE_BUDGET}. The entry is what every page load pays for before
 * the Overview can render; a chunk is what opening one screen costs.
 */
import { describe, expect, it } from "bun:test";
import { buildAssets } from "../../lib/assets";

/**
 * Byte limits, each about 10% above what the build measured when it was set.
 *
 * - Entry, raised 2026-09-21 (Bun 1.4.3): measured 316.4 KiB (101.6 KiB
 *   gzipped), leaving 0.4 KiB of gzipped room under the old 320 / 102 KiB.
 *   Why it grew: the UI-updates round added the Workers screens, worker
 *   control, the time-range model and picker, the analytics client and the
 *   contract's new constants. Every new screen and section went into a lazy
 *   chunk; what reached the entry is the shared code the Overview and the
 *   layout need at first paint (nav entries, the range picker and its URL
 *   state, the contract's constant arrays). The user decided to raise it
 *   rather than move the Overview's range control and queue table out of the
 *   entry.
 * - Chunks, unchanged since M6 (entry then 290.2 KiB / 92.7 KiB gzipped): the
 *   largest lazy chunk is the API docs, 66.7 KiB (21.2 KiB gzipped) on
 *   2026-09-21, still under its limit.
 *
 * To raise one deliberately: run `bun scripts/build.ts --out <tmp dir>`,
 * which prints every file's size and gzipped size, set the limit about 10%
 * above the new figure, update the measurements above, and say in the
 * change why the bundle grew. Never raise it only to make this test pass.
 */
export const BUNDLE_BUDGET = {
  /** The entry module (`manifest.entry.js`), minified, in bytes. */
  entryBytes: 348 * 1024,
  /** The entry module gzipped (`Bun.gzipSync`, default level), in bytes. */
  entryGzipBytes: 112 * 1024,
  /** Any other JavaScript file of the build (a lazy screen or a shared chunk), minified, in bytes. */
  chunkBytes: 73 * 1024,
  /** Any other JavaScript file gzipped, in bytes. */
  chunkGzipBytes: 23 * 1024,
} as const;

/** Formats bytes as KiB with one decimal, for failure messages. */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const assets = await buildAssets();
const entry = assets.files.get(assets.entry.js)!;
const chunks = [...assets.files.values()].filter(
  (file) => file.name.endsWith(".js") && file.name !== assets.entry.js,
);

describe("the bundle budget", () => {
  it("builds an entry and at least one lazy chunk", () => {
    expect(entry).toBeDefined();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it(`keeps the entry module within ${kib(BUNDLE_BUDGET.entryBytes)} (${kib(BUNDLE_BUDGET.entryGzipBytes)} gzipped)`, () => {
    const gzip = Bun.gzipSync(entry.body).byteLength;
    // Compared as text, so a failure names the file and both sizes.
    const measured = `${entry.name}: ${kib(entry.size)}, gzip ${kib(gzip)}`;
    expect(
      entry.size <= BUNDLE_BUDGET.entryBytes &&
        gzip <= BUNDLE_BUDGET.entryGzipBytes
        ? "within budget"
        : measured,
    ).toBe("within budget");
  });

  it(`keeps every other chunk within ${kib(BUNDLE_BUDGET.chunkBytes)} (${kib(BUNDLE_BUDGET.chunkGzipBytes)} gzipped)`, () => {
    const over = chunks
      .map((file) => ({
        name: file.name,
        size: file.size,
        gzip: Bun.gzipSync(file.body).byteLength,
      }))
      .filter(
        (file) =>
          file.size > BUNDLE_BUDGET.chunkBytes ||
          file.gzip > BUNDLE_BUDGET.chunkGzipBytes,
      )
      .map((file) => `${file.name}: ${kib(file.size)}, gzip ${kib(file.gzip)}`);
    expect(over).toEqual([]);
  });
});
