/**
 * `--include` (which documents a generated client covers): `openapi` (the
 * routes), `asyncapi` (the WebSocket channels), or both, the default.
 *
 * - `parseInclude`: the comma list and a targets file's array, in one
 *   order; what it refuses;
 * - `generateRoutes(undefined, { asyncapi })`: a channels-only module, its
 *   hash over the AsyncAPI document alone;
 * - `generate --include` from a module with routes and channels: each kind
 *   alone, and both equal to the default (the control); `--zod` follows it;
 *   `--check` is fresh;
 * - file sources: `--asyncapi` alone under `--include asyncapi`, the same
 *   module as from the router; the usage errors;
 * - a source lacking a document asked for exits 2, naming it;
 * - the targets file's `include` and its `"asyncapi"`-alone source.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentsHash,
  generateRoutes,
  loadDocuments,
  parseClientConfig,
  runCli,
} from "../../lib/codegen/index";
import { parseInclude } from "../../lib/codegen/emit";

const CHANNELS = join(import.meta.dir, "fixtures", "channels.ts");

let dir: string;
let openapi: object;
let asyncapi: object;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-client-include-"));
  const loaded = await loadDocuments({ module: CHANNELS });
  openapi = loaded.openapi;
  asyncapi = loaded.asyncapi!;
  await writeFile(join(dir, "openapi.json"), JSON.stringify(openapi));
  await writeFile(join(dir, "asyncapi.json"), JSON.stringify(asyncapi));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Runs the command in `dir`: its status and output. */
async function run(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: dir,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
}

/** A file in `dir`. */
const read = (name: string) => readFile(join(dir, name), "utf8");

describe("parseInclude", () => {
  it.each([
    ["openapi", ["openapi"]],
    ["asyncapi", ["asyncapi"]],
    ["asyncapi,openapi", ["openapi", "asyncapi"]],
    [" openapi , asyncapi ", ["openapi", "asyncapi"]],
    [["asyncapi"], ["asyncapi"]],
  ] as const)("reads %j", (value, kinds) => {
    expect(parseInclude(value, "--include")).toEqual(kinds);
  });

  it.each([
    ["", "--include names no document"],
    [[], "--include names no document"],
    ["routes", '--include: "routes" is not a document kind'],
    ["openapi,openapi", '--include: "openapi" is given twice'],
    [[1], "--include: 1 is not a document kind"],
  ] as const)("refuses %j", (value, message) => {
    expect(parseInclude(value, "--include")).toContain(message);
  });
});

describe("generateRoutes without an OpenAPI document", () => {
  it("writes the channels with an empty route map, hashed over the AsyncAPI document alone (control: with it, the routes and both in the hash)", () => {
    const only = generateRoutes(undefined, { asyncapi });
    expect(only.routes).toBe(0);
    expect(only.channels).toBe(2);
    expect(only.hash).toBe(documentsHash({ asyncapi }));
    expect(only.code).toContain("export interface Routes {}");
    expect(only.code).toContain("export const manifest = {} as const");
    expect(only.code).toContain("export interface Channels {");
    expect(only.code).toContain("from an\n * AsyncAPI document alone");
    const both = generateRoutes(openapi, { asyncapi });
    expect(both.routes).toBe(1);
    expect(both.hash).toBe(documentsHash({ openapi, asyncapi }));
  });

  it("refuses neither document", () => {
    expect(() => generateRoutes(undefined)).toThrow(
      "expected an OpenAPI document, an AsyncAPI one (options.asyncapi), or both",
    );
  });
});

