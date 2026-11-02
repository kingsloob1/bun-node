/**
 * The `bun-client` command (typed-client plan §3.2, §16): the three sources
 * (a URL, files, a module), `--out`, `--check` (fresh, stale, missing) and
 * its exit statuses, determinism across runs, and the usage errors. Most
 * cases run `runCli` in process; the bin itself is spawned for the exit
 * statuses a CI job reads.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  documentsHash,
  generateRoutes,
  loadDocuments,
  runCli,
} from "../../lib/codegen/index";

const FIXTURES = join(import.meta.dir, "fixtures");
const BIN = join(import.meta.dir, "..", "..", "lib", "codegen", "cli.ts");
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-client-cli-"));
  await cp(join(FIXTURES, "corpus.openapi.json"), join(dir, "openapi.json"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Runs the command in process: its status and what it wrote. */
async function run(
  ...argv: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: dir,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  return { code, stdout, stderr };
}

/** Spawns the bin: its exit status and output. */
function spawn(...argv: string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync([process.execPath, BIN, ...argv], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("--openapi files", () => {
  it("writes the module, then reports it unchanged", async () => {
    const first = await run(
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "out/api.gen.ts",
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(
      /wrote out\/api\.gen\.ts \(typesHash [0-9a-f]{16}\)/,
    );
    expect(first.stderr).toContain("9 warnings (also in the file's header)");
    const written = await readFile(join(dir, "out/api.gen.ts"), "utf8");
    expect(written).toBe(
      await Bun.file(join(FIXTURES, "corpus.gen.ts")).text(),
    );

    const second = await run(
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "out/api.gen.ts",
    );
    expect(second.stdout).toContain("out/api.gen.ts unchanged");
  });

  it("prints to stdout without --out", async () => {
    const { code, stdout } = await run("generate", "--openapi", "openapi.json");
    expect(code).toBe(0);
    expect(stdout).toBe(await Bun.file(join(FIXTURES, "corpus.gen.ts")).text());
  });

  it("reads YAML, and an AsyncAPI document into the hash", async () => {
    await cp(join(FIXTURES, "thirdParty.openapi.yaml"), join(dir, "pets.yaml"));
    const asyncapi = { asyncapi: "3.0.0", info: { title: "x", version: "1" } };
    await writeFile(join(dir, "asyncapi.json"), JSON.stringify(asyncapi));
    const plain = await run("generate", "--openapi", "pets.yaml");
    const both = await run(
      "generate",
      "--openapi",
      "pets.yaml",
      "--asyncapi",
      "asyncapi.json",
    );
    expect(plain.stdout).toBe(
      await Bun.file(join(FIXTURES, "thirdParty.gen.ts")).text(),
    );
    const openapi = Bun.YAML.parse(
      await Bun.file(join(dir, "pets.yaml")).text(),
    ) as object;
    expect(both.stdout).toContain(
      `typesHash: ${documentsHash({ openapi, asyncapi })}`,
    );
  });

  it("is deterministic: two runs write the same bytes", async () => {
    await run("generate", "--openapi", "openapi.json", "--out", "a.gen.ts");
    spawn("generate", "--openapi", "openapi.json", "--out", "b.gen.ts");
    expect(await readFile(join(dir, "a.gen.ts"), "utf8")).toBe(
      await readFile(join(dir, "b.gen.ts"), "utf8"),
    );
  });
});

describe("--check", () => {
  it("exits 0 when the file is fresh, and writes nothing", async () => {
    await run("generate", "--openapi", "openapi.json", "--out", "fresh.gen.ts");
    const { code, stdout } = spawn(
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "fresh.gen.ts",
      "--check",
    );
    expect(code).toBe(0);
    expect(stdout).toContain("fresh.gen.ts is up to date");
  });

  it("exits 1 when the documents changed, naming both hashes, and leaves the file alone", async () => {
    await run("generate", "--openapi", "openapi.json", "--out", "stale.gen.ts");
    const before = await readFile(join(dir, "stale.gen.ts"), "utf8");
    const document = JSON.parse(
      await readFile(join(dir, "openapi.json"), "utf8"),
    ) as {
      components: {
        schemas: { Named: { properties: Record<string, unknown> } };
      };
    };
    document.components.schemas.Named.properties.nickname = { type: "string" };
    await writeFile(join(dir, "changed.json"), JSON.stringify(document));
    const { code, stderr } = spawn(
      "generate",
      "--openapi",
      "changed.json",
      "--out",
      "stale.gen.ts",
      "--check",
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(
      /stale\.gen\.ts is stale \(it records typesHash [0-9a-f]{16}, the documents hash [0-9a-f]{16}\)/,
    );
    expect(await readFile(join(dir, "stale.gen.ts"), "utf8")).toBe(before);
  });

  it("exits 1 when the file was edited by hand, though the hash still matches", async () => {
    await run(
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "edited.gen.ts",
    );
    const text = await readFile(join(dir, "edited.gen.ts"), "utf8");
    await writeFile(
      join(dir, "edited.gen.ts"),
      text.replace("name: string;", "name: number;"),
    );
    const { code, stderr } = await run(
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "edited.gen.ts",
      "--check",
    );
    expect(code).toBe(1);
    expect(stderr).toContain("with different content");
  });

  it("exits 1 when the file does not exist", async () => {
    const { code, stderr } = await run(
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "missing.gen.ts",
      "--check",
    );
    expect(code).toBe(1);
    expect(stderr).toContain("missing.gen.ts does not exist");
  });

  it("keeps the committed fixture app golden fresh (the CI form)", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        BIN,
        "generate",
        "--module",
        "__tests__/codegen/fixtures/app.ts",
        "--out",
        "__tests__/codegen/fixtures/app.gen.ts",
        "--check",
      ],
      {
        cwd: join(import.meta.dir, "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual(
      {
        code: 0,
        stderr: expect.not.stringContaining("stale") as string,
      },
    );
  });
});

describe("--zod (PR-C4)", () => {
  it("writes the zod module beside the map, importing it relatively (the corpus golden, both flavours)", async () => {
    for (const flavour of ["mini", "classic"]) {
      const result = await run(
        "generate",
        "--openapi",
        "openapi.json",
        "--out",
        "zod/corpus.gen.ts",
        "--zod",
        `zod/corpus.zod-${flavour}.gen.ts`,
        "--zod-flavour",
        flavour,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`wrote zod/corpus.zod-${flavour}.gen.ts`);
      expect(result.stderr).toContain("bun-client generate --zod: 5 warnings");
      expect(
        await readFile(join(dir, `zod/corpus.zod-${flavour}.gen.ts`), "utf8"),
      ).toBe(
        await Bun.file(join(FIXTURES, `corpus.zod-${flavour}.gen.ts`)).text(),
      );
    }
    // mini is the default.
    const plain = await run(
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "zod/corpus.gen.ts",
      "--zod",
      "zod/default.gen.ts",
    );
    expect(plain.code).toBe(0);
    expect(await readFile(join(dir, "zod/default.gen.ts"), "utf8")).toBe(
      await Bun.file(join(FIXTURES, "corpus.zod-mini.gen.ts")).text(),
    );
    // A zod module in another directory imports the map relatively.
    await run(
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "zod/corpus.gen.ts",
      "--zod",
      "zod/schemas/api.ts",
    );
    expect(await readFile(join(dir, "zod/schemas/api.ts"), "utf8")).toContain(
      'import type { Routes } from "../corpus.gen";',
    );
  });

  it("--check covers the zod module: fresh exits 0, a stale or missing one exits 1 (control: the map alone is fresh)", async () => {
    const args = [
      "generate",
      "--openapi",
      "openapi.json",
      "--out",
      "zodcheck/api.gen.ts",
      "--zod",
      "zodcheck/api.zod.gen.ts",
    ];
    expect((await run(...args)).code).toBe(0);
    expect((await run(...args, "--check")).code).toBe(0);
    await writeFile(join(dir, "zodcheck/api.zod.gen.ts"), "// stale\n");
    const stale = await run(...args, "--check");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain("zodcheck/api.gen.ts is up to date");
    expect(stale.stderr).toContain("zodcheck/api.zod.gen.ts is stale");
    await rm(join(dir, "zodcheck/api.zod.gen.ts"));
    expect((await run(...args, "--check")).stderr).toContain(
      "zodcheck/api.zod.gen.ts does not exist",
    );
    // Control: without --zod, the map alone is checked, and is fresh.
    expect((await run(...args.slice(0, 5), "--check")).code).toBe(0);
  });
});

describe("--url", () => {
  /** A server answering `/doc` with the corpus, `/types` with the dev endpoint's shape, `/yaml` with YAML. */
  const documents = async () => {
    const openapi = JSON.parse(
      await readFile(join(dir, "openapi.json"), "utf8"),
    ) as object;
    const asyncapi = { asyncapi: "3.0.0", info: { title: "x", version: "1" } };
    return { openapi, asyncapi };
  };

  it("reads a document, the dev endpoint's { hash, openapi, asyncapi }, or YAML", async () => {
    const { openapi, asyncapi } = await documents();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/doc") return Response.json(openapi);
        if (pathname === "/types")
          return Response.json({
            hash: documentsHash({ openapi, asyncapi }),
            openapi,
            asyncapi,
          });
        if (pathname === "/yaml")
          return new Response(Bun.YAML.stringify(openapi), {
            headers: { "content-type": "application/yaml" },
          });
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const plain = await run("generate", "--url", `${base}/doc`);
      expect(plain.stdout).toBe(
        await Bun.file(join(FIXTURES, "corpus.gen.ts")).text(),
      );
      const dev = await run("generate", "--url", `${base}/types`);
      expect(dev.stdout).toContain(
        `typesHash: ${documentsHash({ openapi, asyncapi })}`,
      );
      const yaml = await run("generate", "--url", `${base}/yaml`);
      expect(yaml.stdout).toBe(plain.stdout);
      const missing = await run("generate", "--url", `${base}/missing`);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("answered 404");
    } finally {
      await server.stop(true);
    }
  });

  it("exits 2 when nothing answers", async () => {
    const { code, stderr } = await run(
      "generate",
      "--url",
      "http://127.0.0.1:9/types",
    );
    expect(code).toBe(2);
    expect(stderr).toContain("--url http://127.0.0.1:9/types");
  });
});

describe("--url against bun-common's devTypes() (PR-M2)", () => {
  it("generates the same module as --module, with the endpoint's hash; without the token it is refused", async () => {
    const { devTypes } = await import("@kingsleyweb/bun-common/lib/docs");
    const { buildRouter } = await import("./fixtures/app");
    const app = buildRouter();
    const info = { title: "API", version: "1" };
    const dev = devTypes(app, {
      enabled: true,
      openapi: info,
      asyncapi: info,
      tokenFile: false,
    });
    app.use(dev);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => app.fetch(request),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/__bun/types`;
      const served = (await (
        await fetch(url, {
          headers: { authorization: `Bearer ${String(dev.token)}` },
        })
      ).json()) as { hash: string };
      const loaded = await loadDocuments({
        url,
        headers: { authorization: `Bearer ${String(dev.token)}` },
      });
      const result = generateRoutes(
        loaded.openapi,
        loaded.asyncapi === undefined ? {} : { asyncapi: loaded.asyncapi },
      );
      expect(result.hash).toBe(served.hash);
      // The documents are the module's: only the header's hash and the
      // producer's warnings (which only --module sees) differ.
      const golden = await Bun.file(join(FIXTURES, "app.gen.ts")).text();
      const body = (code: string) => code.slice(code.indexOf("import type"));
      expect(body(result.code)).toBe(body(golden));
      // No token file names the server (`tokenFile: false`), so the CLI
      // sends no token: refused, as the endpoint refuses anything
      // unauthorized (its not-found answer). `devServer.test.ts` covers the
      // token file being read.
      const refused = await run("generate", "--url", url);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("answered 404");
    } finally {
      await server.stop(true);
      dev.close();
    }
  });
});

describe("--module", () => {
  it("documents a router export in process", async () => {
    const { code, stdout } = await run(
      "generate",
      "--module",
      join(FIXTURES, "app.ts"),
      "--export",
      "buildRouter",
    );
    expect(code).toBe(0);
    expect(stdout).toBe(await Bun.file(join(FIXTURES, "app.gen.ts")).text());
  });

  it("reads a module exporting a document", async () => {
    await writeFile(
      join(dir, "doc.ts"),
      `export const doc = ${await readFile(join(dir, "openapi.json"), "utf8")};\n`,
    );
    const { stdout } = await run(
      "generate",
      "--module",
      "doc.ts",
      "--export",
      "doc",
    );
    expect(stdout).toBe(await Bun.file(join(FIXTURES, "corpus.gen.ts")).text());
  });

  it("names the exports when the one asked for is missing, or is not a router or document", async () => {
    await writeFile(
      join(dir, "nothing.ts"),
      "export const a = 1;\nexport const b = { c: 2 };\n",
    );
    const missing = await run("generate", "--module", "nothing.ts");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain(
      'no export "default" (it exports "a", "b"; pick one with --export)',
    );
    const wrong = await run(
      "generate",
      "--module",
      "nothing.ts",
      "--export",
      "b",
    );
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain(
      'export "b" is not a router, an OpenAPI document',
    );
  });
});

describe("usage", () => {
  it.each([
    [[], 2, "Usage:"],
    [["generate"], 2, "give exactly one of --url, --openapi or --module"],
    [
      ["generate", "--openapi", "a", "--module", "b"],
      2,
      "(got --openapi, --module)",
    ],
    [
      ["generate", "--openapi", "openapi.json", "--check"],
      2,
      "--check needs --out",
    ],
    [
      ["generate", "--module", "m.ts", "--asyncapi", "a.json"],
      2,
      "--asyncapi goes with --openapi",
    ],
    [
      ["generate", "--openapi", "a.json", "--export", "x"],
      2,
      "--export goes with --module",
    ],
    [
      ["generate", "--openapi", "openapi.json", "--zod", "z.ts"],
      2,
      "--zod needs --out",
    ],
    [
      ["generate", "--openapi", "openapi.json", "--zod-flavour", "mini"],
      2,
      "--zod-flavour goes with --zod",
    ],
    [
      [
        "generate",
        "--openapi",
        "openapi.json",
        "--out",
        "a.ts",
        "--zod",
        "z.ts",
        "--zod-flavour",
        "max",
      ],
      2,
      '--zod-flavour is "mini" or "classic", not "max"',
    ],
    [
      [
        "generate",
        "--openapi",
        "openapi.json",
        "--out",
        "a.ts",
        "--zod",
        "a.ts",
      ],
      2,
      "--zod names the same file as --out",
    ],
    [["generate", "--bogus"], 2, "Unknown option"],
    [["watch"], 2, "--out is required"],
    [["watch", "--out", "a.ts", "--url", "not a url"], 2, "is not a URL"],
    [
      ["watch", "--out", "a.ts", "--zod", "z.ts", "--zod-flavour", "x"],
      2,
      '--zod-flavour is "mini" or "classic", not "x"',
    ],
    [["watch", "--out", "a.ts", "--zod", "a.ts"], 2, "the same file as --out"],
    [["watch", "--out", "a.ts", "--check"], 2, "Unknown option"],
    [
      ["generate", "--openapi", "openapi.json", "--token-file", "t.json"],
      2,
      "--token-file goes with --url",
    ],
    [["frobnicate"], 2, 'unknown command "frobnicate"'],
    [["generate", "--openapi", "absent.json"], 2, "absent.json"],
  ])("%j exits %d", async (argv, status, message) => {
    const { code, stdout, stderr } = await run(...argv);
    expect(code).toBe(status);
    expect(`${stdout}${stderr}`).toContain(message);
  });

  it("prints help and exits 0 for --help", async () => {
    expect((await run("--help")).code).toBe(0);
    expect((await run("generate", "--help")).stdout).toContain("--check");
    const watchHelp = await run("watch", "--help");
    expect(watchHelp.code).toBe(0);
    expect(watchHelp.stdout).toContain("--token-file");
  });

  it("is executable as the package's bin (its shebang and mode)", () => {
    const result = Bun.spawnSync([BIN, "--help"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("bun-client generate <source>");
  });
});
