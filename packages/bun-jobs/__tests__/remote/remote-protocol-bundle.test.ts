import type { BunPlugin } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * The frame codec, the replay window and the SSE parser
 * (`lib/remote/protocol/`) are browser-safe like the rest of `./remote`'s
 * graph: an executor in a V8 isolate frames its stream with them. They are
 * not exported (Q-2.3), so `remote-bundle.test.ts`, which follows the entry,
 * never reaches them; this test bundles them directly, for the browser, and
 * runs the bundle with WebCrypto alone.
 *
 * `sse.ts` re-exports bun-common's browser-safe `@kingsleyweb/bun-common/sse`
 * (PR-sse5), the one bare specifier a protocol file may name. Inside that
 * graph Bun resolves as usual, but nothing may reach `node:*` or `bun`.
 */

const LIB = new URL("../../lib/", import.meta.url).pathname;
const PROTOCOL = join(LIB, "remote/protocol/");

/** What a protocol file may resolve to at runtime. */
const ALLOWED = new Set(
  [
    "remote/protocol/frame.ts",
    "remote/protocol/sequence.ts",
    "remote/protocol/sse.ts",
    "remote/constants.ts",
    "remote/mac.ts",
    "remote/signing.ts",
    "shared/errors.ts",
  ].map((file) => join(LIB, file)),
);

/** The one package a protocol file may import: bun-common's browser-safe SSE entry. */
const SSE_ENTRY = "@kingsleyweb/bun-common/sse";

/** bun-common's package directory, and bun-contract's, which its contract modules re-export. */
const COMMON = join(dirname(Bun.resolveSync(SSE_ENTRY, LIB)), "../../");
const PACKAGES = [
  COMMON,
  join(
    dirname(Bun.resolveSync("@kingsleyweb/bun-contract/package.json", COMMON)),
    "/",
  ),
];

/**
 * Resolves a protocol file's relative imports only when they land on
 * {@link ALLOWED}, and its bare ones only for `entry` ({@link SSE_ENTRY});
 * inside {@link PACKAGES}, defers to Bun but refuses `node:*` and `bun`.
 *
 * @param entry The package specifier a protocol file may name; the control
 *              passes bun-common's root, whose graph reaches `node:*`.
 */
function confineTo(entry: string): BunPlugin {
  return {
    name: "confine-to-protocol",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point-build") {
          return undefined;
        }
        if (PACKAGES.some((root) => args.importer.startsWith(root))) {
          if (/^(?:node:|bun(?::|$))/.test(args.path)) {
            throw new Error(`the SSE entry's graph reaches ${args.path}`);
          }
          return undefined;
        }
        if (args.path === entry) {
          // Resolved from bun-jobs, wherever the importer is (the control's
          // entry sits in a temporary directory).
          return { path: Bun.resolveSync(entry, LIB) };
        }
        const target = join(args.resolveDir, `${args.path}.ts`);
        if (!args.path.startsWith(".") || !ALLOWED.has(target)) {
          throw new Error(`the protocol graph reaches ${args.path}`);
        }
        return { path: target };
      });
    },
  };
}

/** The plugin the bundle runs under. */
const confine = confineTo(SSE_ENTRY);

describe("lib/remote/protocol is browser-safe", () => {
  it("holds exactly the three modules this test knows", async () => {
    expect((await readdir(PROTOCOL)).sort()).toEqual([
      "frame.ts",
      "sequence.ts",
      "sse.ts",
    ]);
  });

  it("bundles for the browser with every resolution allowed, and runs on WebCrypto", async () => {
    const result = await Bun.build({
      entrypoints: ["frame.ts", "sequence.ts", "sse.ts"].map((file) =>
        join(PROTOCOL, file),
      ),
      target: "browser",
      format: "esm",
      splitting: false,
      plugins: [confine],
    });
    expect(result.success).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-protocol-"));
    try {
      for (const output of result.outputs) {
        const text = await output.text();
        expect(text).not.toContain("node:");
        expect(text).not.toMatch(/from\s*["']/);
        await Bun.write(join(dir, output.path.split("/").pop()!), text);
      }
      const frame = (await import(
        join(dir, "frame.js")
      )) as typeof import("../../lib/remote/protocol/frame");
      const { SseParser } = (await import(
        join(dir, "sse.js")
      )) as typeof import("../../lib/remote/protocol/sse");
      const { TextFrameWindow } = (await import(
        join(dir, "sequence.js")
      )) as typeof import("../../lib/remote/protocol/sequence");

      const key = new TextEncoder().encode("k");
      const line = await frame.encodeTextFrame(
        { op: "ping", id: "p1" },
        { key, sid: "inv_1", dir: "e", seq: 1, ack: 0 },
      );
      const events = new SseParser().push(`data: ${line}\n\n`);
      expect(events).toHaveLength(1);
      const decoded = await frame.decodeTextFrame(
        (events[0] as { data: string }).data,
        { keys: [key], sid: "inv_1", dir: "e" },
      );
      expect(decoded.ok).toBe(true);
      expect(
        decoded.ok && new TextFrameWindow().admit(decoded.frame).verdict,
      ).toBe("deliver");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a protocol file that reached the host's node:crypto would fail (the control)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-protocol-"));
    try {
      const entry = join(dir, "entry.ts");
      // Relative, so it passes the plugin's first test and fails the second.
      const host = relative(dir, join(LIB, "remote/host/mac"));
      await Bun.write(entry, `export { nodeHmacSha256 } from "${host}";\n`);
      const failed = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        plugins: [confine],
        throw: false,
      });
      expect(failed.success).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("inside bun-common's graph, node:* is refused (the control)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-protocol-"));
    try {
      // bun-common's root reaches node:* (its router, its file helpers): let
      // through as if it were the SSE entry, the plugin must still refuse it.
      const entry = join(dir, "entry.ts");
      await Bun.write(
        entry,
        `export { BunRouter } from "@kingsleyweb/bun-common";\n`,
      );
      const failed = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        plugins: [confineTo("@kingsleyweb/bun-common")],
        throw: false,
      });
      expect(failed.success).toBe(false);
      expect(failed.logs.map(String).join("\n")).toContain(
        "the SSE entry's graph reaches node:",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
