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
 * `useLive` (2026-11-08, the same build): `./react` 1,186 bytes minified,
 * 567 gzipped (855 and 390 before; it starts `live()` through a symbol
 * `queries()` puts on its factories, so the entry still imports nothing of
 * `./query`); the limits were raised from 0.95 and 0.5 KiB to 1.3 and
 * 0.6 KiB for it. `./query` 6,978 and 2,890 (that symbol, and a
 * mutation's `validate`); the live chunk 3,897 and 1,773 (`hello`'s
 * `denied`). No other limit changed.
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
 *
 * Since PR-W2 the `./channel` entry has its own budget,
 * {@link CHANNEL_BUDGET}: the channel client (`lib/channel.ts`: the shared
 * socket, reconnection, the watchdog and ping, the offline buffer, requests,
 * listeners and iterators, the `"bun-common"` codec, and the error classes it
 * shares with `.`), its checks (`./channelChecks`) left out as `./sse`'s are.
 * Measured 2026-11-03 (Bun 1.4.4-canary.1+11c367163, over PR-S1): 11,831
 * bytes minified, 4,523 gzipped, against the plan's 4 KB estimate (§10.3,
 * "[I]"). Its checks, a splitting build's chunk with bun-contract's guards
 * and `channelContract` (taken through `./validation`, their one import
 * site, of which a bundler keeps only those), 17,447 and 6,406, against
 * {@link CHANNEL_CHECKS_BUDGET}. The `.` entry is 12,074 and 5,085 (7 and 3
 * bytes under PR-S1's: `ValidationError` names a channel's direction, a
 * shorter expression); no channel code and none of the channel errors are
 * in it. PR-W3's `"bun-nest"` codec (packets, acks by id, base64 bytes) took
 * the entry to 13,123 and 5,019 (+1,292 and +496; the same build), 189 and
 * 101 bytes under the limits, which it left as they were.
 *
 * Since PR-W4 `./query` carries `live()`, whose implementation
 * (`lib/live.ts`) it loads with `import()` on the first call, as `.` loads
 * its checks: the `./query` build leaves that module out, and the live chunk
 * has its own budget, {@link LIVE_BUDGET}, with `./channel` and `./sse`
 * (which it loads the same way) left out. Measured 2026-11-03 (Bun
 * 1.4.4-canary.1+11c367163, over develop 5b4a6f5c): `./query` 6,211 bytes
 * minified, 2,626 gzipped (5,974 and 2,486 before: `live()`, its options'
 * default and the lazy load); the live chunk 3,547 and 1,643. A build that inlined
 * the live chunk with the channel and SSE clients under it would be 56,149
 * and 19,732, which is why each loads lazily. The `.` entry is unchanged
 * (12,074 and 5,085).
 *
 * Since PR-G1 the `./graphql` entry has its own budget,
 * {@link GRAPHQL_BUDGET}: the GraphQL client (`lib/graphql.ts`: the
 * document reader and its operation scanner, the GET form, the retry and
 * throw switches, the result-schema wrapper, and the three error classes it
 * shares with `.`), which imports nothing else (its checks are the HTTP
 * client's, loaded by that client). Measured 2026-11-03 (Bun
 * 1.4.4-canary.1+11c367163, over develop 62e68e27): 4,698 bytes minified,
 * 2,298 gzipped, against the plan's 0.5 KB estimate (§10.3, "[I]"; the
 * spike's thin POST was 0.3 KB): the operation scanner, the error class and
 * the messages are the difference. `./query` grew by `q.graphql()` to 6,859
 * and 2,855 (6,211 and 2,626 before), past its minified limit, which was
 * raised from 6.5 to 7 KiB for it; the gzipped one, the plan's 3 KB, holds.
 * The `.` entry is unchanged in size (12,074 minified; the new error class
 * is shaken out of it).
 *
 * Since PR-R1 the `./webrtc` entry has its own budget, {@link WEBRTC_BUDGET}:
 * `connectPeer` (the offer/answer exchange, trickle ICE with both queues,
 * the event listening that works on any `RTCPeerConnection`). It imports
 * nothing, not even the guards: the signalling channel checks its own
 * frames. Measured 2026-11-03 (Bun 1.4.4-canary.1+11c367163, over PR-W3):
 * 2,555 bytes minified, 1,112 gzipped, against the plan's 2 KB for
 * `./webrtc` (§10.3, the whole entry: PR-R2's data channels join it). No
 * other entry changed (no file they bundle did).
 *
 * PR-R2 adds `typedDataChannel` to it (the envelope, both guards through
 * the channel's lazily loaded checks, requests and their error frames,
 * `sendWhenReady` on `bufferedamountlow`, binary frames) and the error
 * classes it shares with `./channel`. Measured 2026-11-03 (the same build):
 * 10,656 bytes minified, 4,224 gzipped, its checks left out, against the
 * plan's 2 KB (§10.3, "[I]", an estimate, as `./channel`'s 4 KB was); the
 * limits were raised from 2.8 and 2 KiB to 11.5 and 4.5 KiB for it. Its
 * checks are `./channel`'s chunk, byte for byte (17,447 and 6,406), against
 * {@link CHANNEL_CHECKS_BUDGET}.
 *
 * Non-string request headers (2026-11-08, Bun 1.4.4-canary.1+11c367163):
 * eager 12,143 bytes minified, 5,103 gzipped (12,074 and 5,086 on develop
 * 5a8c331e: a call's `undefined` header dropped, a number sent as its
 * string), 17 bytes under the gzip limit. No limit changed.
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
 *
 * Raised 2026-11-08 for `validate.unknownKeys` (bun-contract's
 * `droppedKeys` and its review in `./validation`): 19,278 → 20,544 bytes minified,
 * 6,895 → 7,313 gzipped, so 19 → 20.5 KiB and 7 → 7.5 KiB. Loading it with
 * its own `import()` kept this chunk under 7 KiB gzipped but made Bun add a
 * chunk-preload runtime and two chunks, a worse trade.
 */
