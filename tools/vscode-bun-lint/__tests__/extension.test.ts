// `extension.ts` activated against a fake `vscode` module (helpers/fakeVscode)
// with the real `bun` behind it: what VS Code would get from the extension's
// providers, without an extension host. The documents are virtual buffers on
// real paths, so the repository's config applies.
import type {
  CodeAction,
  Diagnostic,
  FakeDocument as Doc,
  TextEdit,
} from "./helpers/fakeVscode";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  CodeActionKind,
  createFakeVscode,
  FakeDocument,
  neverCancelled,
  Range,
  until,
} from "./helpers/fakeVscode";

const REPO = join(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "vscode-bun-lint-ext-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let env = createFakeVscode({ documents: [], workspace: REPO });

/**
 * A namespace of the fake that always reads the current test's instance.
 * @param key The namespace.
 * @returns A forwarding proxy.
 */
function forward(
  key: "window" | "workspace" | "languages" | "commands",
): object {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        (env.vscode[key] as Record<string | symbol, unknown>)[prop],
    },
  );
}

await mock.module("vscode", () => ({
  ...env.vscode,
  window: forward("window"),
  workspace: forward("workspace"),
  languages: forward("languages"),
  commands: forward("commands"),
}));

const ext = await import("../src/extension");

const SOURCE = [
  "var b = 1;",
  "export const c = b + 1;",
  "export async function f(): Promise<void> { Promise.resolve(1); await Promise.resolve(); }",
  "",
].join("\n");

/**
 * Activates the extension on some documents.
 * @param documents The open documents.
 * @param config `bunLint.*` settings, without the prefix.
 * @returns The fake's record.
 */
function activate(documents: Doc[], config: Record<string, unknown> = {}) {
  env = createFakeVscode({
    documents,
    workspace: REPO,
    config: { bunPath: process.execPath, ...config },
  });
  ext.activate({ subscriptions: env.record.subscriptions } as never);
  return env.record;
}

/**
 * @param record The fake's record.
 * @param doc A document.
 * @returns Its diagnostics, once set.
 */
async function diagnosticsOf(
  record: ReturnType<typeof activate>,
  doc: Doc,
): Promise<Diagnostic[]> {
  await until(() => record.diagnostics.has(doc.uri.toString()));
  return record.diagnostics.get(doc.uri.toString())!;
}

let doc: Doc;
beforeEach(() => {
  doc = new FakeDocument(
    join(REPO, "packages/bun-common/lib/__probe_extension__.ts"),
    SOURCE,
    "typescript",
  );
});

describe("activation", () => {
  test("registers the commands and the providers for the right languages", () => {
    const record = activate([]);
    expect([...record.commands.keys()].sort()).toEqual([
      "bunLint.explainRule",
      "bunLint.fixAll",
      "bunLint.lintActive",
      "bunLint.showOutput",
    ]);
    expect(
      record.codeActionProviders[0].selector.map((s) => s.language),
    ).toEqual(ext.LINT_LANGUAGES);
    const formatted = record.formatProviders[0].selector.map((s) => s.language);
    expect(formatted).toEqual(ext.FORMAT_LANGUAGES);
    expect(formatted).toContain("typescriptreact");
    expect(formatted).not.toContain("markdown");
    expect(
      record.rangeFormatProviders[0].selector.map((s) => s.language),
    ).toEqual(formatted);
    expect(record.contentProviders.has(ext.EXPLAIN_SCHEME)).toBe(true);
  });
});

describe("diagnostics", () => {
  test("an open document gets bun lint's problems, with the rule linking to --explain", async () => {
    const record = activate([doc]);
    const ds = await diagnosticsOf(record, doc);
    const summary = ds.map((d) => [
      typeof d.code === "object" ? d.code.value : d.code,
      d.range.start.line,
      d.range.start.character,
      d.range.end.line,
      d.range.end.character,
      d.severity,
      d.source,
    ]);
    expect(summary).toEqual([
      ["no-var", 0, 0, 0, 10, 0, "bun lint"],
      ["@typescript-eslint/no-floating-promises", 2, 43, 2, 62, 0, "bun lint"],
    ]);
    const code = ds[0].code as { target: { scheme: string; path: string } };
    expect([code.target.scheme, code.target.path]).toEqual([
      ext.EXPLAIN_SCHEME,
      "/no-var",
    ]);
    expect(record.errors).toEqual([]);
  });

  test("a change is linted again after the debounce", async () => {
    const record = activate([doc], { debounceMs: 0 });
    await diagnosticsOf(record, doc);
    doc.text = "export const ok = 1;\n";
    doc.version++;
    for (const l of record.listeners.change)
      l({ document: doc, contentChanges: [{}] });
    await until(() => record.diagnostics.get(doc.uri.toString())!.length === 0);
  });

  test("closing a document clears its diagnostics", async () => {
    const record = activate([doc]);
    await diagnosticsOf(record, doc);
    for (const l of record.listeners.close) l(doc);
    expect(record.diagnostics.has(doc.uri.toString())).toBe(false);
  });

  test("a file under no bunfig.toml [lint] is left alone (bunLint.requireConfig)", async () => {
    const outside = new FakeDocument(
      join(scratch, "x.ts"),
      "var a = 1;\n",
      "typescript",
    );
    const record = activate([outside, doc]);
    await diagnosticsOf(record, doc);
    expect(record.diagnostics.has(outside.uri.toString())).toBe(false);
  });

  test("a Bun below the floor: one notification, no diagnostics", async () => {
    const old = join(scratch, "bun-1.4.3");
    writeFileSync(old, "#!/bin/sh\necho 1.4.3\n");
    chmodSync(old, 0o755);
    const other = new FakeDocument(
      join(REPO, "packages/bun-nest/lib/__probe__.ts"),
      SOURCE,
      "typescript",
    );
    const record = activate([doc, other], { bunPath: old });
    await until(() => record.errors.length > 0);
    await Bun.sleep(200);
    expect(record.errors).toHaveLength(1);
    expect(record.errors[0]).toContain('Bun 1.4.3 has no "bun lint"');
    expect(record.diagnostics.size).toBe(0);
  });
});

