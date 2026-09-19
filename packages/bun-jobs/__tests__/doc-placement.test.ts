import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

/**
 * Doc comments that belong to a declaration sit directly on it. An editor
 * shows a declaration only the JSDoc block immediately before it, so a doc
 * left above the wrong statement — or a statement slipped in between a doc
 * and what it describes — silently leaves the declaration undocumented and
 * gives its neighbour two descriptions.
 */

const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");

/** The JSDoc blocks directly before each top-level declaration, by name. */
async function docsByName(file: string): Promise<Map<string, string[]>> {
  const text = await Bun.file(join(lib, file)).text();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const docs = new Map<string, string[]>();

  for (const statement of source.statements) {
    const names = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map((declaration) =>
          declaration.name.getText(source),
        )
      : ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)
        ? [statement.name?.getText(source) ?? ""]
        : [];

    const blocks = ts
      .getJSDocCommentsAndTags(statement)
      .filter(ts.isJSDoc)
      .map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? "");

    for (const name of names) {
      docs.set(name, blocks);
    }
  }

  return docs;
}

describe("doc comments sit on their own declarations", () => {
  it("the job route bodies each carry their own doc", async () => {
    const docs = await docsByName("api/schemas/jobs.ts");

    expect(docs.get("FailBodySchema")).toEqual([
      "`POST /queues/:queue/jobs/:id/fail` body.",
    ]);
    expect(docs.get("RetryBodySchema")).toEqual([
      "`POST /queues/:queue/jobs/:id/retry` body.",
    ]);
  });

  it("the worker class keeps its doc, and the flag cache constant has its own", async () => {
    const docs = await docsByName("queue/BunQueueWorker.ts");

    const worker = docs.get("BunQueueWorker");
    expect(worker).toHaveLength(1);
    expect(worker![0]).toStartWith("The consumer side of a queue.");

    const cache = docs.get("REPEAT_FLAG_CACHE_MS");
    expect(cache).toHaveLength(1);
    expect(cache![0]).toStartWith("How long a worker trusts");

    const sameError = docs.get("sameError");
    expect(sameError).toHaveLength(1);
    expect(sameError![0]).toStartWith("Whether a stored failure");
  });
});
