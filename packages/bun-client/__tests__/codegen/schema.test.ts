/**
 * JSON Schema to TypeScript (typed-client plan §3.2, §5.3): one row per
 * mapping the README's table documents, printed as the generated file
 * prints it, and the warnings for what TypeScript cannot say.
 */
import { describe, expect, it } from "bun:test";
import { printDoc } from "../../lib/codegen/doc";
import { printType } from "../../lib/codegen/print";
import { schemaToType } from "../../lib/codegen/schema";

/** Converts `schema` in a document with components `User` and `Node`, printed, plus the warnings. */
function convert(schema: unknown): { type: string; warnings: string[] } {
  const warnings: string[] = [];
  const document = {
    components: {
      schemas: {
        User: { type: "object" },
        Node: {
          type: "object",
          properties: { next: { $ref: "#/components/schemas/Node" } },
        },
      },
    },
    defs: { name: { type: "string" }, loop: { $ref: "#/defs/loop" } },
  };
  const type = schemaToType(
    schema,
    {
      document,
      componentType: (name) =>
        name in document.components.schemas ? name : undefined,
      warn: (at, message) => warnings.push(`${at}: ${message}`),
    },
    "here",
  );
  return { type: printDoc(printType(type)), warnings };
}

/** The printed type alone, asserting no warning. */
function typeOf(schema: unknown): string {
  const { type, warnings } = convert(schema);
  expect(warnings).toEqual([]);
  return type;
}

describe("keywords that make a type", () => {
  it.each([
    [{ type: "string" }, "string"],
    [
      { type: "string", format: "date-time", minLength: 1, pattern: "^x" },
      "string",
    ],
    [{ type: "integer", minimum: 0 }, "number"],
    [{ type: "number" }, "number"],
    [{ type: "boolean" }, "boolean"],
    [{ type: "null" }, "null"],
    [{ type: ["string", "null"] }, "string | null"],
    [{ type: "string", nullable: true }, "string | null"],
    [{ enum: ["a", "b", 1, true, null] }, '"a" | "b" | 1 | true | null'],
    [{ type: "string", enum: ["x"] }, '"x"'],
    [{ const: "on" }, '"on"'],
    [{ const: { a: [1, "b"] } }, '{\n  a: [1, "b"];\n}'],
    [{ $ref: "#/components/schemas/User" }, "User"],
    [{ $ref: "#/defs/name" }, "string"],
    [{ type: "array", items: { type: "string" } }, "string[]"],
    [{ type: "array" }, "unknown[]"],
    [
      { type: "array", items: { type: ["string", "number"] } },
      "(string | number)[]",
    ],
    [
      {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: false,
      },
      "[string, number]",
    ],
    [
      { type: "array", prefixItems: [{ type: "string" }] },
      "[string, ...unknown[]]",
    ],
    [
      { type: "array", items: [{ type: "string" }], additionalItems: false },
      "[string]",
    ],
    [{ type: "object" }, "Record<string, unknown>"],
    [{ type: "object", additionalProperties: false }, "Record<string, never>"],
    [
      { type: "object", additionalProperties: { type: "number" } },
      "Record<string, number>",
    ],
    [{ type: "object", additionalProperties: true }, "Record<string, unknown>"],
    [
      { type: "object", patternProperties: { "^x": { type: "boolean" } } },
      "Record<string, boolean>",
    ],
    [
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a"],
      },
      "{\n  a: string;\n  b?: number;\n}",
    ],
    [
      {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: { type: "number" },
      },
      "{\n  a: string;\n  [key: string]: number | string;\n}",
    ],
    [{ type: "object", required: ["a"] }, "{\n  a: unknown;\n}"],
    [
      { properties: { "a-b": { type: "string", description: "Dashed." } } },
      '{\n  /** Dashed. */\n  "a-b"?: string;\n}',
    ],
    [{ oneOf: [{ type: "string" }, { type: "number" }] }, "string | number"],
    [{ anyOf: [{ type: "string" }, { type: "string" }] }, "string"],
    [
      {
        allOf: [
          { $ref: "#/components/schemas/User" },
          { $ref: "#/components/schemas/Node" },
        ],
      },
      "User & Node",
    ],
    [
      { type: "object", allOf: [{ $ref: "#/components/schemas/User" }] },
      "User",
    ],
    [{ $ref: "#/components/schemas/User", description: "annotated" }, "User"],
    [{ $ref: "#/components/schemas/User", nullable: true }, "User | null"],
    [{}, "unknown"],
    [true, "unknown"],
    [false, "never"],
    [{ not: {} }, "never"],
    [
      {
        type: "string",
        readOnly: true,
        default: "x",
        examples: ["y"],
        title: "T",
      },
      "string",
    ],
  ])("%j is %s", (schema, expected) => {
    expect(typeOf(schema)).toBe(expected);
  });

  it("recurses through a component's name", () => {
    expect(typeOf({ $ref: "#/components/schemas/Node" })).toBe("Node");
  });
});

describe("what TypeScript cannot say: unknown, with a warning", () => {
  it.each([
    [{ not: { type: "string" } }, "`not`"],
    [{ if: { type: "string" }, then: { minLength: 1 } }, "`if`, `then`"],
    [{ type: "object", dependentSchemas: { a: {} } }, "`dependentSchemas`"],
    [
      { type: "object", unevaluatedProperties: false },
      "`unevaluatedProperties`",
    ],
    [{ type: "array", unevaluatedItems: false }, "`unevaluatedItems`"],
    [{ $dynamicRef: "#node" }, "`$dynamicRef`"],
  ])("%j", (schema, names) => {
    expect(convert(schema)).toEqual({
      type: "unknown",
      warnings: [
        `here: ${names} cannot be expressed in TypeScript; typed \`unknown\``,
      ],
    });
  });

  it("an inline recursive pointer, which has no name to recurse through", () => {
    expect(convert({ $ref: "#/defs/loop" })).toEqual({
      type: "unknown",
      warnings: [
        'here → #/defs/loop: `$ref` "#/defs/loop" is recursive and not a component, so it has no name to recurse through; typed `unknown`',
      ],
    });
  });

  it("a reference outside the document, or that does not resolve", () => {
    expect(convert({ $ref: "other.json#/X" }).warnings).toEqual([
      'here: `$ref` "other.json#/X" points outside the document; typed `unknown`',
    ]);
    expect(convert({ $ref: "#/nowhere" }).warnings).toEqual([
      'here: `$ref` "#/nowhere" does not resolve; typed `unknown`',
    ]);
    expect(convert({ $ref: "#/components/schemas/Gone" }).warnings).toEqual([
      'here: `$ref` "#/components/schemas/Gone" names no component; typed `unknown`',
    ]);
  });

  it("an unknown type name, member by member", () => {
    expect(convert({ type: ["string", "date"] })).toEqual({
      type: "unknown",
      warnings: ['here: unknown `type` "date"; that member typed `unknown`'],
    });
  });

  it("a property's inexpressible schema leaves the rest typed", () => {
    expect(
      convert({
        type: "object",
        properties: { a: { type: "string" }, b: { not: { type: "null" } } },
      }),
    ).toEqual({
      type: "{\n  a?: string;\n  b?: unknown;\n}",
      warnings: [
        "here.b: `not` cannot be expressed in TypeScript; typed `unknown`",
      ],
    });
  });
});