describe("code actions", () => {
  /**
   * @param record The fake's record.
   * @param ds The diagnostics to ask about.
   * @param only The kind asked for.
   * @returns The actions.
   */
  function actions(
    record: ReturnType<typeof activate>,
    ds: Diagnostic[],
    only?: CodeActionKind,
  ): Promise<CodeAction[]> {
    return record.codeActionProviders[0].provider.provideCodeActions(
      doc,
      new Range(0, 0, 0, 0),
      { diagnostics: ds, only },
    );
  }

  test("a fix, the documentation and Fix all for a fixable problem", async () => {
    const record = activate([doc]);
    const ds = await diagnosticsOf(record, doc);
    const got = await actions(record, [ds[0]]);
    expect(got.map((a) => a.title)).toEqual([
      "Fix this no-var problem",
      "Show documentation for no-var",
      "Fix all auto-fixable problems in this file (1)",
    ]);
    expect(got[0].isPreferred).toBe(true);
    expect(
      got[0].edit!.edits.map((e) => [
        e.range.start.line,
        e.range.start.character,
        e.range.end.character,
        e.text,
      ]),
    ).toEqual([[0, 0, 3, "let"]]);
    expect(got[1].command).toEqual({
      title: "Show documentation for no-var",
      command: "bunLint.explainRule",
      arguments: ["no-var"],
    });
  });

  test("each suggestion is its own quick fix", async () => {
    const record = activate([doc]);
    const ds = await diagnosticsOf(record, doc);
    const got = await actions(record, [ds[1]]);
    expect(got.map((a) => a.title)).toEqual([
      "Add void operator to ignore. (@typescript-eslint/no-floating-promises)",
      "Add await operator. (@typescript-eslint/no-floating-promises)",
      "Show documentation for @typescript-eslint/no-floating-promises",
      // The file has a fixable problem elsewhere (no-var).
      "Fix all auto-fixable problems in this file (1)",
    ]);
    expect(
      got[1].edit!.edits.map((e) => [
        e.range.start.line,
        e.range.start.character,
        e.text,
      ]),
    ).toEqual([[2, 43, "await "]]);
  });

  test("nothing for a document edited since its last lint", async () => {
    const record = activate([doc], { run: "onSave" });
    const ds = await diagnosticsOf(record, doc);
    doc.version++;
    expect(await actions(record, ds)).toEqual([]);
  });

  test("source.fixAll (editor.codeActionsOnSave) applies the fixes", async () => {
    const record = activate([doc]);
    await diagnosticsOf(record, doc);
    const [fixAll] = await actions(record, [], CodeActionKind.SourceFixAll);
    expect(fixAll.kind.value).toBe(ext.FIX_ALL_KIND);
    doc.apply(fixAll.edit!.edits);
    expect(doc.text.split("\n")[0]).toBe("let b = 1;");
  });

  test("the Fix all command edits the active document", async () => {
    const record = activate([doc]);
    await diagnosticsOf(record, doc);
    await record.commands.get("bunLint.fixAll")!();
    expect(doc.text.startsWith("let b = 1;\n")).toBe(true);
  });
});

describe("formatting", () => {
  test("Format Document and Format Selection return bun fmt's edit", async () => {
    const text = "const a = {b:1,   c:2}\nconst z = {b:1,   c:2}\n";
    const fdoc = new FakeDocument(
      join(REPO, "packages/bun-common/lib/__probe_format__.ts"),
      text,
      "typescript",
    );
    const record = activate([]);
    const whole: TextEdit[] =
      await record.formatProviders[0].provider.provideDocumentFormattingEdits(
        fdoc,
        {},
        neverCancelled,
      );
    fdoc.apply(whole.map((e) => ({ range: e.range, text: e.newText })));
    expect(fdoc.text).toBe(
      "const a = { b: 1, c: 2 };\nconst z = { b: 1, c: 2 };\n",
    );

    const sdoc = new FakeDocument(fdoc.fileName, text, "typescript");
    const range: TextEdit[] =
      await record.rangeFormatProviders[0].provider.provideDocumentRangeFormattingEdits(
        sdoc,
        new Range(1, 0, 1, 1),
        {},
        neverCancelled,
      );
    sdoc.apply(range.map((e) => ({ range: e.range, text: e.newText })));
    expect(sdoc.text).toBe(
      "const a = {b:1,   c:2}\nconst z = { b: 1, c: 2 };\n",
    );
  });

  test("a syntax error formats nothing and raises no notification", async () => {
    const bad = new FakeDocument(
      join(REPO, "packages/bun-common/lib/__probe_format__.ts"),
      "const a = {\n",
      "typescript",
    );
    const record = activate([]);
    expect(
      await record.formatProviders[0].provider.provideDocumentFormattingEdits(
        bad,
        {},
        neverCancelled,
      ),
    ).toEqual([]);
    expect(record.errors).toEqual([]);
    expect(record.output.some((l) => l.includes("'}' expected"))).toBe(true);
  });
});

describe("rule documentation", () => {
  test("the explain URI serves bun lint --explain", async () => {
    const record = activate([]);
    const page = await record.contentProviders
      .get(ext.EXPLAIN_SCHEME)!
      .provideTextDocumentContent(ext.explainUri("no-var"));
    expect(page).toContain("Require let or const instead of var");
  });
});
