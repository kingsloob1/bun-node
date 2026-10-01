import type * as Remote from "@kingsleyweb/bun-jobs/remote";
import type { BunPlugin } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * `@kingsleyweb/bun-jobs/remote` is browser-safe: an executor in a V8
 * isolate (Cloudflare Workers, Deno Deploy) bundles it with no driver, no
 * bun-common and no `node:*` or `bun:*` module. The schemas module is held
 * to the same rule, because the reference executor (PR-2a3) reaches it from
 * this entry. `host/` is the one place `node:crypto` is allowed, and nothing
 * the entry reaches imports it.
 */

const LIB = new URL("../../lib/", import.meta.url).pathname;
const REMOTE = join(LIB, "remote/");

/**
 * Every file the browser graph may resolve to at runtime: the protocol, the
 * schema builder it is written with, the contract constants and the error
 * types. Type-only imports (bun-common's `StandardSchemaV1`, the contract's
 * types) are erased before resolution, so they never appear.
 */
const ALLOWED = new Set(
  [
    "remote/constants.ts",
    "remote/mac.ts",
    "remote/nonce.ts",
    "remote/signing.ts",
    "remote/schemas.ts",
    "remote/types.ts",
    "api/schema/builder.ts",
    "api/schema/validate.ts",
    "api/schema/coerce.ts",
    "api/contract/constants.ts",
    "shared/errors.ts",
  ].map((file) => join(LIB, file)),
);

/** Every module specifier a file names: static, `export … from`, type-only and dynamic alike. */
function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]!);
    }
  }
  return [...found];
}

/** A plugin that resolves only relative imports landing on {@link ALLOWED}, recording each. */
function confine(resolved: string[]): BunPlugin {
  return {
    name: "confine-to-remote",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point-build") {
          return undefined;
        }
        const target = join(args.resolveDir, `${args.path}.ts`);
        if (!args.path.startsWith(".") || !ALLOWED.has(target)) {
          throw new Error(`the remote graph reaches ${args.path}`);
        }
        resolved.push(target.slice(LIB.length));
        return { path: target };
      });
    },
  };
}

describe("the remote entry's import graph", () => {
  it("every browser-side file names only browser-safe modules, type imports included", async () => {
    const files = (await readdir(REMOTE)).filter((file) =>
      file.endsWith(".ts"),
    );
    expect(files.sort()).toEqual([
      "constants.ts",
      "index.ts",
      "mac.ts",
      "nonce.ts",
      "schemas.ts",
      "signing.ts",
      "types.ts",
    ]);
    const allowed = new Set([
      "./constants",
      "./mac",
      "./nonce",
      "./schemas",
      "./signing",
      "./types",
      "../api/schema/builder",
      "../api/contract/constants",
      "../api/contract/types",
      "../shared/errors",
    ]);
    for (const file of files) {
      const source = await Bun.file(join(REMOTE, file)).text();
      for (const specifier of specifiersOf(source)) {
        expect({ file, specifier, allowed: allowed.has(specifier) }).toEqual({
          file,
          specifier,
          allowed: true,
        });
      }
    }
  });

  it("host/ is where node:crypto lives, and the scan sees it (the control)", async () => {
    const source = await Bun.file(join(REMOTE, "host/mac.ts")).text();
    expect(specifiersOf(source)).toContain("node:crypto");
  });
});

describe("bundling for the browser", () => {
  it("bundles the entry and the schemas with every resolution allowed, and runs", async () => {
    const resolved: string[] = [];
    const result = await Bun.build({
      entrypoints: [join(REMOTE, "index.ts"), join(REMOTE, "schemas.ts")],
      target: "browser",
      format: "esm",
      splitting: false,
      plugins: [confine(resolved)],
    });
    expect(result.success).toBe(true);
    // The schemas pull the builder in; nothing reaches host/.
    expect(new Set(resolved)).toContain("api/schema/builder.ts");
    expect([...resolved].some((path) => path.includes("host/"))).toBe(false);

    const entry = result.outputs.find((output) =>
      output.path.endsWith("index.js"),
    )!;
    const schemas = result.outputs.find((output) =>
      output.path.endsWith("schemas.js"),
    )!;
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-remote-"));
    try {
      for (const [output, name] of [
        [entry, "remote.mjs"],
        [schemas, "schemas.mjs"],
      ] as const) {
        const text = await output.text();
        expect(text).not.toMatch(/\b(?:require|import)\s*\(/);
        expect(text).not.toMatch(/from\s*["']/);
        expect(text).not.toContain("node:");
        await Bun.write(join(dir, name), text);
      }

      // The bundle signs and verifies on its own, with WebCrypto.
      const loaded = (await import(join(dir, "remote.mjs"))) as typeof Remote;
      expect(loaded.WORKER_PROTOCOL_VERSION).toBe(1);
      expect(loaded.REMOTE_HEADERS.signature).toBe("bun-jobs-signature");
      const header = await loaded.signEnvelope("{}", {
        direction: "request",
        secret: "k",
        now: 1_790_000_000_000,
      });
      expect(
        await loaded.verifyEnvelope("{}", header, {
          direction: "request",
          secret: "k",
          now: 1_790_000_000_000,
          nonces: loaded.createRemoteNonceCache(),
        }),
      ).toEqual({ ok: true, timestamp: 1_790_000_000, keyIndex: 0 });

      const parsed = (await import(join(dir, "schemas.mjs"))) as {
        parseRemoteMessage: (value: unknown) => { ok: boolean };
      };
      expect(parsed.parseRemoteMessage({ op: "ack" }).ok).toBe(true);
      expect(parsed.parseRemoteMessage({ op: "nope" }).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the host's node:crypto MAC fails the same bundle (the control)", async () => {
    const failed = await Bun.build({
      entrypoints: [join(REMOTE, "host/mac.ts")],
      target: "browser",
      plugins: [confine([])],
      throw: false,
    });
    expect(failed.success).toBe(false);
  });

  it("so does an entry that imports the drivers (the control)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-remote-"));
    try {
      const entry = join(dir, "entry.ts");
      // Relative, so it passes the plugin's first test and fails the second.
      const drivers = relative(dir, join(LIB, "drivers/index"));
      await Bun.write(entry, `export { MemoryDriver } from "${drivers}";\n`);
      const failed = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        plugins: [confine([])],
        throw: false,
      });
      expect(failed.success).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
