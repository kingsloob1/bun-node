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
): Promise<{ code?: string; logs: string[] }> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: false,
    throw: false,
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
    expect(lazy.length).toBe(1);
    expect(contractMarkersIn(lazy[0])).toEqual([...CONTRACT_MARKERS]);
    expect(serverMarkersIn(lazy[0])).toEqual([]);
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
