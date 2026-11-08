import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import type { CellResult, CellStatus, RunResult } from "../consumer-check";
import {
  bareSpecifiers,
  consumerManifest,
  failures,
  resolveWorkDir,
  scanLeaks,
} from "../consumer-check";

// The sentence that exposed the regex scanner, verbatim from bun-jobs'
// `lib/drivers/jobCursor.ts`. tsc copies it into `dts/drivers/jobCursor.d.ts`,
// where a `\bfrom\s*"…"` pattern read it as an import of a package called
// `ordered by something creation cannot see` and failed the run.
const JOB_CURSOR_DOC = `/**
 * \`createdAt\`, and no test on the rows distinguishes "ordered by creation"
 * from "ordered by something creation cannot see". The seek has to happen
 * where the order is known, which is the driver.
 */
export declare function seekFallback(): void;
`;

describe("bareSpecifiers", () => {
  it("finds every form of import a declaration can make", () => {
    const dts = [
      `/// <reference types="some-types-pkg" />`,
      `import { a } from "some-undeclared-pkg";`,
      `import type { B } from '@scope/pkg/deep';`,
      `export * from "reexported-pkg";`,
      `export { c } from "named-reexport-pkg";`,
      `import d = require("required-pkg");`,
      `import "side-effect-pkg";`,
      `export declare const e: import("type-query-pkg").E;`,
      `export * from "./relative";`,
    ].join("\n");
    expect(bareSpecifiers(dts).sort()).toEqual(
      [
        "@scope/pkg/deep",
        "named-reexport-pkg",
        "reexported-pkg",
        "required-pkg",
        "side-effect-pkg",
        "some-types-pkg",
        "some-undeclared-pkg",
        "type-query-pkg",
      ].sort(),
    );
  });

  it("ignores the import shape in prose: doc comments, line comments, strings", () => {
    const dts = [
      `/** Reads from "a-doc-comment", like import("a-doc-query"). */`,
      `// taken from "a-line-comment"`,
      `/* import x from "a-block-comment"; */`,
      `export declare const s: "from \\"a-string-literal\\"";`,
      `export type T = \`from "a-template-literal"\`;`,
      `export declare const n: number;`,
    ].join("\n");
    expect(bareSpecifiers(dts)).toEqual([]);
  });

  it("ignores the jobCursor sentence that tripped the regex scanner", () => {
    expect(bareSpecifiers(JOB_CURSOR_DOC)).toEqual([]);
  });

  it("still sees a real import beside prose that looks like one", () => {
    const dts = `${JOB_CURSOR_DOC}import { x } from "some-undeclared-pkg";\n`;
    expect(bareSpecifiers(dts)).toEqual(["some-undeclared-pkg"]);
  });

  it("honours a reference directive only where TypeScript does, at the top", () => {
    expect(
      bareSpecifiers(
        `import { a } from "x";\n/// <reference types="late" />\n`,
      ),
    ).toEqual(["x"]);
  });
});

