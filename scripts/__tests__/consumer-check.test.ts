import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { bareSpecifiers, scanLeaks } from "../consumer-check";

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
