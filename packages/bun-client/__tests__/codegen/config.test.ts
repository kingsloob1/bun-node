/**
 * The targets file (`--config`, issue #768): one file naming every typed
 * client an app generates, so one `generate` writes or `--check`s them all
 * and one `watch` keeps them all live.
 *
 * - `parseClientConfig`: a `module` target's export is its `document`; paths
 *   resolve from the file's directory; every malformed file is refused with
 *   what is wrong (control: the well-formed one is read);
 * - `generate --config` from a module (the CI form: no server) and from a dev
 *   server's named documents: each file filtered; `--check` fresh, then one
 *   stale target named while the other stays fresh; a failing target does not
 *   stop the rest;
 * - `watch --config` keeps every target live, following the file's `url`;
 * - `--config` does not mix with the flags it replaces.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClientConfig, runCli } from "../../lib/codegen/index";
import { startDevServer } from "./fixtures/devServer";

const SURFACES = join(import.meta.dir, "fixtures", "surfaces.ts");

let dir: string;
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bun-client-config-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** Runs the command in `dir`, collecting its output. */
async function run(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    cwd: dir,
    stdout: (text) => void stdout.push(text),
    stderr: (text) => void stderr.push(text),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

/** Writes `config` as `<dir>/bun-client.json`. */
async function writeConfig(config: unknown, name = "bun-client.json") {
  await writeFile(join(dir, name), JSON.stringify(config, null, 2));
  return name;
}

/** A file's text, or `""` before it exists. */
async function text(path: string): Promise<string> {
  try {
    return await readFile(join(dir, path), "utf8");
  } catch {
    return "";
  }
}

/** The two-surface targets every test below uses. */
const TARGETS = [
  { document: "customer", out: "ui/customer.gen.ts" },
  {
    document: "backoffice",
    out: "ui/backoffice.gen.ts",
    zod: "ui/backoffice.zod.gen.ts",
  },
];

describe("parseClientConfig", () => {
  it("reads a module source, mapping each target's document to its export, paths from the file's directory (control: an explicit export wins)", () => {
    const config = parseClientConfig(
      JSON.stringify({
        module: "server/openapi.ts",
        tokenFile: "cache",
        targets: [
          ...TARGETS,
          { out: "all.gen.ts" },
          { document: "admin", export: "adminDoc", out: "admin.gen.ts" },
        ],
      }),
      "/repo/config/bun-client.json",
    );
    if (typeof config === "string") throw new Error(config);
    expect(config.dir).toBe("/repo/config");
    expect(config.source).toEqual({
      module: "/repo/config/server/openapi.ts",
      export: undefined,
    });
    expect(config.tokenFile).toBe("/repo/config/cache");
    expect(
      config.targets.map((target) => [
        target.document,
        target.export,
        target.out,
        target.display,
        target.zod?.path,
      ]),
    ).toEqual([
      [
        "customer",
        "customer",
        "/repo/config/ui/customer.gen.ts",
        "ui/customer.gen.ts",
        undefined,
      ],
      [
        "backoffice",
        "backoffice",
        "/repo/config/ui/backoffice.gen.ts",
        "ui/backoffice.gen.ts",
        "/repo/config/ui/backoffice.zod.gen.ts",
      ],
      [
        undefined,
        "default",
        "/repo/config/all.gen.ts",
        "all.gen.ts",
        undefined,
      ],
      [
        "admin",
        "adminDoc",
        "/repo/config/admin.gen.ts",
        "admin.gen.ts",
        undefined,
      ],
    ]);
  });

  it("reads a url source and an openapi one, and none at all (watch needs no source)", () => {
    const url = parseClientConfig(
      JSON.stringify({
        url: "http://127.0.0.1:3000/__bun/types",
        targets: TARGETS,
      }),
      "/r/c.json",
    );
    expect(typeof url !== "string" && url.source).toEqual({
      url: "http://127.0.0.1:3000/__bun/types",
    });
    const files = parseClientConfig(
      JSON.stringify({
        openapi: "openapi.json",
        asyncapi: "asyncapi.json",
        targets: [{ out: "api.gen.ts" }],
      }),
      "/r/c.json",
    );
    expect(typeof files !== "string" && files.source).toEqual({
      openapi: "/r/openapi.json",
      asyncapi: "/r/asyncapi.json",
    });
    const none = parseClientConfig(
      JSON.stringify({ targets: TARGETS }),
      "/r/c.json",
    );
    expect(typeof none !== "string" && none.source).toBeUndefined();
  });

  it.each([
    ["not json", "not JSON"],
    ["[]", "must hold a JSON object"],
    [{ targets: TARGETS, oput: "x" }, 'unknown key "oput"'],
    [{ targets: [] }, '"targets" must be a non-empty array'],
    [{ targets: [{ document: "c" }] }, 'targets[0] needs "out"'],
    [
      { targets: [{ out: "a.ts", outt: "b" }] },
      'targets[0]: unknown key "outt"',
    ],
    [
      { url: "http://x/", module: "m.ts", targets: TARGETS },
      'give at most one of "url", "module" and "openapi"',
    ],
    [
      { asyncapi: "a.json", targets: TARGETS },
      '"asyncapi" goes with "openapi"',
    ],
    [{ export: "x", targets: TARGETS }, '"export" goes with "module"'],
    [{ url: "not a url", targets: TARGETS }, '"url" not a url is not a URL'],
    [
      { openapi: "o.json", targets: TARGETS },
      'targets[0].document needs a "url" or "module" source',
    ],
    [
      { url: "http://x/", targets: [{ out: "a.ts", export: "x" }] },
      'targets[0].export goes with a "module" source',
    ],
    [
      { targets: [{ document: "a.b", out: "a.ts" }] },
      'targets[0].document "a.b" is not a document name',
    ],
    [
      {
        targets: [
          { document: "c", out: "a.ts" },
          { document: "c", out: "b.ts" },
        ],
      },
      'targets[1].document "c" is named by two targets',
    ],
    [
      { targets: [{ out: "a.ts" }, { document: "c", out: "./a.ts" }] },
      "targets[1]: ./a.ts is written by two targets",
    ],
    [
      {
        targets: [
          { out: "a.ts", zod: "z.ts" },
          { document: "c", out: "z.ts" },
        ],
      },
      "targets[1]: z.ts is written by two targets",
    ],
    [
      { targets: [{ out: "a.ts", zodFlavour: "mini" }] },
      'targets[0].zodFlavour goes with "zod"',
    ],
    [
      { targets: [{ out: "a.ts", zod: "z.ts", zodFlavour: "max" }] },
      'targets[0].zodFlavour is "mini" or "classic", not "max"',
    ],
    [{ targets: [{ out: "" }] }, "targets[0].out must be a non-empty string"],
  ])("refuses %j: %s", (file, message) => {
    const result = parseClientConfig(
      typeof file === "string" ? file : JSON.stringify(file),
      "/r/c.json",
    );
    expect(typeof result).toBe("string");
    expect(result as string).toContain(message);
  });
});

describe("generate --config", () => {
  it("writes every target from a module's exports, each filtered; --check is fresh, then names the one target edited (control: the other stays fresh)", async () => {
    const config = await writeConfig({ module: SURFACES, targets: TARGETS });
    const wrote = await run("generate", "--config", config);
    expect(wrote.stderr).toBe("");
    expect(wrote.code).toBe(0);
    const customer = await text("ui/customer.gen.ts");
    const backoffice = await text("ui/backoffice.gen.ts");
    expect(customer).toContain('"GET /api/orders"');
    expect(customer).toContain('"GET /health"');
    expect(customer).not.toContain("/api/admin");
    expect(backoffice).toContain('"GET /api/admin/users"');
    expect(backoffice).not.toContain("/api/orders");
    expect(await text("ui/backoffice.zod.gen.ts")).toContain(
      'from "./backoffice.gen"',
    );
    // The same as generating each alone with --module --export.
    const alone = await run(
      "generate",
      "--module",
      SURFACES,
      "--export",
      "customer",
    );
    expect(alone.stdout).toBe(customer);

    const fresh = await run("generate", "--config", config, "--check");
    expect(fresh.code).toBe(0);
    expect(fresh.stdout.match(/is up to date/g)).toHaveLength(3);

    await writeFile(
      join(dir, "ui/customer.gen.ts"),
      customer.replace("/api/orders", "/api/order"),
    );
    const stale = await run("generate", "--config", config, "--check");
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("ui/customer.gen.ts is stale");
    expect(stale.stdout).toContain("ui/backoffice.gen.ts is up to date");
  });

  it("keeps going past a target that fails, and exits 2 (control: the other is written)", async () => {
    const config = await writeConfig({
      module: SURFACES,
      targets: [
        { document: "nope", out: "nope.gen.ts" },
        { document: "customer", out: "customer.gen.ts" },
      ],
    });
    const result = await run("generate", "--config", config);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("nope");
    expect(await text("customer.gen.ts")).toContain('"GET /api/orders"');
  });

  it("generates a dev server's named documents, with the token from its token file", async () => {
    const server = await startDevServer({
      dir,
      routes: ["/api/orders", "/api/admin/users"],
      documents: {
        customer: {
          openapi: {
            filter: (route) => !route.path.startsWith("/api/admin"),
          },
        },
        backoffice: {
          openapi: {
            filter: (route) => route.path.startsWith("/api/admin"),
          },
        },
      },
    });
    cleanups.push(server.close);
    const config = await writeConfig({ url: server.url, targets: TARGETS });
    const result = await run("generate", "--config", config);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await text("ui/customer.gen.ts")).toContain('"GET /api/orders"');
    expect(await text("ui/customer.gen.ts")).not.toContain("/api/admin");
    expect(await text("ui/backoffice.gen.ts")).toContain(
      '"GET /api/admin/users"',
    );
  });

  it.each([
    [["--config", "c.json", "--out", "a.ts"], "it does not go with --out"],
    [
      ["--config", "c.json", "--module", "m.ts", "--zod", "z.ts"],
      "it does not go with --module, --zod",
    ],
    [["--config", "missing.json"], "--config missing.json: cannot read it"],
  ])("refuses %j", async (args, message) => {
    const result = await run("generate", ...args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it("refuses a file that names no source", async () => {
    const config = await writeConfig({ targets: TARGETS });
    const result = await run("generate", "--config", config);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      'names no source: give it "url", "module" or "openapi"',
    );
  });
});

describe("watch --config", () => {
  it("keeps every target live, following the file's url (control: a --document flag beside it is refused)", async () => {
    const server = await startDevServer({
      dir,
      routes: ["/api/orders", "/api/admin/users"],
      documents: {
        customer: {
          openapi: {
            filter: (route) => !route.path.startsWith("/api/admin"),
          },
        },
        backoffice: {
          openapi: {
            filter: (route) => route.path.startsWith("/api/admin"),
          },
        },
      },
    });
    cleanups.push(server.close);
    const config = await writeConfig({ url: server.url, targets: TARGETS });

    const refused = await run(
      "watch",
      "--config",
      config,
      "--document",
      "customer",
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("it does not go with --document");

    const controller = new AbortController();
    const stderr: string[] = [];
    const done = runCli(["watch", "--config", config], {
      cwd: dir,
      signal: controller.signal,
      stdout: () => {},
      stderr: (line) => void stderr.push(line),
    });
    cleanups.push(async () => {
      controller.abort();
      await done;
    });
    const deadline = Date.now() + 30_000;
    while (
      !(await text("ui/customer.gen.ts")).includes("satisfies RouteManifest") ||
      !(await text("ui/backoffice.zod.gen.ts")).includes("export")
    ) {
      if (Date.now() > deadline) {
        throw new Error(`timed out: ${stderr.join("")}`);
      }
      await Bun.sleep(20);
    }
    server.addRoute("/api/admin/audit");
    while (!(await text("ui/backoffice.gen.ts")).includes("/api/admin/audit")) {
      if (Date.now() > deadline) {
        throw new Error(`timed out on the rewrite: ${stderr.join("")}`);
      }
      await Bun.sleep(20);
    }
    expect(await text("ui/customer.gen.ts")).not.toContain("/api/admin");
    controller.abort();
    expect(await done).toBe(0);
    expect(stderr).toEqual([]);
  }, 40_000);
});
