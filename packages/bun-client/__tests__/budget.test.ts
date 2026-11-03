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
 *
 * Since PR-C5 the `./query` entry has its own budget, {@link QUERY_BUDGET}:
 * the layer's own code over `@tanstack/query-core` (external, as the app
 * shares it with its `QueryClient`), the plan's "3 KB over query-core"
 * (§10.3). Measured 2026-11-02 (the same build): 5.8 KiB minified, 2.4 KiB
 * gzipped; with query-core inlined (what it brings of it: the observers and
 * `hashKey`) 17.8 KiB and 6.2 KiB. The `.` entry is byte-identical to
 * PR-C4's (11,106 bytes minified, 4,690 gzipped): `./query` adds nothing to
 * it.
 *
 * Since PR-C9 the entry also loads its bodies (`lib/bodies.ts`: multipart
 * forms, downloads, NDJSON and raw streams) with `import()`, only when a
 * call sends files or a multipart body, or a response is a download or
 * streams: a third figure, {@link BODIES_BUDGET}, and the eager figure
 * leaves that module out too. Measured 2026-11-03 (Bun
 * 1.4.4-canary.1+11c367163, over PR-C8): eager 11,922 bytes minified,
 * 5,019 gzipped (PR-C4's 11,106 and 4,690: the body encoding, the `files`
 * gate, the manifest's `bodyType` and `chunks`, the `filename` on a
 * result); the bodies chunk 2,258 and 1,165; the checks chunk 18,209 and
 * 6,571 (the `files` part). The minified limit was raised from
 * 11 KiB to 12.5 KiB for that growth; the gzipped one, the plan's, holds.
 *
 * Since PR-C6 the `./react` entry has its own budget, {@link REACT_BUDGET}:
 * the binding's own code over `@tanstack/react-query`, query-core and React
 * (external: the app shares them). Measured 2026-11-03 (the same build):
 * 855 bytes minified, 390 gzipped; with react-query and query-core inlined
 * (React external) 17.9 KiB and 6.0 KiB. The `.` and `./query` entries are
 * unchanged by it (no file they bundle changed).
 *
 * Since PR-C8 the `./persist` entry has its own budget,
 * {@link PERSIST_BUDGET}: the IndexedDB persister, which imports only
 * types from `@tanstack/query-persist-client-core`, so the bundle is its own
 * code whatever is external. Measured 2026-11-03 (the same build): 1,472
 * bytes minified, 724 gzipped. The other entries are unchanged by it.
 *
 * The PR-C4 follow-ups (response headers checked, §5.6) measured 2026-11-03
 * (the same build): eager 12,029 bytes minified, 5,052 gzipped (11,922 and
 * 5,019 before: passing the headers to the checks, and checking them alone
 * for an unread body); the checks chunk 19,149 and 6,850 (18,209 and
 * 6,571: the headers part of the response check). No limit changed.
 *
 * Since PR-S1 the `./sse` entry has its own budget, {@link SSE_BUDGET}: the
 * event-stream client (`lib/sse.ts`, its parser, and the error classes and
 * `Retry-After` reader it shares with `.`), its checks left out as they are
 * here (it loads `./validation` the same lazy way, and its event checks,
 * `./sseChecks`, beside it). Measured 2026-11-03 (Bun
 * 1.4.4-canary.1+11c367163, over the PR-C4 follow-ups): 8,058 bytes
 * minified, 3,371 gzipped, against the plan's 2 KB estimate (§10.3, "[I]"):
 * the reconnection, the watchdog, the listeners and the iterator's queue are
 * the difference. Beside `.` in one splitting build, its own chunk is 7,346
 * and 3,187, the event checks a chunk of their own (1,026 and 584), the
 * errors and `Retry-After` reader in a chunk the two share (2,005 and
 * 1,057). The `.` entry grew by 52 bytes minified, 36 gzipped (12,081 and
 * 5,088): the client keeps its configuration under a registered symbol for
 * `./sse` to read (its validation, schemas, mode and logger), and marks an
 * event stream's body unread; no SSE code is in it. The checks chunk grew
 * by 131 and 45 (19,280 and 6,895: the plan `./sse` reads, `events`), and
 * holds none of the event checks.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Byte limits for the `.` entry's eager code.
 *
 * - Gzipped: the plan's 5 KB (§10.3), "without the guards". Measured above.
 * - Minified: about 5% above the measured figure (C1's 10% until PR-C9,
 *   whose growth it absorbed), so a growth the gzip limit still absorbs is
 *   noticed early.
 *
 * To raise one deliberately: measure with the build below, set the limit
 * above the new figure, update the measurements here and say why the entry
 * grew. Never raise it only to make this test pass.
 */
