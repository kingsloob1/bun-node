/**
 * The bundle budget (plan §10.3): the package entry, built for a browser and
 * minified as an app's bundler would, must stay within
 * {@link BUNDLE_BUDGET} gzipped. It is what every page using the client pays
 * before the first request.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Byte limits for the `.` entry.
 *
 * - Gzipped: the plan's 5 KB (§10.3), "without the guards" (validation is
 *   PR-C4, loaded lazily). Measured 4.2 KiB on 2026-11-02 (Bun
 *   1.4.4-canary.1+11c367163), 9.9 KiB minified.
 * - Minified: about 10% above the measured figure, so a growth the gzip
 *   limit still absorbs is noticed early.
 *
 * To raise one deliberately: measure with the build below, set the limit
 * above the new figure, update the measurements here and say why the entry
 * grew. Never raise it only to make this test pass.
 */
const BUNDLE_BUDGET = {
  /** The entry, minified, in bytes. */
  minifiedBytes: 11 * 1024,
  /** The entry gzipped (`Bun.gzipSync`, default level), in bytes. */
  gzipBytes: 5 * 1024,
} as const;

/** Formats bytes as KiB with one decimal, for failure messages. */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "index.ts")],
  target: "browser",
  minify: true,
});
const bytes = new Uint8Array(await result.outputs[0].arrayBuffer());
const gzip = Bun.gzipSync(bytes).byteLength;

describe("the bundle budget", () => {
  it("builds one file", () => {
    expect(result.success).toBe(true);
    expect(result.outputs.length).toBe(1);
  });

  it(`keeps the entry within ${kib(BUNDLE_BUDGET.gzipBytes)} gzipped and ${kib(BUNDLE_BUDGET.minifiedBytes)} minified`, () => {
    // Compared as text, so a failure names both sizes.
    const measured = `minified ${kib(bytes.byteLength)}, gzip ${kib(gzip)}`;
    expect(
      bytes.byteLength <= BUNDLE_BUDGET.minifiedBytes &&
        gzip <= BUNDLE_BUDGET.gzipBytes
        ? "within budget"
        : measured,
    ).toBe("within budget");
  });
});
