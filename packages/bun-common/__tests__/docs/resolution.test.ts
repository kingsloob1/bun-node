/**
 * The resolution order of `toJsonSchema` (plan §4.3): a `withJsonSchema`
 * attachment first, then the schema's own `~standard.jsonSchema`, then the
 * per-call converters, the process registry and the built-ins (the first the
 * chain holds — a registration *replaces* the built-in), and `{}` plus a
 * warning at the end. Every step but the registry's has a removal control:
 * the step's input taken away, the outcome must change, proving the step was
 * doing the work.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { toStandardSchema } from "../../lib/BunValidate";
import { documented } from "../../lib/contract/schemas";
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import type { ConversionWarning, JsonSchemaLike } from "../../lib/docs/index";
import {
  registerJsonSchemaConverter,
  toJsonSchema,
  withJsonSchema,
  zodConverter,
} from "../../lib/docs/index";

/** Collects warnings. */
function collector(): {
  warnings: ConversionWarning[];
  onWarning: (warning: ConversionWarning) => void;
} {
  const warnings: ConversionWarning[] = [];
  return { warnings, onWarning: (warning) => warnings.push(warning) };
}

/** A Standard Schema of vendor `vendor`, validating everything, with extras on `~standard` and on the schema object itself. */
function fakeSchema(
  vendor: string,
  standardExtras: Record<string, unknown> = {},
  ownExtras: Record<string, unknown> = {},
): StandardSchemaV1 {
  return {
    ...ownExtras,
    "~standard": {
      version: 1,
      vendor,
      validate: (value: unknown) => ({ value }),
      ...standardExtras,
    },
  };
}

describe("toJsonSchema: the resolution order (§4.3)", () => {
  it("reads the schema's own ~standard.jsonSchema first among the automatic paths", () => {
    const schema = fakeSchema("acme", {
      jsonSchema: {
        input: () => ({ type: "string", title: "from jsonSchema" }),
        output: () => ({ type: "string", title: "from jsonSchema" }),
      },
    });
    const { warnings, onWarning } = collector();
    expect(toJsonSchema(schema, { onWarning })).toEqual({
      type: "string",
      title: "from jsonSchema",
    });
    expect(warnings).toEqual([]);
  });

  it("asks for the direction and dialect it was given", () => {
    const seen: { direction?: string; options?: unknown } = {};
    const schema = fakeSchema("acme", {
      jsonSchema: {
        input: (options: unknown) => {
          seen.direction = "input";
          seen.options = options;
          return { type: "string" };
        },
        output: (options: unknown) => {
          seen.direction = "output";
          seen.options = options;
          return { type: "string" };
        },
      },
    });
    toJsonSchema(schema, { direction: "output", dialect: "openapi-3.0" });
    expect(seen.direction).toBe("output");
    // zod's degraded option goes on the primary path (V3c's merged
    // behaviour): an opaque per-vendor `libraryOptions` a vendor that takes
    // none ignores.
    expect(seen.options).toEqual({
      target: "openapi-3.0",
      libraryOptions: { unrepresentable: "any" },
    });
  });

  it("lets a withJsonSchema attachment win over the schema's own converter", () => {
    const schema = withJsonSchema(
      fakeSchema("acme", {
        jsonSchema: {
          input: () => ({ type: "string" }),
          output: () => ({ type: "string" }),
        },
      }),
      { type: "integer" },
    );
    expect(toJsonSchema(schema)).toEqual({ type: "integer" });
  });

  it("falls through a throwing ~standard.jsonSchema to the vendor converter, with a warning", () => {
    // A "zod"-vendored schema whose companion-spec converter throws (the spec
    // allows it) but which carries the instance method the built-in reads.
    const schema = fakeSchema(
      "zod",
      {
        jsonSchema: {
          input: () => {
            throw new Error("cannot represent this");
          },
          output: () => {
            throw new Error("cannot represent this");
          },
        },
      },
      // The instance method the built-in zod converter reads, on the schema
      // object itself (where zod keeps it), not on `~standard`.
      { toJSONSchema: () => ({ type: "number" }) },
    );
    const { warnings, onWarning } = collector();
    expect(toJsonSchema(schema, { onWarning })).toEqual({ type: "number" });
    expect(warnings).toEqual([
      {
        vendor: "zod",
        stage: "jsonSchema",
        message:
          "~standard.jsonSchema.input() threw: cannot represent this; falling back to the vendor converters",
      },
    ]);
  });

  it("removal control: without the instance method the same schema degrades to {}", () => {
    const schema = fakeSchema("zod", {
      jsonSchema: {
        input: () => {
          throw new Error("cannot represent this");
        },
        output: () => {
          throw new Error("cannot represent this");
        },
      },
    });
    const { warnings, onWarning } = collector();
    expect(toJsonSchema(schema, { onWarning })).toEqual({});
    expect(warnings.map((w) => w.stage)).toEqual([
      "jsonSchema",
      "converter",
      "unsupported",
    ]);
  });

  it("prefers a per-call converter over the registry and the built-in", () => {
    const schema = fakeSchema("acme-per-call");
    const perCall = (): JsonSchemaLike => ({ title: "per-call" });
    const registered = (): JsonSchemaLike => ({ title: "registered" });
    registerJsonSchemaConverter("acme-per-call", registered);
    expect(
      toJsonSchema(schema, { converters: { "acme-per-call": perCall } }),
    ).toEqual({
      title: "per-call",
    });
    // Removal control: the per-call converter gone, the registration answers.
    expect(toJsonSchema(schema)).toEqual({ title: "registered" });
  });

  it("lets a registration replace the built-in, and the built-in again once re-registered", () => {
    const schema = fakeSchema(
      "zod",
      {},
      { toJSONSchema: () => ({ type: "number" }) },
    );
    // The built-in answers first (no registration for "zod" yet in this file).
    expect(toJsonSchema(schema)).toEqual({ type: "number" });
    registerJsonSchemaConverter("zod", () => ({ title: "replaced" }));
    try {
      expect(toJsonSchema(schema)).toEqual({ title: "replaced" });
    } finally {
      // The registry is process-wide; put the built-in back for every other
      // test file sharing the process.
      registerJsonSchemaConverter("zod", zodConverter);
    }
    expect(toJsonSchema(schema)).toEqual({ type: "number" });
  });

  it("emits {} plus a warning for a vendor no path knows, and never throws for content", () => {
    const schema = fakeSchema("no-such-library");
    const { warnings, onWarning } = collector();
    expect(toJsonSchema(schema, { onWarning })).toEqual({});
    expect(warnings).toEqual([
      {
        vendor: "no-such-library",
        stage: "unsupported",
        message:
          "no conversion path could describe the schema; `{}` (any value) was emitted",
      },
    ]);
  });

  it("throws a TypeError for a non-schema argument — a programmer error, not content", () => {
    // @ts-expect-error the runtime guard exists for exactly this call
    expect(() => toJsonSchema({})).toThrow(TypeError);
    // @ts-expect-error as above
    expect(() => toJsonSchema("schema")).toThrow(TypeError);
  });
});