const BUNDLE_BUDGET = {
  /** The entry, minified, in bytes. */
  minifiedBytes: 12.5 * 1024,
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

/**
 * Byte limits for the lazily loaded bodies chunk (PR-C9): the plan sets no
 * figure, so about 10% above the measured sizes. The same rule for raising
 * them.
 */
const BODIES_BUDGET = {
  /** The chunk, minified, in bytes. */
  minifiedBytes: 2.5 * 1024,
  /** The chunk gzipped, in bytes. */
  gzipBytes: 1.25 * 1024,
} as const;

/**
 * Byte limits for the `./query` entry, query-core left out: the plan's 3 KB
 * gzipped (§10.3), and about 10% above the measured minified figure. The
 * same rule for raising them.
 */
const QUERY_BUDGET = {
  /** The entry, minified, query-core external, in bytes. */
  minifiedBytes: 6.5 * 1024,
  /** The entry gzipped, query-core external, in bytes. */
  gzipBytes: 3 * 1024,
} as const;

/**
 * Byte limits for the `./react` entry, its peers left out: about 10% above
 * the measured minified figure, and 0.5 KiB gzipped (the plan sets no figure
 * for a binding; §7.1 says "a few hundred lines at most"). The same rule
 * for raising them.
 */
const REACT_BUDGET = {
  /** The entry, minified, react-query, query-core and React external, in bytes. */
  minifiedBytes: 0.95 * 1024,
  /** The entry gzipped, its peers external, in bytes. */
  gzipBytes: 0.5 * 1024,
} as const;

/**
 * Byte limits for the `./persist` entry: about 10% above the measured
 * minified figure, and 0.8 KiB gzipped (the plan sets no figure; §6.4 says
 * "~60 lines"). The same rule for raising them.
 */
const PERSIST_BUDGET = {
  /** The entry, minified, in bytes. */
  minifiedBytes: 1.6 * 1024,
  /** The entry gzipped, in bytes. */
  gzipBytes: 0.8 * 1024,
} as const;

/**
 * Byte limits for the `./sse` entry, its checks left out: about 10% above
 * the measured sizes (the plan's 2 KB was an estimate, measured over by the
 * PR that built the entry). The same rule for raising them.
 */
const SSE_BUDGET = {
  /** The entry, minified, its checks external, in bytes. */
  minifiedBytes: 8.5 * 1024,
  /** The entry gzipped, its checks external, in bytes. */
  gzipBytes: 3.5 * 1024,
} as const;

/** Formats bytes as KiB with one decimal, for failure messages. */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Leaves the lazy modules (`./validation`, `./bodies`, `./sseChecks`) out of a build: the entry's own code alone. */
const checksExternal: Bun.BunPlugin = {
  name: "checks-external",
  setup(build) {
    build.onResolve(
      { filter: /^\.\/(?:validation|bodies|sseChecks)$/ },
      (args) => ({
        path: args.path,
        external: true,
      }),
    );
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
const query = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "query.ts")],
  target: "browser",
  minify: true,
  external: ["@tanstack/query-core"],
});

const react = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "react.ts")],
  target: "browser",
  minify: true,
  external: ["@tanstack/react-query", "@tanstack/query-core", "react"],
});

