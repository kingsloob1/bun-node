import { join, relative } from "node:path";
import { Glob } from "bun";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

/**
 * Nothing under `lib/` uses `EventSource` (`remote-transports.md` §2, §7.4).
 * `bun-types` declares the global, so code using it typechecks, but Bun
 * does not implement it: it throws at runtime. Event streams are read with
 * `lib/remote/protocol/sse.ts` over `fetch`.
 *
 * The scan reads code, not text: identifiers, property names and string
 * literals, via the TypeScript parser. A comment explaining why
 * `EventSource` is avoided (`sse.ts` has one) is prose, and a guard that
 * fired on prose would be routed around.
 */

const LIB = new URL("../../lib/", import.meta.url).pathname;

/** Every place a source text names `EventSource` in code, as `line:column`. */
function eventSourceUses(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const named =
      ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
        node.text === "EventSource") ||
      ((ts.isStringLiteralLike(node) || ts.isTemplateLiteral(node)) &&
        node.getText(source).includes("EventSource"));
    if (named) {
      const { line, character } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      found.push(`${line + 1}:${character + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("EventSource is banned from lib/", () => {
  it("no file under lib/ names it in code", async () => {
    const files = await Array.fromAsync(
      new Glob("**/*.{ts,tsx,mts,cts,js,mjs}").scan({ cwd: LIB }),
    );
    expect(files.length).toBeGreaterThan(100);
    const uses: string[] = [];
    let parsed = 0;
    for (const file of files) {
      const text = await Bun.file(join(LIB, file)).text();
      // Only a file with the word in it can name it, so only those are parsed.
      if (!text.includes("EventSource")) {
        continue;
      }
      parsed++;
      for (const at of eventSourceUses(file, text)) {
        uses.push(`${relative(LIB, join(LIB, file))}:${at}`);
      }
    }
    expect(uses).toEqual([]);
    // sse.ts mentions it in prose, so the parse does run.
    expect(parsed).toBeGreaterThanOrEqual(1);
  });

  it("the SSE parser explains the ban in prose, which the scan allows", async () => {
    const text = await Bun.file(join(LIB, "remote/protocol/sse.ts")).text();
    expect(text).toContain("EventSource");
    expect(eventSourceUses("sse.ts", text)).toEqual([]);
  });

  it("finds every way code can reach it (the control)", () => {
    const uses = (code: string) => eventSourceUses("probe.ts", code);
    expect(uses("const s = new EventSource(url);")).toHaveLength(1);
    expect(uses("const s = new globalThis.EventSource(url);")).toHaveLength(1);
    expect(uses('const S = globalThis["EventSource"];')).toHaveLength(1);
    expect(uses("const S = globalThis[`EventSource`];")).toHaveLength(1);
    expect(uses("let s: EventSource | undefined;")).toHaveLength(1);
    expect(uses("const { EventSource: S } = globalThis;")).toHaveLength(1);
    expect(uses('if ("EventSource" in globalThis) {}')).toHaveLength(1);
    // And not prose.
    expect(uses("// EventSource\n/** EventSource */ const x = 1;")).toEqual([]);
  });
});
