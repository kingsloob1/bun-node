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
import type {
  CellResult,
  CellStatus,
  ConsumerPlan,
  ConsumerPlanner,
  EntryConfig,
  RunResult,
} from "../consumer-check";
import {
  bareSpecifiers,
  consumerManifest,
  failures,
  planConsumers,
  resolveWorkDir,
  runCheck,
  scanLeaks,
  withoutOtherPeers,
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

describe("planConsumers: one consumer per optional-peer set", () => {
  const optional = new Set(["@x/jobs", "@x/cache", "zod", "typescript"]);
  const entry = (spelling: string, peers?: string[]): EntryConfig => ({
    spelling,
    peers,
  });

  it("checks entries without peers in the peerless consumer", () => {
    expect(planConsumers([entry("@x/nest")], optional)).toEqual([
      { name: "consumer", peers: [], spellings: ["@x/nest"] },
    ]);
  });

  it("gives each distinct peer set its own consumer, holding that set only", () => {
    // bun-nest's shape: `./jobs` and `./cache` were checked together, in one
    // consumer that had both peers.
    const plans = planConsumers(
      [
        entry("@x/nest"),
        entry("@x/nest/jobs", ["@x/jobs"]),
        entry("@x/nest/cache", ["@x/cache"]),
      ],
      optional,
    );
    expect(plans).toEqual([
      { name: "consumer", peers: [], spellings: ["@x/nest"] },
      {
        name: "consumer-peers-x_jobs",
        peers: ["@x/jobs"],
        spellings: ["@x/nest/jobs"],
      },
      {
        name: "consumer-peers-x_cache",
        peers: ["@x/cache"],
        spellings: ["@x/nest/cache"],
      },
    ]);
  });

  it("shares one install between entries listing the same set, in any order", () => {
    const plans = planConsumers(
      [
        entry("@x/nest/both", ["@x/jobs", "@x/cache"]),
        entry("@x/nest/lib/both", ["@x/cache", "@x/jobs", "@x/cache"]),
      ],
      optional,
    );
    expect(plans).toHaveLength(2);
    expect(plans[1]).toEqual({
      name: "consumer-peers-x_cache_x_jobs",
      peers: ["@x/cache", "@x/jobs"],
      spellings: ["@x/nest/both", "@x/nest/lib/both"],
    });
  });

  it("always plans the peerless consumer first, even when every entry lists a peer", () => {
    const plans = planConsumers([entry("@x/z", ["zod"])], optional);
    expect(plans.map((p) => p.name)).toEqual([
      "consumer",
      "consumer-peers-zod",
    ]);
    expect(plans[0].spellings).toEqual([]);
  });

  it("keys only on optional peers: a listed package that is not one changes no install", () => {
    const plans = planConsumers(
      [entry("@x/a", ["react"]), entry("@x/b", ["zod", "react"])],
      optional,
    );
    expect(plans).toEqual([
      { name: "consumer", peers: [], spellings: ["@x/a"] },
      { name: "consumer-peers-zod", peers: ["zod"], spellings: ["@x/b"] },
    ]);
  });
});

describe("planConsumers: directory names", () => {
  it("never gives two sets one directory, even when their names coincide", () => {
    const plans = planConsumers(
      [
        { spelling: "@x/one", peers: ["a", "b"] },
        { spelling: "@x/two", peers: ["a_b"] },
      ],
      new Set(["a", "b", "a_b"]),
    );
    expect(plans.map((p) => p.name)).toEqual([
      "consumer",
      "consumer-peers-a_b",
      "consumer-peers-a_b-2",
    ]);
  });
});

describe("withoutOtherPeers", () => {
  it("drops every optional peer except the ones kept, and nothing else", () => {
    const deps = {
      "@x/common": "file:/t/common.tgz",
      "@x/jobs": "file:/t/jobs.tgz",
      "@x/cache": "file:/t/cache.tgz",
    };
    const optional = new Set(["@x/jobs", "@x/cache"]);
    expect(withoutOtherPeers(deps, optional, [])).toEqual({
      "@x/common": "file:/t/common.tgz",
    });
    expect(withoutOtherPeers(deps, optional, ["@x/jobs"])).toEqual({
      "@x/common": "file:/t/common.tgz",
      "@x/jobs": "file:/t/jobs.tgz",
    });
  });
});

/**
 * The rule before one consumer per peer set: entries without `peers` in a
 * peerless consumer, every entry with `peers` in one consumer holding all
 * of the package's optional peers. Kept here as the negative control.
 */
const formerPlan: ConsumerPlanner = (entries, optionalPeers) => {
  const plans: ConsumerPlan[] = [
    {
      name: "consumer",
      peers: [],
      spellings: entries.filter((e) => !e.peers?.length).map((e) => e.spelling),
    },
  ];
  const scoped = entries.filter((e) => e.peers?.length);
  if (scoped.length > 0)
    plans.push({
      name: "consumer-peers",
      peers: [...optionalPeers].sort(),
      spellings: scoped.map((e) => e.spelling),
    });
  return plans;
};

/** Writes `files` under `dir`, creating directories. */
function writeTree(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

/** A package of one module, `index`, exporting `name` as a number. */
function peerPackage(dir: string, pkg: string, name: string): void {
  writeTree(dir, {
    "package.json": JSON.stringify({
      name: pkg,
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    }),
    "index.js": `export const ${name} = 1;\n`,
    "index.d.ts": `export declare const ${name}: number;\n`,
  });
}

// End to end against real tarballs and installs (the registry supplies
// TypeScript and @types/bun): a fixture with two optional peers, A and B,
// where entry `./a` lists A but imports B. bun-nest's `./jobs` and `./cache`
// have this shape.
describe("runCheck: an entry scoped to one peer that needs another", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-peer-sets-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const peerA = join(root, "peer-a");
  const peerB = join(root, "peer-b");
  const pkg = join(root, "pkg");
  peerPackage(peerA, "@fixture/peer-a", "a");
  peerPackage(peerB, "@fixture/peer-b", "b");
  const entry = (sub: string) => ({
    types: `./${sub}.d.ts`,
    default: `./${sub}.js`,
  });
  writeTree(pkg, {
    "package.json": JSON.stringify({
      name: "@fixture/pkg",
      version: "1.0.0",
      type: "module",
      exports: { ".": entry("root"), "./a": entry("a"), "./b": entry("b") },
      peerDependencies: { "@fixture/peer-a": "*", "@fixture/peer-b": "*" },
      peerDependenciesMeta: {
        "@fixture/peer-a": { optional: true },
        "@fixture/peer-b": { optional: true },
      },
    }),
    "root.js": `export const root = 1;\n`,
    "root.d.ts": `export declare const root: number;\n`,
    // The bug: `./a` lists peer A, and reaches peer B as well.
    "a.js": `import { a } from "@fixture/peer-a";\nimport { b } from "@fixture/peer-b";\nexport const fromA = a + b;\n`,
    "a.d.ts": `import { a } from "@fixture/peer-a";\nimport { b } from "@fixture/peer-b";\nexport declare const fromA: typeof a & typeof b;\n`,
    "b.js": `import { b } from "@fixture/peer-b";\nexport const fromB = b;\n`,
    "b.d.ts": `import { b } from "@fixture/peer-b";\nexport declare const fromB: typeof b;\n`,
    "consumer-check.json": JSON.stringify({
      workspaceDependencies: [peerA, peerB],
      entries: [
        { spelling: "@fixture/pkg", values: ["root"] },
        {
          spelling: "@fixture/pkg/a",
          values: ["fromA"],
          peers: ["@fixture/peer-a"],
        },
        {
          spelling: "@fixture/pkg/b",
          values: ["fromB"],
          peers: ["@fixture/peer-b"],
        },
      ],
    }),
  });
  // One column is enough to tell the consumers apart; strict, so an import
  // the consumer cannot resolve inside a declaration is reported, not skipped.
  const columns = ["bundler/strict"];
  const statuses = (result: RunResult, spelling: string) => [
    ...new Set(
      result.cells.filter((c) => c.spelling === spelling).map((c) => c.status),
    ),
  ];

  it("fails under one consumer per peer set: ./a is checked without peer B", async () => {
    const work = join(root, "work-sets");
    const result = await runCheck({ packageDir: pkg, work, columns });
    expect(
      result.consumers?.map(({ name, peers, spellings }) => ({
        name,
        peers,
        spellings,
      })),
    ).toEqual([
      { name: "consumer", peers: [], spellings: ["@fixture/pkg"] },
      {
        name: "consumer-peers-fixture_peer-a",
        peers: ["@fixture/peer-a"],
        spellings: ["@fixture/pkg/a"],
      },
      {
        name: "consumer-peers-fixture_peer-b",
        peers: ["@fixture/peer-b"],
        spellings: ["@fixture/pkg/b"],
      },
    ]);
    // Each consumer holds its own set and none of the others.
    const has = (consumer: string, peer: string) =>
      existsSync(join(work, consumer, "node_modules", peer, "package.json"));
    expect(has("consumer", "@fixture/peer-a")).toBe(false);
    expect(has("consumer", "@fixture/peer-b")).toBe(false);
    expect(has("consumer-peers-fixture_peer-a", "@fixture/peer-a")).toBe(true);
    expect(has("consumer-peers-fixture_peer-a", "@fixture/peer-b")).toBe(false);
    expect(has("consumer-peers-fixture_peer-b", "@fixture/peer-b")).toBe(true);

    expect(statuses(result, "@fixture/pkg")).toEqual(["OK"]);
    expect(statuses(result, "@fixture/pkg/b")).toEqual(["OK"]);
    expect(statuses(result, "@fixture/pkg/a")).not.toContain("OK");
    expect(result.runtime["@fixture/pkg/a"]).toContain("@fixture/peer-b");
    const { failed } = failures(result);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((f) => f.includes("@fixture/pkg/a"))).toBe(true);
    expect(failed).toContainEqual(
      expect.stringMatching(/^RUNTIME-FAIL {2}@fixture\/pkg @fixture\/pkg\/a:/),
    );
  }, 180_000);

  it("passes under the former two consumers, which gave ./a every peer (negative control)", async () => {
    const result = await runCheck({
      packageDir: pkg,
      work: join(root, "work-former"),
      plan: formerPlan,
      columns,
    });
    expect(result.consumers?.map((c) => c.name)).toEqual([
      "consumer",
      "consumer-peers",
    ]);
    expect(statuses(result, "@fixture/pkg/a")).toEqual(["OK"]);
    expect(result.runtime["@fixture/pkg/a"]).toBe("ok");
    expect(failures(result).failed).toEqual([]);
  }, 180_000);
});
