/**
 * How the declarations build finds imports, and that its four copies agree.
 *
 * `scripts/build-declarations.ts` verifies that no published declaration
 * imports a package a consumer may not have. It used to find imports by
 * matching `from "…"` as text, and failed the build three times on things that
 * were not imports at all: two doc comments and a string literal type. It now
 * parses each declaration (`moduleSpecifiers`). The cases below are those
 * three, every syntactic form a real import takes, and a negative control that
 * an undeclared import is still reported.
 *
 * The script is copied unchanged into every published package; this package's
 * copy is the one exercised here, and the last test holds the others to it.
 */

import type { Manifest } from "../scripts/build-declarations";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  checkImports,
  moduleSpecifiers,
  rewrite,
} from "../scripts/build-declarations";

const ROOT = resolve(import.meta.dir, "..");

/** The specifiers found in `text`, in source order. */
const specs = (text: string) => moduleSpecifiers(text).map((s) => s.text);

/** Text that reads like an import and is not one; none may be found. */
const NOT_IMPORTS: [string, string][] = [
  [
    "a doc comment telling one quoted phrase from another",
    [
      `/**`,
      ` * Lets a caller tell "nothing happened" from "nothing is recorded".`,
      ` */`,
      `export declare function recorded(): boolean;`,
    ].join("\n"),
  ],
  [
    "a doc comment saying what a design departs from",
    [
      `/** This departs from "each writer writes its bins wholesale". */`,
      `export interface Bins { total: number; }`,
    ].join("\n"),
  ],
  [
    `a string literal type "from" in a union`,
    [
      `export interface RangeQueryInput { from: number; to: number; step: number; }`,
      `export type Bounds = Pick<RangeQueryInput, "from" | "to">;`,
    ].join("\n"),
  ],
  [
    "a line comment and a string that spell an import",
    [
      `// import { x } from "left-pad";`,
      `export declare const hint = "import x from 'right-pad'";`,
      `export type Call = 'require("up-pad")';`,
    ].join("\n"),
  ],
  [
    "a declare module in a script, which declares rather than imports",
    `declare module "ambient-thing" { export const x: number; }`,
  ],
];

/** Every syntactic form a real import takes, and the specifiers it must yield. */
const IMPORTS: [string, string, string[]][] = [
  ["a named import", `import { a } from "named";`, ["named"]],
  ["import type", `import type { A } from "type-only";`, ["type-only"]],
  ["a default import", `import d from "default";`, ["default"]],
  ["a namespace import", `import * as ns from "namespace";`, ["namespace"]],
  ["a side-effect import", `import "side-effect";`, ["side-effect"]],
  ["export … from", `export { a } from "re-export";`, ["re-export"]],
  ["export type … from", `export type { A } from "type-re";`, ["type-re"]],
  ["export * from", `export * from "./star";`, ["./star"]],
  ["export * as ns from", `export * as ns from "star-ns";`, ["star-ns"]],
  [
    "import x = require()",
    `import eq = require("equals");\nexport = eq;`,
    ["equals"],
  ],
  [
    `import("x").T in a type`,
    `export declare const t: import("in-type").T;`,
    ["in-type"],
  ],
  [
    "import types nested in generics and signatures",
    `export declare function f(a: Map<string, import("deep").A>): Promise<import("deeper").B<import("deepest").C>>;`,
    ["deep", "deeper", "deepest"],
  ],
  [
    "a multi-line import",
    [
      `import {`,
      `  first,`,
      `  second,`,
      `} from`,
      `  "multi-line";`,
      `export { first, second };`,
    ].join("\n"),
    ["multi-line"],
  ],
  [
    "single quotes and import attributes",
    `import data from './data.json' with { type: "json" };\nexport { data };`,
    ["./data.json"],
  ],
  [
    "an import() and a require() call",
    `export declare const a: unknown;\nconst m = import("dynamic");\nconst r = require("required");`,
    ["dynamic", "required"],
  ],
  [
    "a module augmentation",
    `export {};\ndeclare module "augmented" { interface Extra { x: 1 } }`,
    ["augmented"],
  ],
  [
    "a reference types directive",
    `/// <reference types="referenced" />\nexport declare const x: number;`,
    ["referenced"],
  ],
];

describe("moduleSpecifiers", () => {
  for (const [name, text] of NOT_IMPORTS) {
    it(`finds nothing in ${name}`, () => {
      expect(specs(text)).toEqual([]);
    });
  }

  for (const [name, text, expected] of IMPORTS) {
    it(`finds ${name}`, () => {
      expect(specs(text)).toEqual(expected);
    });
  }

  it("finds every import in one file, in order, around the false positives", () => {
    // `export =` cannot share a file with other exports, and a reference
    // directive counts only at the top of one; both are covered alone above.
    const combinable = IMPORTS.filter(
      ([, t]) => !t.includes("export =") && !t.startsWith("///"),
    );
    const text = [
      ...NOT_IMPORTS.map(([, t]) => t).slice(0, 4),
      ...combinable.map(([, t]) => t),
    ].join("\n");
    expect(specs(text)).toEqual(combinable.flatMap(([, , found]) => found));
  });

  it("gives offsets that span exactly the specifier, inside its quotes", () => {
    const text = `/** from "no" */\nexport * from "./x";\nexport type T = import('./y').T;\n/// <reference types="z" />`;
    for (const spec of moduleSpecifiers(text))
      expect(text.slice(spec.start, spec.end)).toBe(spec.text);
    expect(moduleSpecifiers(text).map((s) => s.kind)).toEqual([
      "statement",
      "import-type",
    ]);
    // A reference directive counts only at the top of a file.
    expect(
      moduleSpecifiers(`/// <reference types="z" />\nexport {};`),
    ).toMatchObject([{ text: "z", kind: "reference" }]);
  });
});

