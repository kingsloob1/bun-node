/**
 * `liftComponents` (plan §4.4): `$defs` lifted into components with the refs
 * rewritten, `$schema` stripped, a self-recursive `$ref: "#"` rewritten to
 * the root's component (its dangling ref the direct test of the recursion
 * hazard), identity-based dedup (structurally-equal distinct objects never
 * merge), name collisions warned about, and two calls deep-equal.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ConversionWarning, JsonSchemaLike } from "../../lib/docs/index";
import { liftComponents, toJsonSchema } from "../../lib/docs/index";

const Ajv = (await import("ajv/dist/2020").catch(() => undefined))?.default;

/** Every `$ref` in `document` that does not resolve inside it. */
function danglingRefs(document: JsonSchemaLike): string[] {
  const resolve = (ref: string): boolean => {
    if (!ref.startsWith("#/")) return ref === "#";
    let node: unknown = document;
    for (const segment of ref
      .slice(2)
      .split("/")
      .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"))) {
      if (typeof node !== "object" || node === null) return false;
      node = (node as Record<string, unknown>)[segment];
    }
    return node !== undefined;
  };
  const dangling: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && !resolve(value)) {
        dangling.push(value);
      }
      walk(value);
    }
  };
  walk(document);
  return dangling;
}

/** The document a lift describes: the schema and its components together, in an OpenAPI-shaped `components.schemas`. */
function documentOf(lifted: {
  schema: JsonSchemaLike;
  components: Record<string, JsonSchemaLike>;
}): JsonSchemaLike {
  return { ...lifted.schema, components: { schemas: lifted.components } };
}

/** A self-recursive zod schema (measured: its conversion refs `$ref: "#"`, §4.4.2). */
function recursiveCategory(): z.ZodType {
  const category: z.ZodType = z.object({
    name: z.string(),
    get sub(): z.ZodType {
      return z.array(category).optional();
    },
  });
  return category;
}

describe("liftComponents: self-recursion (§4.4.2)", () => {
  it("lifts the root and rewrites the self-ref, leaving no dangling ref", () => {
    const converted = toJsonSchema(recursiveCategory());
    // The hazard itself: the raw conversion carries the root-relative ref.
    expect(JSON.stringify(converted)).toContain('"$ref":"#"');
    const lifted = liftComponents(converted, { name: "Category" });
    expect(lifted.schema).toEqual({ $ref: "#/components/schemas/Category" });
    const document = documentOf(lifted);
    expect(danglingRefs(document)).toEqual([]);
    expect(lifted.components.Category).toMatchObject({
      type: "object",
      properties: {
        sub: {
          type: "array",
          items: { $ref: "#/components/schemas/Category" },
        },
      },
    });
  });

  it("round-trips through ajv: the lifted recursion validates", () => {
    if (Ajv === undefined) return; // §9.1's escape hatch: skip visibly, never fail
    const lifted = liftComponents(toJsonSchema(recursiveCategory()), {
      name: "Category",
    });
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(documentOf(lifted));
    expect(
      validate({
        name: "root",
        sub: [{ name: "leaf" }, { name: "branch", sub: [] }],
      }),
    ).toBe(true);
    expect(validate({ name: "root", sub: [{ name: 42 }] })).toBe(false);
    expect(validate({ name: "root", sub: [{}] })).toBe(false);
  });

  it("a meta({ id }) recursion arrives through $defs and needs no root lift", () => {
    const inner: z.ZodType = z.object({
      name: z.string(),
      get sub(): z.ZodType {
        return z.array(inner).optional();
      },
    });
    const converted = toJsonSchema(
      z.object({ category: inner.meta({ id: "CategoryTree" }) }),
    );
    const lifted = liftComponents(converted);
    expect(lifted.schema).toMatchObject({
      type: "object",
      properties: {
        category: { $ref: "#/components/schemas/CategoryTree" },
      },
    });
    // Measured (zod 4.6.1): the optional array wrapping the recursion is an
    // anonymous `__schema0`, renamed on the way in; the named id keeps its
    // name. The recursion resolves through the renamed component.
    expect(lifted.components.CategoryTree).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        sub: { $ref: "#/components/schemas/Schema1" },
      },
    });
    expect(lifted.components.Schema1).toMatchObject({
      type: "array",
      items: {
        type: "object",
        properties: { sub: { $ref: "#/components/schemas/Schema1" } },
      },
    });
    expect(danglingRefs(documentOf(lifted))).toEqual([]);
    if (Ajv !== undefined) {
      const ajv = new Ajv({ strict: false, allErrors: true });
      const validate = ajv.compile(documentOf(lifted));
      expect(validate({ category: { name: "a", sub: [{ name: "b" }] } })).toBe(
        true,
      );
      expect(validate({ category: { name: "a", sub: [{ name: 1 }] } })).toBe(
        false,
      );
    }
  });
});