describe("scanLeaks", () => {
  const root = mkdtempSync(join(tmpdir(), "consumer-check-test-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Writes a fake installed package: its manifest plus the given `.d.ts` files. */
  function installed(name: string, files: Record<string, string>): string {
    const dir = join(root, name);
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    write(
      "package.json",
      JSON.stringify({
        name: "@fixture/pkg",
        dependencies: { "declared-pkg": "^1.0.0", "@types/typed-pkg": "^1" },
        peerDependencies: { "optional-peer": "^1.0.0" },
        peerDependenciesMeta: { "optional-peer": { optional: true } },
      }),
    );
    for (const [path, text] of Object.entries(files)) write(path, text);
    return dir;
  }

  // The negative control: without it, a scanner that finds nothing at all
  // would pass every test above that expects silence.
  it("flags an undeclared import, type query and reference directive", () => {
    const dir = installed("leaky", {
      "dts/import.d.ts": `import { a } from "some-undeclared-pkg";\n`,
      "dts/query.d.ts": `export declare const q: import("undeclared-query-pkg").Q;\n`,
      "dts/reference.d.ts": `/// <reference types="undeclared-types-pkg" />\nexport {};\n`,
      "dts/peer.d.ts": `import type { P } from "optional-peer";\n`,
    });
    expect(scanLeaks(dir, new Set()).sort()).toEqual(
      [
        `dts/import.d.ts imports "some-undeclared-pkg" (not declared)`,
        `dts/peer.d.ts imports "optional-peer" (optional peer)`,
        `dts/query.d.ts imports "undeclared-query-pkg" (not declared)`,
        `dts/reference.d.ts imports "undeclared-types-pkg" (not declared)`,
      ].sort(),
    );
  });

  it("passes declared packages, the runtime environment and prose", () => {
    const dir = installed("clean", {
      "dts/index.d.ts": [
        `/// <reference types="bun-types" />`,
        `import { a } from "declared-pkg";`,
        `import type { T } from "typed-pkg";`,
        `import { readFileSync } from "node:fs";`,
        `import type { Server } from "bun";`,
        `import type { P } from "optional-peer";`,
        `export * from "./sibling";`,
      ].join("\n"),
      "dts/drivers/jobCursor.d.ts": JOB_CURSOR_DOC,
    });
    expect(scanLeaks(dir, new Set(["optional-peer"]))).toEqual([]);
  });
});

/** One matrix cell in the given status. */
function cell(
  status: CellStatus,
  spelling = "@scope/pkg/query",
  column = "bundler/strict",
): CellResult {
  return {
    key: `${spelling}|${column}`,
    spelling,
    column,
    status,
    probeErrors: status === "PROBE-ERRORS" || status === "ANY" ? 1 : 0,
    libErrors: status === "LIB-ERRORS" ? 1 : 0,
    sample: status === "OK" ? [] : [`probe.ts(3,1): error TS2322: bad`],
  };
}

/** A run with the given cells, passing runtime imports and no leaks. */
function run(cells: CellResult[], over: Partial<RunResult> = {}): RunResult {
  return {
    package: "@scope/pkg",
    typescript: "6.0.3",
    cells,
    runtime: { "@scope/pkg/query": "ok" },
    leaks: [],
    ...over,
  };
}

describe("failures", () => {
  it("passes a run where every cell is OK", () => {
    expect(
      failures(run([cell("OK"), cell("OK", "@scope/pkg", "node16/slc")]))
        .failed,
    ).toEqual([]);
  });

  // The negative control for the rest: a broken probe used to exit 0.
  it("fails a PROBE-ERRORS cell, naming package, spelling, column and the errors", () => {
    const { failed } = failures(run([cell("OK"), cell("PROBE-ERRORS")]));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("PROBE-ERRORS");
    expect(failed[0]).toContain("@scope/pkg");
    expect(failed[0]).toContain("@scope/pkg/query");
    expect(failed[0]).toContain("[bundler/strict]");
    expect(failed[0]).toContain("error TS2322");
  });

  it.each(["UNRESOLVED", "ANY", "LIB-ERRORS"] as const)(
    "fails a %s cell too",
    (status) => {
      expect(failures(run([cell(status)])).failed).toHaveLength(1);
    },
  );

  it("fails a runtime import that does not resolve, a leak and a browser env leak", () => {
    expect(
      failures(run([cell("OK")], { runtime: { "@scope/pkg/query": "boom" } }))
        .failed,
    ).toHaveLength(1);
    expect(
      failures(run([cell("OK")], { leaks: ["dts/a.d.ts imports x"] })).failed,
    ).toHaveLength(1);
    expect(
      failures(run([{ ...cell("OK"), envLeaks: ["@types/node"] }])).failed,
    ).toHaveLength(1);
  });

  it("with a baseline, a problem it already had in the same status is known", () => {
    const base = run([cell("PROBE-ERRORS")], {
      runtime: { "@scope/pkg/query": "boom" },
    });
    const now = run([cell("PROBE-ERRORS")], {
      runtime: { "@scope/pkg/query": "boom" },
    });
    expect(failures(now, base).failed).toEqual([]);
  });

  it("with a baseline, a new or changed problem fails; OK -> broken is NEW-BROKEN", () => {
    const base = run([cell("OK"), cell("ANY", "@scope/pkg", "node16/slc")]);
    const now = run([
      cell("PROBE-ERRORS"),
      cell("PROBE-ERRORS", "@scope/pkg", "node16/slc"),
    ]);
    const { failed } = failures(now, base);
    expect(failed).toHaveLength(2);
    expect(failed.some((f) => f.startsWith("NEW-BROKEN"))).toBe(true);
  });

  it("with a baseline, reports fixed cells and fails a cell no longer checked", () => {
    const base = run([cell("PROBE-ERRORS"), cell("OK", "@scope/pkg", "x")]);
    const now = run([cell("OK")]);
    const v = failures(now, base);
    expect(v.fixed).toHaveLength(1);
    expect(v.failed).toEqual([expect.stringContaining("no longer checked")]);
  });
});

describe("consumerManifest: the consumer's package.json", () => {
  const manifest = consumerManifest({
    name: "@scope/core",
    tarball: "/t/scope-core-3.0.0-rc.0.tgz",
    workspace: { "@scope/viewer": "file:/t/scope-viewer-3.0.0-rc.0.tgz" },
    extra: { zod: "^4" },
  }) as {
    dependencies: Record<string, string>;
    overrides: Record<string, string>;
  };

  it("depends on the package and its siblings by their tarballs", () => {
    expect(manifest.dependencies).toEqual({
      "@scope/core": "file:/t/scope-core-3.0.0-rc.0.tgz",
      "@scope/viewer": "file:/t/scope-viewer-3.0.0-rc.0.tgz",
      "@types/bun": "^1.4.2",
      typescript: "^6.0.3",
      zod: "^4",
    });
  });

  it("overrides the package under test too, so a sibling depending on it never gets the registry's copy", () => {
    // `@scope/viewer` depends on `@scope/core`: without this override that
    // transitive range resolved from npm (bun-common 2.2.0 under
    // bun-api-docs-ui, until the ranges moved to an unpublished 3.0.0-rc.0).
    expect(manifest.overrides).toEqual({
      "@scope/core": "file:/t/scope-core-3.0.0-rc.0.tgz",
      "@scope/viewer": "file:/t/scope-viewer-3.0.0-rc.0.tgz",
    });
  });
});

describe("resolveWorkDir", () => {
  const cache = mkdtempSync(join(tmpdir(), "cc-workdir-"));
  afterAll(() => rmSync(cache, { recursive: true, force: true }));

  it("gives every run without --work a fresh directory of its own", () => {
    const a = resolveWorkDir("/repo/packages/bun-common", undefined, cache);
    const b = resolveWorkDir("/repo/packages/bun-common", undefined, cache);
    // The old default was one fixed path per package, so two runs shared it.
    expect(a.dir).not.toBe(b.dir);
    expect(a.ephemeral).toBe(true);
    expect(existsSync(a.dir)).toBe(true);
    expect(existsSync(b.dir)).toBe(true);
  });

  it("puts it under <cache>/consumer-check, named for the package", () => {
    const { dir } = resolveWorkDir("/repo/packages/bun-nest", undefined, cache);
    expect(dir.startsWith(join(cache, "consumer-check", "bun-nest-"))).toBe(
      true,
    );
  });

  it("uses an explicit --work as given, creates nothing and calls it not ephemeral", () => {
    const explicit = join(cache, "mine", "..", "mine");
    const w = resolveWorkDir("/repo/packages/bun-nest", explicit, cache);
    expect(w).toEqual({ dir: join(cache, "mine"), ephemeral: false });
    expect(existsSync(w.dir)).toBe(false);
  });

  it("defaults the cache root to ~/.cache, never /tmp", () => {
    const { dir } = resolveWorkDir("/repo/packages/bun-nest", undefined);
    try {
      expect(dir.startsWith("/tmp/")).toBe(false);
      expect(dir).toContain("/consumer-check/bun-nest-");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
