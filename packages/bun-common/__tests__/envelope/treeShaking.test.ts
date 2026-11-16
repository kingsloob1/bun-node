/**
 * Tree shaking of the envelope entry (PR-P4): a browser app that imports one
 * small export of `./envelope` gets that export, not the signing.
 *
 * Every top-level statement of `lib/envelope/` is module-local (constants,
 * a frozen object, a `Map`), so the envelope shakes with or without the
 * package's `sideEffects` field (measured 2026-11-16: `subtleHmacSha256`
 * alone 492 bytes minified either way, the whole entry 5,416), and removing
 * the field is no control here (the package-wide `treeShaking.test.ts` has
 * those). The negative control plants a side effect instead: a copy of the
 * envelope whose `signing.ts` assigns `signEnvelope` to a global at load,
 * which drags the signing and its checks into the same one-export app.
 * Bytes are a correctness check here, not a benchmark.
 */
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

const LIB = resolve(import.meta.dir, "../../lib");

/** The most the one-export app may weigh, minified. */
const BOUND = 1024;

/** Text from the signing module, which the MAC does not need. */
const UNRELATED = "direction must be";

const WORK = mkdtempSync(join(tmpdir(), "bun-common-envelope-shake-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

/** Bundles a one-export app over the envelope at `lib`, minified for a browser. */
async function bundle(lib: string): Promise<string> {
  const app = join(WORK, `app-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    app,
    `import { subtleHmacSha256 } from "${join(lib, "envelope/index.ts")}";\nexport const mac = subtleHmacSha256;\n`,
  );
  const result = await Bun.build({
    entrypoints: [app],
    target: "browser",
    format: "esm",
    minify: true,
  });
  expect(result.success).toBe(true);
  return (await Promise.all(result.outputs.map((o) => o.text()))).join("\n");
}

/** What is wrong with a bundle: too heavy, or carrying the signing. */
function problems(code: string): string[] {
  const found: string[] = [];
  if (code.length > BOUND) found.push(`${code.length} bytes, over ${BOUND}`);
  if (code.includes(UNRELATED)) found.push(`contains ${UNRELATED}`);
  return found;
}

describe("one export of ./envelope in a browser bundle", () => {
  it("subtleHmacSha256 weighs the MAC, not the signing", async () => {
    expect(problems(await bundle(LIB))).toEqual([]);
  });

  it("negative control: a side effect planted in signing.ts fails the check", async () => {
    const copy = join(WORK, "planted");
    cpSync(join(LIB, "envelope"), join(copy, "envelope"), { recursive: true });
    cpSync(join(LIB, "errors.ts"), join(copy, "errors.ts"));
    const signing = join(copy, "envelope/signing.ts");
    writeFileSync(
      signing,
      `${readFileSync(signing, "utf8")}\n(globalThis as Record<string, unknown>).planted = signEnvelope;\n`,
    );
    expect(problems(await bundle(copy))).toEqual([
      expect.stringMatching(/bytes, over/),
      `contains ${UNRELATED}`,
    ]);
  });
});