describe("liftComponents: $defs, identity dedup and collisions (§4.4.1, §4.4.3)", () => {
  it("renames zod's anonymous __schemaN and warns", () => {
    const shared = z.object({ s: z.string() });
    // `reused: "ref"` names the shared schema __schema0 (measured, zod 4.6.1).
    const converted = z
      .object({ a: shared, b: shared })
      .toJSONSchema({ io: "input", reused: "ref" }) as JsonSchemaLike;
    const warnings: ConversionWarning[] = [];
    const lifted = liftComponents(converted, {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(lifted.schema).toEqual({
      type: "object",
      properties: {
        a: { $ref: "#/components/schemas/Schema1" },
        b: { $ref: "#/components/schemas/Schema1" },
      },
      required: ["a", "b"],
    });
    expect(lifted.components).toEqual({
      Schema1: {
        type: "object",
        properties: { s: { type: "string" } },
        required: ["s"],
      },
    });
    expect(warnings.map((w) => w.message)).toEqual([
      'the anonymous component "__schema0" was renamed "Schema1"',
    ]);
    expect(danglingRefs(documentOf(lifted))).toEqual([]);
  });

  it("dedups by identity: one object at two positions shares one component", () => {
    // bun-jobs' `s` inlines a nested schema by identity — the same object at
    // both positions is the sharing the author wrote.
    const member = Object.freeze({
      type: "object",
      properties: { id: { type: "string" } },
    });
    const lifted = liftComponents({
      type: "object",
      properties: { first: member, second: member },
    });
    expect(Object.keys(lifted.components)).toEqual(["Schema1"]);
    expect(lifted.schema.properties).toEqual({
      first: { $ref: "#/components/schemas/Schema1" },
      second: { $ref: "#/components/schemas/Schema1" },
    });
  });

  it("never merges structurally equal but distinct objects", () => {
    const one = { type: "string" };
    const two = { type: "string" };
    const lifted = liftComponents({
      type: "object",
      properties: { one, two },
    });
    expect(lifted.components).toEqual({});
    expect(lifted.schema).toEqual({
      type: "object",
      properties: { one: { type: "string" }, two: { type: "string" } },
    });
  });

  it("warns and disambiguates when the root's name is taken", () => {
    const warnings: ConversionWarning[] = [];
    const lifted = liftComponents(
      {
        type: "object",
        properties: { self: { $ref: "#" } },
        $defs: { Category: { type: "string" } },
      },
      { name: "Category", onWarning: (warning) => warnings.push(warning) },
    );
    // The root cannot take "Category" — the $defs entry has it — so it lifts
    // as a disambiguated name, with a warning.
    expect(lifted.schema).toEqual({ $ref: "#/components/schemas/Category1" });
    expect(Object.keys(lifted.components).sort()).toEqual([
      "Category",
      "Category1",
    ]);
    expect(
      warnings.some((w) => w.message.includes('"Category" was taken')),
    ).toBe(true);
    expect(danglingRefs(documentOf(lifted))).toEqual([]);
  });

  it("strips $schema everywhere and does not mutate its input", () => {
    const converted = toJsonSchema(z.object({ a: z.string() }));
    expect(converted.$schema).toBeDefined();
    const before = structuredClone(converted);
    const lifted = liftComponents(converted);
    expect(lifted.schema.$schema).toBeUndefined();
    expect(JSON.stringify(lifted)).not.toContain("$schema");
    expect(converted).toEqual(before);
  });

  it("is deterministic: two calls deep-equal", () => {
    const make = (): JsonSchemaLike =>
      toJsonSchema(
        z.object({
          a: z.object({ s: z.string() }),
          b: z.number().default(2),
        }),
      );
    expect(liftComponents(make())).toEqual(liftComponents(make()));
    const recursive = toJsonSchema(recursiveCategory());
    expect(liftComponents(recursive, { name: "Category" })).toEqual(
      liftComponents(recursive, { name: "Category" }),
    );
  });

  it("passes a schema with nothing to lift through, minus $schema", () => {
    const lifted = liftComponents({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
    });
    expect(lifted).toEqual({ schema: { type: "string" }, components: {} });
  });
});