const CHECKS_BUDGET = {
  /** The chunk, minified, in bytes. */
  minifiedBytes: 20.5 * 1024,
  /** The chunk gzipped, in bytes. */
  gzipBytes: 7.5 * 1024,
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
  // Minified raised 6.5 to 7 KiB for `q.graphql()` (PR-G1, measured
  // 2026-11-03 at 6,859 bytes; see the history above).
  /** The entry, minified, query-core external, in bytes. */
  minifiedBytes: 7 * 1024,
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
  // Raised from 0.95 and 0.5 KiB for `useLive` (measured above).
  /** The entry, minified, react-query, query-core and React external, in bytes. */
  minifiedBytes: 1.3 * 1024,
  /** The entry gzipped, its peers external, in bytes. */
  gzipBytes: 0.6 * 1024,
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

/**
 * Byte limits for the `./channel` entry, its checks left out: about 10%
 * above the measured sizes (the plan's 4 KB was an estimate, measured over
 * by the PR that built the entry, as `./sse`'s was). The same rule for
 * raising them.
 */
const CHANNEL_BUDGET = {
  // Minified raised 13 to 14 KiB for the `"bun-nest"` codec's `ackId`
  // handling (about 0.3 KiB minified, 0.1 gzipped, measured 2026-11-03; the
  // entry was at 13.0 KiB of 13 before). Raised again with PR-W4 (the
  // user's decision, 2026-11-03) to 14.5 KiB minified and 5.5 KiB gzipped:
  // measured 2026-11-03 (Bun 1.4.4-canary.1+11c367163, develop 5b4a6f5c
  // with PR-W4) at 13,434 bytes minified and 5,116 gzipped, 4 bytes under
  // the former 5 KiB gzip limit, which left no room for the next change.
  /** The entry, minified, its checks external, in bytes. */
  minifiedBytes: 14.5 * 1024,
  /** The entry gzipped, its checks external, in bytes. */
  gzipBytes: 5.5 * 1024,
} as const;

/**
 * Byte limits for the channel's checks chunk (bun-contract's guards and
 * `channelContract`, and `./channelChecks`): the core checks chunk's
 * limits, which it stays under. The same rule for raising them.
 */
const CHANNEL_CHECKS_BUDGET = {
  /** The chunk, minified, in bytes. */
  minifiedBytes: 19 * 1024,
  /** The chunk gzipped, in bytes. */
  gzipBytes: 7 * 1024,
} as const;

/**
 * Byte limits for the live chunk (`lib/live.ts`, PR-W4), `./channel` and
 * `./sse` left out: the plan sets no figure, so about 10% above the
 * measured sizes. The same rule for raising them.
 */
const LIVE_BUDGET = {
  /** The chunk, minified, in bytes. */
  minifiedBytes: 3.875 * 1024,
  /** The chunk gzipped, in bytes. */
  gzipBytes: 1.875 * 1024,
} as const;

/**
 * Byte limits for the `./graphql` entry: about 10% above the measured
 * sizes (the plan's 0.5 KB was an estimate, measured over by the PR that
 * built the entry, as `./sse`'s was). The same rule for raising them.
 */
const GRAPHQL_BUDGET = {
  /** The entry, minified, in bytes. */
  minifiedBytes: 5.125 * 1024,
  /** The entry gzipped, in bytes. */
  gzipBytes: 2.5 * 1024,
} as const;

/**
 * Byte limits for the `./webrtc` entry, its checks left out: about 10% above
 * the measured figures (the plan's 2 KB gzipped, §10.3, was an estimate).
 * The same rule for raising them.
 */
const WEBRTC_BUDGET = {
  // Raised from 2.8 and 2 KiB for PR-R2's typedDataChannel (measured above).
  /** The entry, minified, its checks external, in bytes. */
  minifiedBytes: 11.5 * 1024,
  /** The entry gzipped, its checks external, in bytes. */
  gzipBytes: 4.5 * 1024,
} as const;

/** Formats bytes as KiB with one decimal, for failure messages. */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Leaves the lazy modules (`./validation`, `./bodies`, `./sseChecks`, `./channelChecks`) out of a build: the entry's own code alone. */
const checksExternal: Bun.BunPlugin = {
  name: "checks-external",
  setup(build) {
    build.onResolve(
      { filter: /^\.\/(?:validation|bodies|sseChecks|channelChecks)$/ },
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
/** Leaves a lazily loaded transport or layer (`./live`, `./channel`, `./sse`) out of a build. */
const lazyExternal = (filter: RegExp): Bun.BunPlugin => ({
  name: "lazy-external",
  setup(build) {
    build.onResolve({ filter }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
});

const query = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "query.ts")],
  target: "browser",
  minify: true,
  external: ["@tanstack/query-core"],
  plugins: [lazyExternal(/^\.\/live$/)],
});

const liveChunk = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "live.ts")],
  target: "browser",
  minify: true,
  external: ["@tanstack/query-core"],
  plugins: [lazyExternal(/^\.\/(?:channel|sse)$/)],
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