describe("checkImports", () => {
  const manifest: Manifest = {
    name: "@scope/pkg",
    dependencies: { dep: "^1", "@types/typed": "^1" },
    peerDependencies: { required: "^1", optional: "^1" },
    peerDependenciesMeta: { optional: { optional: true } },
  };
  const file = resolve(ROOT, "dts/index.d.ts");
  const check = (text: string) =>
    checkImports(manifest, new Map([[file, text]]), () => true);

  it("reports none of the three false positives that broke the build", () => {
    // The script-only `declare module` case is left out: in a module (which
    // these exports make the file) it is an augmentation, a real import.
    const { problems, peerImports } = check(
      NOT_IMPORTS.map(([, text]) => text)
        .slice(0, 4)
        .join("\n"),
    );
    expect(problems).toEqual([]);
    expect(peerImports.size).toBe(0);
  });

  it("accepts dependencies, @types, required peers, the environment and itself", () => {
    const { problems } = check(
      [
        `import type { A } from "dep";`,
        `import type { B } from "typed";`,
        `export type { C } from "required/sub";`,
        `import type { D } from "node:events";`,
        `import type { E } from "bun";`,
        `export type F = import("@scope/pkg").F;`,
      ].join("\n"),
    );
    expect(problems).toEqual([]);
  });

  // The negative control: the parser must not have made the check blind.
  it("still reports a genuinely undeclared import, in every form", () => {
    const forms = [
      `import { a } from "undeclared-a";`,
      `import type {\n  B,\n} from "undeclared-b";`,
      `export * from "@undeclared/c";`,
      `export type D = import("undeclared-d").D;`,
    ];
    const { problems } = check(forms.join("\n"));
    expect(problems).toEqual([
      `dts/index.d.ts: imports "undeclared-a", which is not a dependency`,
      `dts/index.d.ts: imports "undeclared-b", which is not a dependency`,
      `dts/index.d.ts: imports "@undeclared/c", which is not a dependency`,
      `dts/index.d.ts: imports "undeclared-d", which is not a dependency`,
    ]);
  });

  it("collects an optional peer for checkPeerScopes instead of rejecting it", () => {
    const { problems, peerImports } = check(
      `export type P = import("optional").P;`,
    );
    expect(problems).toEqual([]);
    expect(peerImports.get(file)).toEqual(new Set(["optional"]));
  });

  it("still requires explicit relative specifiers that name a declaration", () => {
    expect(check(`export * from "./bare";`).problems).toEqual([
      `dts/index.d.ts: "./bare" has no extension`,
    ]);
    const missing = checkImports(
      manifest,
      new Map([[file, `export * from "./gone.js";`]]),
      () => false,
    );
    expect(missing.problems).toEqual([
      `dts/index.d.ts: "./gone.js" names no emitted declaration`,
    ]);
  });

  it("records relative and self-referencing imports as edges", () => {
    const { edges } = check(
      `export * from "./a.js";\nexport type T = import("./b/index.js").T;`,
    );
    expect(edges.get(file)).toEqual(
      new Set([resolve(ROOT, "dts/a.d.ts"), resolve(ROOT, "dts/b/index.d.ts")]),
    );
  });
});

describe("rewrite, on the parsed specifiers", () => {
  it("rewrites real relative imports and leaves look-alikes in comments and types alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-common-dts-"));
    try {
      await writeFile(join(dir, "b.d.ts"), "export type B = 1;\n");
      const text = [
        `/** Unlike the one re-exported from "./b", this one is local. */`,
        `export * from "./b";`,
        `export type Q = Pick<{ from: 1; to: 2 }, "from" | "to">;`,
        `export type R = "from" extends "./b" ? 1 : 2;`,
        `export type T = import("./b").B;`,
        ``,
      ].join("\n");
      await writeFile(join(dir, "index.d.ts"), text);
      expect(await rewrite(dir)).toBe(2);
      expect(await readFile(join(dir, "index.d.ts"), "utf8")).toBe(
        text
          .replace(`export * from "./b";`, `export * from "./b.js";`)
          .replace(`import("./b")`, `import("./b.js")`),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("build-declarations copies", () => {
  // CLAUDE.md, "Packaging types": the recipe's script is copied unchanged into
  // every published package. A fix made to one copy must reach all of them.
  it("is byte-identical in every published package", async () => {
    const mine = await readFile(
      join(ROOT, "scripts/build-declarations.ts"),
      "utf8",
    );
    for (const pkg of ["bun-nest", "bun-jobs", "bun-jobs-ui"]) {
      const theirs = await readFile(
        join(ROOT, "..", pkg, "scripts/build-declarations.ts"),
        "utf8",
      );
      expect({ pkg, same: theirs === mine }).toEqual({ pkg, same: true });
    }
  });
});
