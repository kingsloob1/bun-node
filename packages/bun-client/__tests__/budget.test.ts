/**
 * The bundle budget (plan §10.3): the package entry, built for a browser and
 * minified as an app's bundler would, must stay within
 * {@link BUNDLE_BUDGET} gzipped. It is what every page using the client pays
 * before the first request.
 *
 * Since PR-C4 the entry loads its checks (`lib/validation.ts`, and with it
 * bun-contract's guards) with `import()`, only when a call validates. So
 * there are two figures:
 *
 * - **eager**: the entry with the checks module left out (external), which
 *   is the client's own code whatever the app's bundler adds to load a
 *   chunk. It keeps C1's budget, unchanged.
 * - **lazy**: the checks chunk, as a splitting build (`splitting: true`)
 *   emits it, against {@link CHECKS_BUDGET}.
 *
 * Measured 2026-11-02 (Bun 1.4.4-canary.1+11c367163): eager 10.8 KiB
 * minified, 4.6 KiB gzipped (C1's entry was 9.9 and 4.2: `ValidationError`,
 * the mode and the lazy gate are the difference); the checks chunk 17.4 KiB
 * minified, 6.3 KiB gzipped. A Bun splitting build's entry chunk adds Bun's
 * chunk loader (0.7 KiB minified, 0.4 KiB gzipped) to the eager figure:
 * 11.5 KiB and 5.0 KiB.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Byte limits for the `.` entry's eager code.
 *
 * - Gzipped: the plan's 5 KB (§10.3), "without the guards". Measured above.
 * - Minified: about 10% above C1's measured figure, so a growth the gzip
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

/**
 * Byte limits for the lazily loaded checks chunk: the plan's 7 KB for the
 * guards (§10.3, measured 6.8 KB there with `channelContract`), and about
 * 10% above the measured minified figure. The same rule for raising them.
 */
const CHECKS_BUDGET = {
  /** The chunk, minified, in bytes. */
  minifiedBytes: 19 * 1024,
  /** The chunk gzipped, in bytes. */
  gzipBytes: 7 * 1024,
} as const;

/** Formats bytes as KiB with one decimal, for failure messages. */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Leaves `./validation` out of a build: the entry's own code alone. */
const checksExternal: Bun.BunPlugin = {
  name: "checks-external",
  setup(build) {
    build.onResolve({ filter: /^\.\/validation$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const ENTRY = join(import.meta.dir, "..", "lib", "index.ts");

const eager = await Bun.build({
  entrypoints: [ENTRY],
  target: "browser",
  minify: true,
  plugins: [checksExternal],
});
const split = await Bun.build({
  entrypoints: [ENTRY],
  target: "browser",
  minify: true,
  splitting: true,
});

/** An output's minified and gzipped sizes. */
async function sizes(
  output: Bun.BuildArtifact,
): Promise<{ minified: number; gzip: number }> {
  const bytes = new Uint8Array(await output.arrayBuffer());
  return { minified: bytes.byteLength, gzip: Bun.gzipSync(bytes).byteLength };
}

/** "within budget", or both sizes, so a failure names them. */
function verdict(
  measured: { minified: number; gzip: number },
  budget: { minifiedBytes: number; gzipBytes: number },
): string {
  return measured.minified <= budget.minifiedBytes &&
    measured.gzip <= budget.gzipBytes
    ? "within budget"
    : `minified ${kib(measured.minified)}, gzip ${kib(measured.gzip)}`;
}

describe("the bundle budget", () => {
  it("builds the eager entry as one file, the checks left out", () => {
    expect(eager.success).toBe(true);
    expect(eager.outputs.length).toBe(1);
  });

  it(`keeps the eager entry within ${kib(BUNDLE_BUDGET.gzipBytes)} gzipped and ${kib(BUNDLE_BUDGET.minifiedBytes)} minified (C1's budget)`, async () => {
    expect(verdict(await sizes(eager.outputs[0]), BUNDLE_BUDGET)).toBe(
      "within budget",
    );
  });

  it("splits the checks into one chunk of their own: the entry and that chunk, nothing shared", () => {
    expect(split.success).toBe(true);
    expect(split.outputs.map((output) => output.kind).sort()).toEqual([
      "chunk",
      "entry-point",
    ]);
  });

  it(`keeps the checks chunk within ${kib(CHECKS_BUDGET.gzipBytes)} gzipped and ${kib(CHECKS_BUDGET.minifiedBytes)} minified`, async () => {
    const chunk = split.outputs.find((output) => output.kind === "chunk")!;
    expect(verdict(await sizes(chunk), CHECKS_BUDGET)).toBe("within budget");
  });
});
