/**
 * The browser-safe subpath `@kingsleyweb/bun-common/envelope` (PR-P4): an
 * executor in a V8 isolate signs with it, so its bundle for the browser
 * holds its own modules and bun-common's dependency-free errors, and no
 * server code; and it signs and verifies there on WebCrypto alone. The
 * negative control: the package root, which holds the server, is caught by
 * the same markers.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const LIB = resolve(import.meta.dir, "../../lib");

/** Text only server code contains. */
const SERVER_MARKERS: readonly RegExp[] = [
  /["'`](?:node|bun):[\w/]+["'`]/,
  /\bimport\.meta\.(?:require|dir|path)\b/,
  /\bBun\.\w+/,
  /\bprocess\.(?:env|platform|versions|cwd|nextTick)\b/,
  /\brequire\(/,
  /\bBuffer\.(?:from|alloc|concat|isBuffer)\b/,
];

/** Bundles `entry` for a browser; returns its code and every module it pulled in. */
async function bundle(entry: string) {
  const modules: string[] = [];
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    throw: false,
    plugins: [
      {
        name: "record-modules",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
            modules.push(relative(LIB, args.path));
            return { contents: await Bun.file(args.path).text(), loader: "ts" };
          });
        },
      },
    ],
  });
  const code = result.success
    ? (await Promise.all(result.outputs.map((o) => o.text()))).join("\n")
    : "";
  return { result, code, modules: modules.sort() };
}

describe("the envelope subpath in a browser bundle", () => {
  it("holds its own modules and the errors, nothing of the server, and signs on WebCrypto", async () => {
    const { result, code, modules } = await bundle(
      join(LIB, "envelope/index.ts"),
    );
    expect(result.success).toBe(true);
    expect(modules).toEqual([
      "envelope/index.ts",
      "envelope/mac.ts",
      "envelope/nonce.ts",
      "envelope/signing.ts",
      "errors.ts",
    ]);
    expect(
      SERVER_MARKERS.filter((m) => m.test(code)).map((m) => m.source),
    ).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), "bun-common-envelope-"));
    try {
      await Bun.write(join(dir, "envelope.mjs"), code);
      const envelope = (await import(
        join(dir, "envelope.mjs")
      )) as typeof import("../../lib/envelope/index");
      const options = {
        direction: "request",
        secret: "k",
        now: 1_790_000_000_000,
      } as const;
      const header = await envelope.signEnvelope("{}", options);
      expect(
        await envelope.verifyEnvelope("{}", header, options),
      ).toMatchObject({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("negative control: the package root, which holds the server, is caught", async () => {
    const { result, code } = await bundle(join(LIB, "index.ts"));
    if (!result.success) {
      expect(result.logs.length).toBeGreaterThan(0);
      return;
    }
    expect(SERVER_MARKERS.some((m) => m.test(code))).toBe(true);
  }, 60_000);

  it("negative control: the envelope with node:crypto planted beside it is caught", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-common-envelope-"));
    try {
      const entry = join(dir, "entry.ts");
      await Bun.write(
        entry,
        `export * from "${join(LIB, "envelope/index.ts")}";\nexport { nodeHmacSha256 } from "${join(import.meta.dir, "nodeMac.ts")}";\n`,
      );
      const { result, code, modules } = await bundle(entry);
      expect(modules).toContain("envelope/signing.ts");
      if (!result.success) {
        expect(result.logs.length).toBeGreaterThan(0);
        return;
      }
      expect(SERVER_MARKERS.some((m) => m.test(code))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