const persist = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "persist.ts")],
  target: "browser",
  minify: true,
  external: ["@tanstack/query-persist-client-core", "@tanstack/query-core"],
});

const sseEntry = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "sse.ts")],
  target: "browser",
  minify: true,
  plugins: [checksExternal],
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

  it("splits the checks and the bodies into a chunk each: the entry and those two, nothing shared", () => {
    expect(split.success).toBe(true);
    expect(split.outputs.map((output) => output.kind).sort()).toEqual([
      "chunk",
      "chunk",
      "entry-point",
    ]);
  });

  /** A lazy chunk of the split build, by a word only its code holds. */
  const chunkWith = async (marker: string): Promise<Bun.BuildArtifact> => {
    for (const output of split.outputs) {
      if (output.kind === "chunk" && (await output.text()).includes(marker))
        return output;
    }
    throw new Error(`no chunk holds ${marker}`);
  };

  it(`keeps the checks chunk within ${kib(CHECKS_BUDGET.gzipBytes)} gzipped and ${kib(CHECKS_BUDGET.minifiedBytes)} minified`, async () => {
    const chunk = await chunkWith("createReceiver");
    expect(verdict(await sizes(chunk), CHECKS_BUDGET)).toBe("within budget");
  });

  it("keeps the event checks out of the checks chunk (./sse loads them on its own)", async () => {
    const chunk = await chunkWith("createReceiver");
    expect((await chunk.text()).includes("This event is not declared")).toBe(
      false,
    );
  });

  it(`keeps the bodies chunk within ${kib(BODIES_BUDGET.gzipBytes)} gzipped and ${kib(BODIES_BUDGET.minifiedBytes)} minified`, async () => {
    const chunk = await chunkWith("FormData");
    expect(chunk).not.toBe(await chunkWith("createReceiver"));
    expect(verdict(await sizes(chunk), BODIES_BUDGET)).toBe("within budget");
  });
});

describe("the ./query budget", () => {
  it("builds as one file, query-core left out", () => {
    expect(query.success).toBe(true);
    expect(query.outputs.length).toBe(1);
  });

  it(`keeps ./query within ${kib(QUERY_BUDGET.gzipBytes)} gzipped and ${kib(QUERY_BUDGET.minifiedBytes)} minified over query-core`, async () => {
    expect(verdict(await sizes(query.outputs[0]), QUERY_BUDGET)).toBe(
      "within budget",
    );
  });
});

describe("the ./react budget", () => {
  it("builds as one file, its peers left out", () => {
    expect(react.success).toBe(true);
    expect(react.outputs.length).toBe(1);
  });

  it(`keeps ./react within ${kib(REACT_BUDGET.gzipBytes)} gzipped and ${kib(REACT_BUDGET.minifiedBytes)} minified over react-query`, async () => {
    expect(verdict(await sizes(react.outputs[0]), REACT_BUDGET)).toBe(
      "within budget",
    );
  });
});

describe("the ./persist budget", () => {
  it("builds as one file", () => {
    expect(persist.success).toBe(true);
    expect(persist.outputs.length).toBe(1);
  });

  it(`keeps ./persist within ${kib(PERSIST_BUDGET.gzipBytes)} gzipped and ${kib(PERSIST_BUDGET.minifiedBytes)} minified`, async () => {
    expect(verdict(await sizes(persist.outputs[0]), PERSIST_BUDGET)).toBe(
      "within budget",
    );
  });
});

describe("the ./sse budget", () => {
  it("builds as one file, its checks left out", () => {
    expect(sseEntry.success).toBe(true);
    expect(sseEntry.outputs.length).toBe(1);
  });

  it(`keeps ./sse within ${kib(SSE_BUDGET.gzipBytes)} gzipped and ${kib(SSE_BUDGET.minifiedBytes)} minified`, async () => {
    expect(verdict(await sizes(sseEntry.outputs[0]), SSE_BUDGET)).toBe(
      "within budget",
    );
  });
});
