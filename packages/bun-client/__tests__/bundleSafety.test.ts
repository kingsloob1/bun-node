/**
 * The browser bundle carries nothing of a server (plan D17, §10.3).
 *
 * Builds the package entry with `Bun.build({ target: "browser" })`,
 * unminified so identifiers survive, and looks for anything only server code
 * contains: a `node:` or `bun:` import, a `Bun.` API, an import of bun-common
 * or any other package (the client has no runtime dependency at all). A
 * negative control builds an entry that does import bun-common, and the
 * check must catch it. Copied from bun-jobs-ui's
 * `__tests__/app/pkg/bundle-safety.test.ts`.
 *
 * Since PR-C4 it also proves the lazy load (plan §10.1): a splitting build
 * of the entry puts bun-contract's guards in the checks chunk alone, so an
 * HTTP-only page with validation off never loads them; a negative control
 * importing the checks statically puts them in its entry chunk. And the
 * `./zod` entry carries no zod (it imports zod's types only).
 *
 * Since PR-C5 the `./query` entry (plan §10.1): built with its optional peer,
 * `@tanstack/query-core`, left external as an app's bundler shares it, it
 * imports that package and nothing else, carries nothing of a server and
 * none of the core client (the app's `createClient` comes from `.`); built
 * with query-core inlined, it still carries nothing of a server. A negative
 * control beside bun-common must be caught.
 *
 * Since PR-W4 `./query` loads its live layer (`lib/live.ts`) lazily, so the
 * entry is checked with that module left out, and the layer on its own,
 * with the channel and SSE clients it loads lazily left out in turn: it
 * imports nothing (query-core's types only), and carries nothing of a
 * server, the core client or the contract.
 *
 * Since PR-C6 the `./react` entry (plan §7.1, §10.1): built with its peers
 * (`@tanstack/react-query`, `react`) external, it imports react-query and
 * nothing else, and carries none of the query layer or the core client
 * (it takes the app's `queries()` object); with react-query and query-core
 * inlined (React left to the app), still nothing of a server. A negative
 * control beside bun-common must be caught.
 *
 * Since PR-C8 the `./persist` entry (plan §6.4, §10.1): it imports only
 * types from its optional peer, so its bundle imports nothing at all,
 * carries nothing of a server, the query layer or the core client, and
 * reaches IndexedDB through the page's own `indexedDB`. A negative control
 * beside bun-common must be caught.
 *
 * Since PR-S1 the `./sse` entry (`sse.md`, plan §10.1): it imports nothing,
 * carries nothing of a server and none of the core client's pipeline (it
 * calls the app's client), and a splitting build loads bun-contract's guards
 * only lazily, as the `.` entry does. A negative control beside bun-common
 * must be caught.
 *
 * Since PR-W2 the `./channel` entry (`websocket.md`, plan §10.1): the same
 * three checks — it imports nothing and holds nothing of a server or the
 * core client's pipeline, bun-contract only in a lazily imported chunk, and
 * a negative control beside bun-common is caught.
 *
 * Since PR-G1 the `./graphql` entry (`graphql.md`, plan §10.1): it imports
 * nothing (no GraphQL library, and nothing of the core client's pipeline:
 * it calls the app's client), holds nothing of a server, and has no lazy
 * chunk at all (its result checks are the HTTP client's). A negative
 * control beside bun-common must be caught.
 *
 * Since PR-R1 the `./webrtc` entry (`webrtc.md`): it imports nothing, holds
 * nothing of a server, the core client or the channel client (it drives the
 * app's channel); since PR-R2 its data channels load bun-contract's guards
 * only lazily, as `./channel` does; a negative control beside bun-common's
 * relay is caught.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const ENTRY = join(import.meta.dir, "..", "lib", "index.ts");

/** Text that only server code contains. */
const SERVER_MARKERS: readonly RegExp[] = [
  /["'`](?:node|bun):[\w/]+["'`]/,
  /\bimport\.meta\.require\b/,
  /\bBun\.\w+/,
  /\bprocess\.(?:env|versions|platform)\b/,
  /@kingsleyweb\/bun-common/,
  /\bBunRouter\b/,
  /\brequire\(/,
];

/** The server markers found in `code`, as their sources. */
function serverMarkersIn(code: string): string[] {
  return SERVER_MARKERS.filter((marker) => marker.test(code)).map(
    (marker) => marker.source,
  );
}

/** Builds `entry` for a browser, unminified: its code, or the build's logs. */
async function build(
  entry: string,
  external: string[] = [],
  lazy?: RegExp,
): Promise<{ code?: string; logs: string[] }> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: false,
    throw: false,
    external,
    // A lazily loaded module (`import()`) left out, as a splitting build
    // leaves it in a chunk of its own.
    plugins:
      lazy === undefined
        ? []
        : [
            {
              name: "lazy-external",
              setup(builder) {
                builder.onResolve({ filter: lazy }, (args) => ({
                  path: args.path,
                  external: true,
                }));
              },
            },
          ],
  });
  if (!result.success) return { logs: result.logs.map(String) };
  const code = (
    await Promise.all(result.outputs.map((output) => output.text()))
  ).join("\n");
  return { code, logs: [] };
}

