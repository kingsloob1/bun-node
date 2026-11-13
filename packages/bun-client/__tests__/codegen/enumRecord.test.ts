/**
 * A record over an enum (#780): zod 4 writes `z.record(z.enum([...]), V)`
 * as an object with `propertyNames` (the enum), `additionalProperties` (V)
 * and `required` (every key). The generated types gave each key `unknown`
 * plus an `unknown` index signature; the zod module checked
 * `z.record(z.string(), V)`, any key and none required.
 *
 * - the route types: exactly the listed keys, each typed by
 *   `additionalProperties`, required as `required` says, no index signature;
 * - the zod module, both flavours, imported and run: the values are
 *   checked, and so are the required keys (control: a well-formed value
 *   passes, and a partial record's keys may be missing);
 * - a `propertyNames` reached through `$ref`.
 *
 * The keyword-level cases (patterns, `const`, a closed object) are in
 * `schema.test.ts`.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateRoutes } from "../../lib/codegen/index";

/** The issue's document: what `z.toJSONSchema` writes for the record, under a response. */
function statsDocument(
  byStatus: Record<string, unknown>,
  components: Record<string, unknown> = {},
): object {
  return {
    openapi: "3.1.0",
    info: { title: "repro", version: "1" },
    paths: {
      "/stats": {
        get: {
          operationId: "stats",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { byStatus },
                    required: ["byStatus"],
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: components },
  };
}

/** `z.record(z.enum(["pending", "failed"]), z.int())`, as zod 4 writes it. */
const EXHAUSTIVE = {
  type: "object",
  propertyNames: { type: "string", enum: ["pending", "failed"] },
  additionalProperties: { type: "integer" },
  required: ["pending", "failed"],
};

/** `z.partialRecord(…)`: the same keys, none required. */
const PARTIAL = {
  type: "object",
  propertyNames: { type: "string", enum: ["pending", "failed"] },
  additionalProperties: { type: "integer" },
};

/** The `byStatus` member of a generated route module, whitespace collapsed. */
function byStatusType(code: string): string {
  const start = code.indexOf("byStatus");
  const end = code.indexOf("}", start);
  return code.slice(start, end + 1).replaceAll(/\s+/g, " ");
}

let dir: string;
beforeAll(async () => {
  // Inside the package, so the generated module resolves `zod` and
  // `@kingsleyweb/bun-client/zod` as an app's would.
  dir = await mkdtemp(join(import.meta.dir, "tmp-enum-record-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Writes the route and zod modules for `document` and imports the zod one: the 200 response's schema. */
async function responseSchema(
  document: object,
  flavour: "mini" | "classic",
  name: string,
): Promise<StandardSchemaV1> {
  const result = generateRoutes(document, {
    zod: { flavour, routesModule: `./${name}.gen` },
  });
  await writeFile(join(dir, `${name}.gen.ts`), result.code);
  await writeFile(join(dir, `${name}.zod.gen.ts`), result.zod!.code);
  const mod = (await import(join(dir, `${name}.zod.gen.ts`))) as {
    schemas: Record<
      string,
      { responses: Record<number, StandardSchemaV1 | null> }
    >;
  };
  return mod.schemas["GET /stats"]!.responses[200]!;
}

/** Whether `schema` accepts `value` (zod's are synchronous). */
function accepts(schema: StandardSchemaV1, value: unknown): boolean {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("expected a sync schema");
  return result.issues === undefined;
}

describe("a record over an enum (#780)", () => {
  it("types exactly the listed keys by additionalProperties, with no index signature", () => {
    const { code } = generateRoutes(statsDocument(EXHAUSTIVE));
    expect(byStatusType(code)).toBe(
      "byStatus: { pending: number; failed: number; }",
    );
    const partial = generateRoutes(statsDocument(PARTIAL)).code;
    expect(byStatusType(partial)).toBe(
      "byStatus: { pending?: number; failed?: number; }",
    );
  });

  it("reads a propertyNames reached through $ref", () => {
    const { code } = generateRoutes(
      statsDocument(
        {
          type: "object",
          propertyNames: { $ref: "#/components/schemas/Status" },
          additionalProperties: { type: "integer" },
          required: ["pending", "failed"],
        },
        { Status: { type: "string", enum: ["pending", "failed"] } },
      ),
    );
    expect(byStatusType(code)).toBe(
      "byStatus: { pending: number; failed: number; }",
    );
  });

  it.each(["mini", "classic"] as const)(
    "writes zod that checks the values and the required keys (%s)",
    async (flavour) => {
      const exhaustive = await responseSchema(
        statsDocument(EXHAUSTIVE),
        flavour,
        `exhaustive-${flavour}`,
      );
      // Control: the well-formed value passes.
      expect(accepts(exhaustive, { byStatus: { pending: 1, failed: 2 } })).toBe(
        true,
      );
      expect(
        accepts(exhaustive, { byStatus: { pending: "1", failed: 2 } }),
      ).toBe(false);
      expect(accepts(exhaustive, { byStatus: { pending: 1 } })).toBe(false);
      // Loose, as every generated object: the server owns unknown keys.
      expect(
        accepts(exhaustive, { byStatus: { pending: 1, failed: 2, later: 3 } }),
      ).toBe(true);

      const partial = await responseSchema(
        statsDocument(PARTIAL),
        flavour,
        `partial-${flavour}`,
      );
      expect(accepts(partial, { byStatus: {} })).toBe(true);
      expect(accepts(partial, { byStatus: { failed: 2 } })).toBe(true);
      expect(accepts(partial, { byStatus: { failed: 2.5 } })).toBe(false);
    },
  );
});
