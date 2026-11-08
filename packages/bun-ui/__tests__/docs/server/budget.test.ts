/**
 * The bundle budget: builds the real viewer exactly as `scripts/build.ts`
 * does and fails when the entry module grows past {@link BUNDLE_BUDGET}. The
 * entry is the whole cost of every page load: the viewer has no lazy chunks
 * (the document decides the reference at runtime, so both are in the one
 * static graph).
 */
import { describe, expect, it } from "bun:test";
import { buildAssets } from "../../lib/assets";

/**
 * Byte limits, each about 10% above what the build measured when it was set.
 *
 * - Set 2026-10-27 (Bun 1.4.4): measured 330.8 KiB (103.2 KiB gzipped) —
 *   React 19, TanStack Query, the two references and their components, all in
 *   one entry (there is no lazy split: which reference renders depends on the
 *   document, known only after it loads).
 *
 * To raise one deliberately: run `bun scripts/build.ts --out <tmp dir>`,
 * which prints every file's size and gzipped size, set the limit about 10%
 * above the new figure, update the measurement above, and say in the change
 * why the bundle grew. Never raise it only to make this test pass.
 */
export const BUNDLE_BUDGET = {
  /** The entry module (`manifest.entry.js`), minified, in bytes. */
  entryBytes: 365 * 1024,
  /** The entry module gzipped (`Bun.gzipSync`, default level), in bytes. */
  entryGzipBytes: 114 * 1024,
  /** Any other JavaScript file of the build (a shared chunk), minified, in bytes — if a split ever appears. */
  chunkBytes: 120 * 1024,
  /** Any other JavaScript file gzipped, in bytes. */
  chunkGzipBytes: 40 * 1024,
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
  it("builds an entry module", () => {
    expect(entry).toBeDefined();
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

  it(`keeps every split chunk within ${kib(BUNDLE_BUDGET.chunkBytes)} (${kib(BUNDLE_BUDGET.chunkGzipBytes)} gzipped), if any appear`, () => {
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
