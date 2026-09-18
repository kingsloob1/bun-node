import type { BunPlugin } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Contract from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import * as Config from "../../lib/api/config";
import { JOBS_API_PROTOCOL_VERSION as META_PROTOCOL } from "../../lib/api/routes/meta";
import { JOB_STATES as COMMON_STATES } from "../../lib/api/schemas/common";
import { JobIdRefSchema, NewJobIdSchema } from "../../lib/api/schemas/jobs";
import { JOB_INCLUDES as SERIALIZE_INCLUDES } from "../../lib/api/serialize";
import * as Channels from "../../lib/api/ws/channels";
import {
  QUEUE_EVENT_NAMES,
  RUNNER_EVENT_NAMES,
  EVENT_TYPES as WS_EVENT_TYPES,
} from "../../lib/api/ws/events";
import * as Protocol from "../../lib/api/ws/protocol";
import * as Root from "../../lib/index";
import { ConfigError } from "../../lib/index";
import { assertSegment } from "../../lib/shared/keys";

/**
 * The browser-safe contract, `@kingsleyweb/bun-jobs/api/contract`: that it
 * imports nothing but itself (so a browser bundle of it holds no server
 * code), and that the server's constants *are* its constants — one
 * definition, re-exported — rather than copies that could disagree.
 */

/** The contract's directory. */
const CONTRACT_DIR = new URL("../../lib/api/contract/", import.meta.url)
  .pathname;

/** Every source file in the contract directory. */
async function contractFiles(): Promise<string[]> {
  return (await readdir(CONTRACT_DIR))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(CONTRACT_DIR, file));
}

/** Every module specifier a file names: static, `export … from`, type-only and dynamic alike. */
function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]!);
    }
  }
  return [...found];
}

describe("job-id escaping for channel names", () => {
  it("is defined once, in the contract: the socket and the root use that very function", () => {
    expect(Contract.encodeJobId).toBeFunction();
    expect(Contract.decodeJobId).toBeFunction();
    expect(Channels.encodeJobId).toBe(Contract.encodeJobId);
    expect(Channels.decodeJobId).toBe(Contract.decodeJobId);
    expect(Root.encodeJobId).toBe(Contract.encodeJobId);
    expect(Root.decodeJobId).toBe(Contract.decodeJobId);
  });

  it("escapes as encodeURIComponent does, and a lone surrogate as %uXXXX", () => {
    for (const id of [
      "plain",
      "a/b c",
      "100%",
      "\u{1F600}",
      "x\uDC00y",
      "\uD83D",
    ]) {
      expect(Contract.decodeJobId(Contract.encodeJobId(id))).toBe(id);
    }
    expect(Contract.encodeJobId("a/b c")).toBe(encodeURIComponent("a/b c"));
    expect(Contract.encodeJobId("x\uDC00y")).toBe("x%uDC00y");
    expect(Channels.jobChannel("mail", "\uD83D")).toBe("queue/mail/job/%uD83D");
    expect(() => Contract.decodeJobId("%u0041")).toThrow(URIError);
  });
});