describe("toJsonSchema: direction is not cosmetic (plan §4.2, M2)", () => {
  // The measured fixture: a defaulted field is optional on the wire (input)
  // and always present after parsing (output).
  const schema = z.object({ a: z.string(), b: z.number().default(2) });

  it("converts requests with input: the defaulted field is not required", () => {
    const json = toJsonSchema(schema, { direction: "input" });
    expect(json.required).toEqual(["a"]);
    expect(json.additionalProperties).toBeUndefined();
  });

  it("input is the default", () => {
    expect(toJsonSchema(schema)).toEqual(
      toJsonSchema(schema, { direction: "input" }),
    );
  });

  it('the responseOutput: "parsed" override converts with output', () => {
    const json = toJsonSchema(schema, { direction: "output" });
    expect(json.required).toEqual(["a", "b"]);
    expect(json.additionalProperties).toBe(false);
  });

  it("passes the openapi-3.0 dialect through (nullable, not a type union)", () => {
    const json = toJsonSchema(z.object({ n: z.number().nullable() }), {
      dialect: "openapi-3.0",
    });
    expect(json.properties).toEqual({ n: { type: "number", nullable: true } });
  });
});

describe("the escape hatches convert with no registration", () => {
  it("documented() publishes its JSON Schema through the primary path", () => {
    const { warnings, onWarning } = collector();
    expect(
      toJsonSchema(
        documented({
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        }),
        { onWarning },
      ),
    ).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(warnings).toEqual([]);
  });

  it("toStandardSchema(fn, { jsonSchema })", () => {
    const schema = toStandardSchema((value: unknown) => ({ value }), {
      jsonSchema: { type: "integer", minimum: 1 },
    });
    const { warnings, onWarning } = collector();
    expect(toJsonSchema(schema, { onWarning })).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(warnings).toEqual([]);
  });

  it("withJsonSchema stamps the schema's ~standard with a non-enumerable converter", () => {
    const schema = toStandardSchema((value: unknown) => ({ value }));
    const before = Object.keys(schema["~standard"]);
    const stamped = withJsonSchema(schema, { type: "integer" });
    expect(stamped).toBe(schema);
    expect(Object.keys(schema["~standard"])).toEqual(before);
    expect(toJsonSchema(schema)).toEqual({ type: "integer" });
  });

  it("withJsonSchema falls back to a WeakMap for a frozen ~standard", () => {
    const schema = fakeSchema("acme-frozen");
    Object.freeze(schema["~standard"]);
    const stamped = withJsonSchema(schema, { type: "boolean" });
    expect(stamped).toBe(schema);
    expect(toJsonSchema(schema)).toEqual({ type: "boolean" });
  });

  it("withJsonSchema validates its arguments (programmer errors throw)", () => {
    const schema = fakeSchema("acme-args");
    // @ts-expect-error not a JSON Schema object
    expect(() => withJsonSchema(schema, "json")).toThrow(TypeError);
    // @ts-expect-error not a schema
    expect(() => withJsonSchema({}, { type: "string" })).toThrow(TypeError);
  });
});
