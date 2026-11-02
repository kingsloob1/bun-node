/**
 * The generator's `documentsHash` is a copy of bun-common's `typesHash`
 * (typed-client plan §3.0): the same documents must hash the same in both,
 * or a generated file's header would never match the dev endpoint's `ETag`
 * (PR-M2) and the watcher (PR-C3) would regenerate forever.
 */
import { typesHash } from "@kingsleyweb/bun-common/lib/docs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { documentsHash, loadDocuments } from "../../lib/codegen/index";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("documentsHash agrees with bun-common's typesHash", () => {
  it("on the fixture app's two documents, together and apart", async () => {
    const { openapi, asyncapi } = await loadDocuments({
      module: join(FIXTURES, "app.ts"),
    });
    expect(asyncapi).toBeDefined();
    for (const documents of [
      { openapi },
      { asyncapi: asyncapi! },
      { openapi, asyncapi: asyncapi! },
    ]) {
      expect(documentsHash(documents)).toBe(typesHash(documents as never));
    }
  });

  it("on a hand-written document, whatever its key order", async () => {
    const openapi = (await Bun.file(
      join(FIXTURES, "corpus.openapi.json"),
    ).json()) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(openapi).reverse());
    expect(documentsHash({ openapi: reversed })).toBe(typesHash({ openapi }));
    expect(documentsHash({ openapi })).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when a document does (the negative control)", async () => {
    const openapi = (await Bun.file(
      join(FIXTURES, "corpus.openapi.json"),
    ).json()) as Record<string, unknown>;
    const changed = {
      ...openapi,
      info: { title: "Generator corpus", version: "1.0.1" },
    };
    expect(documentsHash({ openapi: changed })).not.toBe(
      documentsHash({ openapi }),
    );
  });
});