/** Text only bun-contract's guards and runner contain (unminified names). */
const CONTRACT_MARKERS: readonly string[] = [
  "class ContractError",
  "function createReceiver",
  "function validateStandard",
  "stripProtoKeys",
];

/** The contract markers found in `code`. */
function contractMarkersIn(code: string): string[] {
  return CONTRACT_MARKERS.filter((marker) => code.includes(marker));
}

/**
 * Builds `entry` with splitting, unminified: the code a page loads before
 * anything runs (the entry chunk and the chunks it imports statically, by
 * `import … from`), and every chunk loaded only by `import()`.
 */
async function splitBuild(
  entry: string,
): Promise<{ eager: string; lazy: string[] }> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: false,
    splitting: true,
  });
  const byName = new Map<string, string>();
  let root = "";
  for (const output of result.outputs) {
    const code = await output.text();
    byName.set(output.path.replace(/^\.\//, ""), code);
    if (output.kind === "entry-point") root = code;
  }
  const eager = [root];
  const seen = new Set<string>();
  for (let index = 0; index < eager.length; index++) {
    for (const match of eager[index].matchAll(
      /^import[^"]*from\s*"\.\/([^"]+)"/gm,
    )) {
      if (seen.has(match[1])) continue;
      seen.add(match[1]);
      eager.push(byName.get(match[1]) ?? "");
    }
  }
  const lazy = [...byName]
    .filter(([name, code]) => code !== root && !seen.has(name))
    .map(([, code]) => code);
  return { eager: eager.join("\n"), lazy };
}

describe("the browser bundle of @kingsleyweb/bun-client", () => {
  it("builds, keeps the client, and holds nothing of a server", async () => {
    const { code, logs } = await build(ENTRY);
    expect(logs).toEqual([]);
    expect(code!.includes("createClient")).toBe(true);
    expect(code!.includes("UnexpectedStatusError")).toBe(true);
    expect(serverMarkersIn(code!)).toEqual([]);
  });

  it("imports no package at all: the bundle has no import statement left", async () => {
    const { code } = await build(ENTRY);
    expect(code!.match(/^\s*import\s/m)).toBeNull();
  });

  it("negative control: an entry importing bun-common is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "server-import.ts"),
    );
    // Either the browser build refuses the server modules outright, or the
    // bundle it produces carries markers. Both prove the check has teeth.
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});

describe("the lazy load of the checks (plan §10.1)", () => {
  it("keeps bun-contract out of what loads first: it is in the lazily imported checks chunk alone", async () => {
    const { eager, lazy } = await splitBuild(ENTRY);
    expect(eager.includes("createClient")).toBe(true);
    expect(contractMarkersIn(eager)).toEqual([]);
    expect(eager).toMatch(/import\("\.\/chunk-[\w-]+\.js"\)/);
    // Two lazy chunks: the checks (bun-contract), and the bodies (PR-C9:
    // forms, downloads, streams), which holds none of it.
    expect(lazy.length).toBe(2);
    const [checks, bodies] = lazy.toSorted(
      (a, b) => contractMarkersIn(b).length - contractMarkersIn(a).length,
    );
    expect(contractMarkersIn(checks)).toEqual([...CONTRACT_MARKERS]);
    expect(contractMarkersIn(bodies)).toEqual([]);
    expect(bodies.includes("multipart") || bodies.includes("FormData")).toBe(
      true,
    );
    for (const chunk of lazy) expect(serverMarkersIn(chunk)).toEqual([]);
  });

  it("negative control: an entry importing the checks statically carries bun-contract in what loads first", async () => {
    const { eager } = await splitBuild(
      join(import.meta.dir, "fixtures", "eager-checks.ts"),
    );
    expect(contractMarkersIn(eager)).toEqual([...CONTRACT_MARKERS]);
  });
});

describe("the ./zod entry", () => {
  it("bundles to no zod code and nothing of a server: zod comes with the generated module", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "..", "lib", "zod.ts"),
    );
    expect(logs).toEqual([]);
    expect(code!.includes("schemasFromZod")).toBe(true);
    expect(code!.match(/^\s*import\s/m)).toBeNull();
    expect(code!.includes("$ZodType")).toBe(false);
    expect(serverMarkersIn(code!)).toEqual([]);
  });
});

describe("the ./query entry (plan §10.1, §10.3)", () => {
  const QUERY = join(import.meta.dir, "..", "lib", "query.ts");
  const PEER = ["@tanstack/query-core"];

  /** The specifiers `code` still imports. */
  const importsOf = (code: string): string[] =>
    [...code.matchAll(/^import[^"]*from\s*"([^"]+)"/gm)].map(
      (match) => match[1],
    );

  it("imports its optional peer and nothing else, and holds nothing of a server or of the core client", async () => {
    // The live layer (PR-W4) is its own chunk: `live()` loads it lazily.
    const { code, logs } = await build(QUERY, PEER, /^\.\/live$/);
    expect(logs).toEqual([]);
    expect(code!.includes("function queries")).toBe(true);
    expect(code!.includes("function observe")).toBe(true);
    expect(importsOf(code!)).toEqual(["@tanstack/query-core"]);
    expect(serverMarkersIn(code!)).toEqual([]);
    expect(code!.includes("function createClient")).toBe(false);
    expect(contractMarkersIn(code!)).toEqual([]);
  });

  it("with query-core inlined, still holds nothing of a server", async () => {
    const { code, logs } = await build(QUERY);
    expect(logs).toEqual([]);
    expect(importsOf(code!)).toEqual([]);
    expect(code!.includes("var QueryObserver = class")).toBe(true);
    expect(serverMarkersIn(code!)).toEqual([]);
  });

  it("its live layer (PR-W4) holds nothing of a server, the core client or the contract, the channel and SSE clients it loads lazily left out", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "..", "lib", "live.ts"),
      PEER,
      /^\.\/(?:channel|sse)$/,
    );
    expect(logs).toEqual([]);
    expect(code!.includes("function startLive")).toBe(true);
    expect(importsOf(code!)).toEqual([]);
    expect(serverMarkersIn(code!)).toEqual([]);
    expect(code!.includes("function createClient")).toBe(false);
    expect(contractMarkersIn(code!)).toEqual([]);
  });

  it("negative control: the entry beside bun-common is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "query-server-import.ts"),
      PEER,
    );
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});

describe("the ./react entry (plan §7.1, §10.1)", () => {
  const REACT = join(import.meta.dir, "..", "lib", "react.ts");
  const PEERS = ["@tanstack/react-query", "@tanstack/query-core", "react"];

  /** The specifiers `code` still imports. */
  const importsOf = (code: string): string[] =>
    [...code.matchAll(/^import[^"]*from\s*"([^"]+)"/gm)].map(
      (match) => match[1],
    );

  it("imports react-query and React (`useLive`'s effect) and nothing else, and holds nothing of a server, the query layer or the core client", async () => {
    const { code, logs } = await build(REACT, PEERS);
    expect(logs).toEqual([]);
    expect(code!.includes("function createApiHooks")).toBe(true);
    expect(importsOf(code!).sort()).toEqual(["@tanstack/react-query", "react"]);
    expect(serverMarkersIn(code!)).toEqual([]);
    expect(code!.includes("function createClient")).toBe(false);
    expect(code!.includes("function queries")).toBe(false);
    expect(contractMarkersIn(code!)).toEqual([]);
  });

  it("with react-query and query-core inlined, React left to the app (react and its JSX runtime), still holds nothing of a server", async () => {
    const { code, logs } = await build(REACT, ["react"]);
    expect(logs).toEqual([]);
    expect([...new Set(importsOf(code!))].sort()).toEqual([
      "react",
      "react/jsx-runtime",
    ]);
    expect(code!.includes("var QueryObserver = class")).toBe(true);
    expect(serverMarkersIn(code!)).toEqual([]);
  });

  it("negative control: the entry beside bun-common is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "react-server-import.ts"),
      PEERS,
    );
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});

describe("the ./persist entry (plan §6.4, §10.1)", () => {
  const PERSIST = join(import.meta.dir, "..", "lib", "persist.ts");

  it("imports nothing, and holds nothing of a server, the query layer or the core client", async () => {
    const { code, logs } = await build(PERSIST);
    expect(logs).toEqual([]);
    expect(code!.includes("function idbPersister")).toBe(true);
    expect(code!.match(/^\s*import\s/m)).toBeNull();
    expect(serverMarkersIn(code!)).toEqual([]);
    expect(code!.includes("function createClient")).toBe(false);
    expect(code!.includes("function queries")).toBe(false);
    expect(code!.includes("var QueryObserver = class")).toBe(false);
    expect(contractMarkersIn(code!)).toEqual([]);
  });

  it("negative control: the entry beside bun-common is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "persist-server-import.ts"),
    );
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});

describe("the ./sse entry (sse.md, plan §10.1)", () => {
  const SSE = join(import.meta.dir, "..", "lib", "sse.ts");

  it("imports nothing, and holds nothing of a server or the core client's pipeline", async () => {
    const { code, logs } = await build(SSE);
    expect(logs).toEqual([]);
    expect(code!.includes("function sse(")).toBe(true);
    expect(code!.match(/^\s*import\s/m)).toBeNull();
    expect(serverMarkersIn(code!)).toEqual([]);
    expect(code!.includes("function createClient")).toBe(false);
    expect(code!.includes("function serializeQuery")).toBe(false);
  });

  it("loads bun-contract's guards only lazily (a splitting build's eager code has none)", async () => {
    const { eager, lazy } = await splitBuild(SSE);
    expect(contractMarkersIn(eager)).toEqual([]);
    expect(contractMarkersIn(lazy.join("\n")).length).toBeGreaterThan(0);
  });

  it("negative control: the entry beside bun-common is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "sse-server-import.ts"),
    );
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});

describe("the ./channel entry (websocket.md, plan §10.1)", () => {
  const CHANNEL = join(import.meta.dir, "..", "lib", "channel.ts");

  it("imports nothing, and holds nothing of a server or the core client's pipeline", async () => {
    const { code, logs } = await build(CHANNEL);
    expect(logs).toEqual([]);
    expect(code!.includes("function channel(")).toBe(true);
    expect(code!.match(/^\s*import\s/m)).toBeNull();
    expect(serverMarkersIn(code!)).toEqual([]);
    expect(code!.includes("function createClient")).toBe(false);
    expect(code!.includes("function serializeQuery")).toBe(false);
    expect(code!.includes("function sse(")).toBe(false);
  });

  it("loads bun-contract's guards only lazily (a splitting build's eager code has none)", async () => {
    const { eager, lazy } = await splitBuild(CHANNEL);
    expect(contractMarkersIn(eager)).toEqual([]);
    expect(contractMarkersIn(lazy.join("\n")).length).toBeGreaterThan(0);
  });

  it("negative control: the entry beside bun-common is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "channel-server-import.ts"),
    );
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});

describe("the ./graphql entry (graphql.md, plan §10.1)", () => {
  const GRAPHQL = join(import.meta.dir, "..", "lib", "graphql.ts");

  it("imports nothing, and holds nothing of a server, the core client's pipeline or a GraphQL library", async () => {
    const { code, logs } = await build(GRAPHQL);
    expect(logs).toEqual([]);
    expect(code!.includes("function createGraphQLClient(")).toBe(true);
    expect(code!.match(/^\s*import\s/m)).toBeNull();
    expect(serverMarkersIn(code!)).toEqual([]);
    expect(code!.includes("function createClient")).toBe(false);
    expect(code!.includes("function serializeQuery")).toBe(false);
    expect(code!.includes("function buildPath")).toBe(false);
    expect(/\bgraphql-js\b|from ["']graphql["']/.test(code!)).toBe(false);
  });

  it("splits into no chunk: bun-contract's guards are never part of it", async () => {
    const { eager, lazy } = await splitBuild(GRAPHQL);
    expect(lazy).toEqual([]);
    expect(contractMarkersIn(eager)).toEqual([]);
  });

  it("negative control: the entry beside bun-common is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "graphql-server-import.ts"),
    );
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});

describe("the ./webrtc entry (webrtc.md, plan §10.1)", () => {
  const WEBRTC = join(import.meta.dir, "..", "lib", "webrtc.ts");

  it("imports nothing, and holds nothing of a server, the core client or the channel client", async () => {
    const { code, logs } = await build(WEBRTC);
    expect(logs).toEqual([]);
    expect(code!.includes("function connectPeer(")).toBe(true);
    expect(code!.includes("function typedDataChannel(")).toBe(true);
    expect(code!.match(/^\s*import\s/m)).toBeNull();
    expect(serverMarkersIn(code!)).toEqual([]);
    expect(code!.includes("function createClient")).toBe(false);
    expect(code!.includes("function channel(")).toBe(false);
  });

  it("loads bun-contract's guards only lazily (a splitting build's eager code has none)", async () => {
    const { eager, lazy } = await splitBuild(WEBRTC);
    expect(contractMarkersIn(eager)).toEqual([]);
    expect(contractMarkersIn(lazy.join("\n")).length).toBeGreaterThan(0);
  });

  it("negative control: the entry beside bun-common's relay is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "webrtc-server-import.ts"),
    );
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});
