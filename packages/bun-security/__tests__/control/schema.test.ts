/**
 * The management API's schema builder: each schema validates as a
 * Standard Schema, carries its JSON Schema, refuses unknown keys, and
 * reads a query's strings.
 */
import { describe, expect, it } from "bun:test";
import { toJsonSchema } from "@kingsleyweb/bun-common";
import { s } from "../../lib/control/schema";

/** Validates synchronously. */
const run = (
  schema: { "~standard": { validate: (v: unknown) => unknown } },
  value: unknown,
) =>
  schema["~standard"].validate(value) as {
    value?: unknown;
    issues?: { message: string; path: unknown[] }[];
  };

describe("the schema builder", () => {
  const Thing = s.object({
    id: s.string({ min: 1, max: 8, pattern: /^[a-z]+$/ }),
    count: s.int({ min: 0, max: 10 }),
    tags: s.optional(s.array(s.enum(["a", "b"]), 2)),
    parent: s.nullable(s.string()),
  });

  it("accepts a good value and reports every issue with its path", () => {
    expect(run(Thing, { id: "abc", count: 3, parent: null })).toEqual({
      value: { id: "abc", count: 3, parent: null },
    });
    const bad = run(Thing, { id: "ABC", count: 11, tags: ["c"], extra: 1 });
    expect(bad.issues?.map((issue) => issue.path)).toEqual([
      ["extra"],
      ["id"],
      ["count"],
      ["tags", 0],
      ["parent"],
    ]);
  });

  it("documents itself as JSON Schema, readable by bun-common", () => {
    expect(toJsonSchema(Thing)).toMatchObject({
      type: "object",
      required: ["id", "count", "parent"],
      additionalProperties: false,
      properties: { count: { type: "integer", minimum: 0, maximum: 10 } },
    });
  });

  it("reads a query's strings as numbers, booleans and lists", () => {
    const Query = s.query({
      limit: s.optional(s.int({ min: 1 })),
      on: s.optional(s.boolean()),
      ids: s.optional(s.array(s.string())),
    });
    expect(run(Query, { limit: "5", on: "true", ids: "a,b" })).toEqual({
      value: { limit: 5, on: true, ids: ["a", "b"] },
    });
    expect(run(Query, { limit: "x" }).issues?.[0]?.path).toEqual(["limit"]);
  });
});