describe("generate --include", () => {
  it("keeps the routes, the channels, or both; both is the default's bytes; --zod follows it; --check is fresh", async () => {
    const all = await run("generate", "--module", CHANNELS);
    const both = await run(
      "generate",
      "--module",
      CHANNELS,
      "--include",
      "asyncapi,openapi",
    );
    expect(both.code).toBe(0);
    expect(both.stdout).toBe(all.stdout);

    const http = await run(
      "generate",
      "--module",
      CHANNELS,
      "--include",
      "openapi",
      "--out",
      "http.gen.ts",
      "--zod",
      "http.zod.gen.ts",
    );
    expect(http.code).toBe(0);
    const httpCode = await read("http.gen.ts");
    expect(httpCode).toContain('"GET /health"');
    expect(httpCode).not.toContain("Channels");
    expect(httpCode).toContain(`typesHash: ${documentsHash({ openapi })}`);
    expect(await read("http.zod.gen.ts")).not.toContain("channelSchemas");

    const ws = await run(
      "generate",
      "--module",
      CHANNELS,
      "--include",
      "asyncapi",
      "--out",
      "ws.gen.ts",
      "--zod",
      "ws.zod.gen.ts",
    );
    expect(ws.code).toBe(0);
    const wsCode = await read("ws.gen.ts");
    expect(wsCode).toContain("export interface Channels {");
    expect(wsCode).not.toContain("/health");
    expect(wsCode).toContain(`typesHash: ${documentsHash({ asyncapi })}`);
    const wsZod = await read("ws.zod.gen.ts");
    expect(wsZod).toContain("channelSchemas");
    expect(wsZod).not.toContain("/health");

    const fresh = await run(
      "generate",
      "--module",
      CHANNELS,
      "--include",
      "asyncapi",
      "--out",
      "ws.gen.ts",
      "--zod",
      "ws.zod.gen.ts",
      "--check",
    );
    expect(fresh.code).toBe(0);
    // Control: the other kind's file is stale against this one's documents.
    const stale = await run(
      "generate",
      "--module",
      CHANNELS,
      "--include",
      "openapi",
      "--out",
      "ws.gen.ts",
      "--check",
    );
    expect(stale.code).toBe(1);
  });

  it("reads an --asyncapi file alone under --include asyncapi: the module the router gives", async () => {
    const fromFile = await run(
      "generate",
      "--asyncapi",
      "asyncapi.json",
      "--include",
      "asyncapi",
    );
    expect(fromFile.stderr).toBe("");
    expect(fromFile.code).toBe(0);
    const fromModule = await run(
      "generate",
      "--module",
      CHANNELS,
      "--include",
      "asyncapi",
    );
    expect(fromFile.stdout).toBe(fromModule.stdout);
  });

  it.each([
    [
      ["--asyncapi", "asyncapi.json"],
      "--asyncapi alone needs --include asyncapi",
    ],
    [
      ["--openapi", "openapi.json", "--include", "asyncapi"],
      "--include asyncapi leaves --openapi unused; leave it out (give --asyncapi alone)",
    ],
    [
      [
        "--openapi",
        "openapi.json",
        "--asyncapi",
        "asyncapi.json",
        "--include",
        "openapi",
      ],
      "--include openapi leaves --asyncapi unused",
    ],
    [
      ["--openapi", "openapi.json", "--include", "openapi,asyncapi"],
      "--include openapi,asyncapi needs --asyncapi beside --openapi",
    ],
    [
      ["--url", "http://127.0.0.1:9/x", "--asyncapi", "asyncapi.json"],
      "--asyncapi goes with --openapi, or alone",
    ],
    [["--module", CHANNELS, "--include", "ws"], '"ws" is not a document kind'],
    [["--module", CHANNELS, "--include", ""], "--include names no document"],
    [
      ["--config", "c.json", "--include", "openapi"],
      "it does not go with --include",
    ],
  ])("refuses %j", async (args, message) => {
    const result = await run("generate", ...args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it("exits 2 naming a document the source lacks (control: the one it has is generated)", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json(openapi),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/openapi.json`;
      const missing = await run(
        "generate",
        "--url",
        url,
        "--include",
        "asyncapi",
      );
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain(
        "the source has no AsyncAPI document (--include asyncapi)",
      );
      const present = await run(
        "generate",
        "--url",
        url,
        "--include",
        "openapi",
      );
      expect(present.code).toBe(0);
      expect(present.stdout).toContain('"GET /health"');
    } finally {
      await server.stop(true);
    }
  });
});

describe("the targets file's include", () => {
  it("reads each target's include, and an asyncapi file alone as a source", () => {
    const config = parseClientConfig(
      JSON.stringify({
        asyncapi: "asyncapi.json",
        targets: [{ out: "ws.gen.ts", include: ["asyncapi"] }],
      }),
      "/r/c.json",
    );
    if (typeof config === "string") throw new Error(config);
    expect(config.source).toEqual({ asyncapiFile: "/r/asyncapi.json" });
    expect(config.targets[0].include).toEqual(["asyncapi"]);
  });

  it.each([
    [
      { asyncapi: "a.json", targets: [{ out: "a.ts" }] },
      'targets[0] needs "include": ["asyncapi"]',
    ],
    [
      { url: "http://x/", asyncapi: "a.json", targets: [{ out: "a.ts" }] },
      '"asyncapi" goes with "openapi", or alone: not with "url"',
    ],
    [
      { openapi: "o.json", targets: [{ out: "a.ts", include: ["asyncapi"] }] },
      'targets[0].include names "asyncapi", but the source has no "asyncapi" file',
    ],
    [
      { targets: [{ out: "a.ts", include: "asyncapi" }] },
      "targets[0].include must be an array",
    ],
    [
      { targets: [{ out: "a.ts", include: ["ws"] }] },
      'targets[0].include: "ws" is not a document kind',
    ],
    [
      { asyncapi: "a.json", targets: [{ document: "c", out: "a.ts" }] },
      'targets[0].document needs a "url" or "module" source',
    ],
  ])("refuses %j", (file, message) => {
    const result = parseClientConfig(JSON.stringify(file), "/r/c.json");
    expect(typeof result).toBe("string");
    expect(result as string).toContain(message);
  });

  it("generates each target with its own include from one module", async () => {
    await writeFile(
      join(dir, "include.json"),
      JSON.stringify({
        module: CHANNELS,
        targets: [
          { out: "cfg/all.gen.ts" },
          { out: "cfg/http.gen.ts", include: ["openapi"] },
          { out: "cfg/ws.gen.ts", include: ["asyncapi"] },
        ],
      }),
    );
    const result = await run("generate", "--config", "include.json");
    // The fixture's OpenAPI warnings, once per target that has the routes:
    // the channels-only target reports none.
    expect(result.stderr.match(/4 warnings/g)).toHaveLength(2);
    expect(result.code).toBe(0);
    const all = await read("cfg/all.gen.ts");
    expect(all).toContain('"GET /health"');
    expect(all).toContain("export interface Channels {");
    expect(await read("cfg/http.gen.ts")).not.toContain("Channels");
    expect(await read("cfg/ws.gen.ts")).not.toContain("/health");
  });
});