const channelEntry = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "channel.ts")],
  target: "browser",
  minify: true,
  plugins: [checksExternal],
});
const channelSplit = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "channel.ts")],
  target: "browser",
  minify: true,
  splitting: true,
});

const sseEntry = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "sse.ts")],
  target: "browser",
  minify: true,
  plugins: [checksExternal],
});

const graphqlEntry = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "graphql.ts")],
  target: "browser",
  minify: true,
});

const webrtcEntry = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "webrtc.ts")],
  target: "browser",
  minify: true,
  plugins: [checksExternal],
});
const webrtcSplit = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "lib", "webrtc.ts")],
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

describe("the live chunk's budget", () => {
  it("builds as one file, the channel and SSE clients left out", () => {
    expect(liveChunk.success).toBe(true);
    expect(liveChunk.outputs.length).toBe(1);
  });

  it(`keeps the live chunk within ${kib(LIVE_BUDGET.gzipBytes)} gzipped and ${kib(LIVE_BUDGET.minifiedBytes)} minified`, async () => {
    expect(verdict(await sizes(liveChunk.outputs[0]), LIVE_BUDGET)).toBe(
      "within budget",
    );
  });

  it("loads the live layer lazily: ./query's build without it carries none of it", async () => {
    const code = await query.outputs[0]!.text();
    expect(code).toContain("./live");
    expect(code).not.toContain("/__live");
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

describe("the ./channel budget", () => {
  it("builds as one file, its checks left out", () => {
    expect(channelEntry.success).toBe(true);
    expect(channelEntry.outputs.length).toBe(1);
  });

  it(`keeps ./channel within ${kib(CHANNEL_BUDGET.gzipBytes)} gzipped and ${kib(CHANNEL_BUDGET.minifiedBytes)} minified`, async () => {
    expect(verdict(await sizes(channelEntry.outputs[0]), CHANNEL_BUDGET)).toBe(
      "within budget",
    );
  });

  it(`splits its checks into one chunk within ${kib(CHANNEL_CHECKS_BUDGET.gzipBytes)} gzipped and ${kib(CHANNEL_CHECKS_BUDGET.minifiedBytes)} minified, holding none of the HTTP checks`, async () => {
    expect(channelSplit.success).toBe(true);
    const chunks = channelSplit.outputs.filter(
      (output) => output.kind === "chunk",
    );
    expect(chunks.length).toBe(1);
    const text = await chunks[0].text();
    // channelContract's own message: the contract is built here from the
    // generated schemas.
    expect(text.includes('must be a route path (starting with "/")')).toBe(
      true,
    );
    // ./validation's own code (the HTTP request and response checks) is
    // shaken out: only the guards it re-exports are kept.
    expect(text.includes("the schema source has no")).toBe(false);
    expect(text.includes("failed to load")).toBe(false);
    expect(verdict(await sizes(chunks[0]), CHANNEL_CHECKS_BUDGET)).toBe(
      "within budget",
    );
  });

  it("keeps channelContract (the channel checks' own) out of the core client's chunks", async () => {
    for (const output of split.outputs)
      expect(
        (await output.text()).includes(
          'must be a route path (starting with "/")',
        ),
      ).toBe(false);
  });
});

describe("the ./graphql budget", () => {
  it("builds as one file", () => {
    expect(graphqlEntry.success).toBe(true);
    expect(graphqlEntry.outputs.length).toBe(1);
  });

  it(`keeps ./graphql within ${kib(GRAPHQL_BUDGET.gzipBytes)} gzipped and ${kib(GRAPHQL_BUDGET.minifiedBytes)} minified`, async () => {
    expect(verdict(await sizes(graphqlEntry.outputs[0]), GRAPHQL_BUDGET)).toBe(
      "within budget",
    );
  });
});

describe("the ./webrtc budget", () => {
  it("builds as one file, its checks left out", () => {
    expect(webrtcEntry.success).toBe(true);
    expect(webrtcEntry.outputs.length).toBe(1);
  });

  it(`keeps ./webrtc within ${kib(WEBRTC_BUDGET.gzipBytes)} gzipped and ${kib(WEBRTC_BUDGET.minifiedBytes)} minified`, async () => {
    expect(verdict(await sizes(webrtcEntry.outputs[0]), WEBRTC_BUDGET)).toBe(
      "within budget",
    );
  });

  it(`splits its checks into one chunk, ./channel's, within ${kib(CHANNEL_CHECKS_BUDGET.gzipBytes)} gzipped and ${kib(CHANNEL_CHECKS_BUDGET.minifiedBytes)} minified`, async () => {
    expect(webrtcSplit.success).toBe(true);
    const chunks = webrtcSplit.outputs.filter(
      (output) => output.kind === "chunk",
    );
    expect(chunks.length).toBe(1);
    const channelChunks = channelSplit.outputs.filter(
      (output) => output.kind === "chunk",
    );
    expect(await chunks[0].text()).toBe(await channelChunks[0].text());
    expect(verdict(await sizes(chunks[0]), CHANNEL_CHECKS_BUDGET)).toBe(
      "within budget",
    );
  });
});