describe("the contract's import graph", () => {
  it("names only its own sibling files, in every file, type imports included", async () => {
    const files = await contractFiles();
    expect(files.map((file) => file.slice(CONTRACT_DIR.length)).sort()).toEqual(
      ["constants.ts", "index.ts", "types.ts", "ws.ts"],
    );
    for (const file of files) {
      const source = await Bun.file(file).text();
      for (const specifier of specifiersOf(source)) {
        expect({ file, specifier }).toEqual({
          file,
          specifier: expect.stringMatching(/^\.\/(?:constants|types|ws)$/),
        });
      }
      // What the transpiler sees as runtime imports: only `./constants`.
      const runtime = new Bun.Transpiler({ loader: "ts" })
        .scanImports(source)
        .map((entry) => entry.path);
      expect(runtime.every((path) => path === "./constants")).toBe(true);
    }
  });

  it("the scan sees an import the contract must not have (the control)", () => {
    expect(
      specifiersOf(
        'import type { X } from "../drivers/index";\nexport * from "node:fs";',
      ),
    ).toEqual(["../drivers/index", "node:fs"]);
  });

  it("bundles for the browser with every resolution inside the contract, and runs", async () => {
    const resolved: string[] = [];
    const confine: BunPlugin = {
      name: "confine-to-contract",
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point-build") {
            return undefined;
          }
          resolved.push(args.path);
          const target = join(args.resolveDir, `${args.path}.ts`);
          if (!args.path.startsWith("./") || !target.startsWith(CONTRACT_DIR)) {
            throw new Error(`the contract imports ${args.path}`);
          }
          return { path: target };
        });
      },
    };
    const result = await Bun.build({
      entrypoints: [join(CONTRACT_DIR, "index.ts")],
      target: "browser",
      format: "esm",
      external: [],
      plugins: [confine],
    });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(1);
    // Type-only imports are erased: the one runtime edge is the constants.
    expect([...new Set(resolved)]).toEqual(["./constants"]);

    const bundle = await result.outputs[0]!.text();
    expect(bundle).not.toMatch(/\b(?:require|import)\s*\(/);
    expect(bundle).not.toMatch(/from\s*["']/);

    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-contract-"));
    try {
      const file = join(dir, "contract.mjs");
      await Bun.write(file, bundle);
      const loaded = (await import(file)) as typeof Contract;
      expect(loaded.JOBS_API_WS_SUBPROTOCOL).toBe("bun-jobs.v1");
      expect(loaded.JOBS_API_PROTOCOL_VERSION).toBe(1);
      expect(loaded.JOBS_API_WS_MAX_CHANNELS_PER_FRAME).toBe(256);
      expect([...loaded.EVENT_TYPES]).toEqual([...Contract.EVENT_TYPES]);
      expect([...loaded.JOBS_API_MUTATIONS]).toEqual([
        ...Contract.JOBS_API_MUTATIONS,
      ]);
      // A browser client can name the job channel of any id, a lone
      // surrogate's included, and read one back.
      const lone = "job-\uD800-x";
      expect(loaded.encodeJobId(lone)).toBe("job-%uD800-x");
      expect(loaded.decodeJobId(loaded.encodeJobId(lone))).toBe(lone);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a bundle reaching outside the contract fails (the control)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-jobs-contract-"));
    try {
      const entry = join(dir, "entry.ts");
      await Bun.write(entry, 'export { sep } from "node:path";\n');
      const outside: BunPlugin = {
        name: "confine",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point-build") {
              return undefined;
            }
            throw new Error(`reaches ${args.path}`);
          });
        },
      };
      const failed = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        plugins: [outside],
        throw: false,
      });
      expect(failed.success).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("one definition of each constant", () => {
  it("the server's constants are the contract's own values, not copies", () => {
    expect(Config.JOBS_API_ACTIONS).toBe(Contract.JOBS_API_ACTIONS);
    expect(Config.JOBS_API_MUTATIONS).toBe(Contract.JOBS_API_MUTATIONS);
    expect(Config.JOBS_API_OPT_IN_ACTIONS).toBe(
      Contract.JOBS_API_OPT_IN_ACTIONS,
    );
    expect(META_PROTOCOL).toBe(Contract.JOBS_API_PROTOCOL_VERSION);
    expect(Protocol.JOBS_API_WS_SUBPROTOCOL).toBe(
      Contract.JOBS_API_WS_SUBPROTOCOL,
    );
    expect(Protocol.JOBS_API_WS_CLOSE).toBe(Contract.JOBS_API_WS_CLOSE);
    expect(Protocol.JOBS_API_WS_MAX_CHANNELS_PER_FRAME).toBe(
      Contract.JOBS_API_WS_MAX_CHANNELS_PER_FRAME,
    );
    expect(WS_EVENT_TYPES).toBe(Contract.EVENT_TYPES);
    expect(COMMON_STATES).toBe(Contract.JOB_STATES);
    expect(SERIALIZE_INCLUDES).toBe(Contract.JOB_INCLUDES);
    // And the package root re-exports the same values.
    expect(Root.JOBS_API_ACTIONS).toBe(Contract.JOBS_API_ACTIONS);
    expect(Root.JOBS_API_WS_CLOSE).toBe(Contract.JOBS_API_WS_CLOSE);
    expect(Root.JOBS_API_PROTOCOL_VERSION).toBe(
      Contract.JOBS_API_PROTOCOL_VERSION,
    );
  });

  it("the id caps are the ones the schemas apply", () => {
    expect(NewJobIdSchema.json.maxLength).toBe(Contract.MAX_JOB_ID_LENGTH);
    expect(JobIdRefSchema.json.maxLength).toBe(Contract.MAX_JOB_REF_LENGTH);
    expect(Contract.MAX_JOB_ID_LENGTH).toBe(191);
  });

  it("lists the event names the socket's schema tables declare, in their order", () => {
    expect([...Contract.QUEUE_EVENT_TYPES]).toEqual(QUEUE_EVENT_NAMES);
    expect([...Contract.RUNNER_EVENT_TYPES]).toEqual(RUNNER_EVENT_NAMES);
    const distinct: string[] = [
      ...new Set<string>([...QUEUE_EVENT_NAMES, ...RUNNER_EVENT_NAMES]),
    ];
    expect<string[]>([...Contract.EVENT_TYPES]).toEqual(distinct);
  });

  it("the documented name pattern and length are the drivers' key-segment rule", () => {
    const pattern = new RegExp(Contract.NAME_PARAM_PATTERN, "u");
    const accepts = (value: string) => {
      try {
        assertSegment(value, "name");
        return true;
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return false;
      }
    };
    const samples = [
      "mail",
      "a.b-c_d",
      "UPPER",
      "x".repeat(Contract.MAX_NAME_LENGTH),
      ".",
      "..",
      "...",
      ".hidden",
      "bad/name",
      "bad name",
      "bad:name",
      "ümlaut",
      "",
    ];
    for (const sample of samples) {
      expect({ sample, documented: pattern.test(sample) }).toEqual({
        sample,
        documented: accepts(sample),
      });
    }
    expect(accepts("x".repeat(Contract.MAX_NAME_LENGTH + 1))).toBe(false);
    expect(new RegExp(Contract.NAME_SEGMENT_PATTERN).source).toBe("^[\\w.-]+$");
  });
});
