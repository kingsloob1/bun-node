/**
 * The built-in converters themselves (plan §4.2): the yup `describe()` mapper
 * (its `matches` regex read as `.source`, never a stringified RegExp;
 * `oneOf` → `enum`; the dialects' two spellings of nullable), the arktype
 * fallback's morph recovery, bun-jobs' `.json` reader as the skew fallback it
 * is, and valibot's injected converter degrading a transform rather than
 * throwing.
 */
import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import * as yup from "yup";
import { toJsonSchema as valibotToJsonSchema } from "@valibot/to-json-schema";
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import type { ConversionWarning } from "../../lib/docs/index";
import { toJsonSchema, valibotConverter } from "../../lib/docs/index";

/** A Standard Schema of vendor `vendor`, validating everything, with extras on the schema object. */
function fakeSchema(
  vendor: string,
  ownExtras: Record<string, unknown> = {},
  standardExtras: Record<string, unknown> = {},
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

describe("yupConverter: the describe() mapper", () => {
  it("reads matches' params.regex .source, never a stringified RegExp", () => {
    // The gotcha, measured (plan §4.2): JSON.stringify of a RegExp is "{}".
    const json = toJsonSchema(yup.string().matches(/^[a-z]+$/));
    expect(json.pattern).toBe("^[a-z]+$");
  });

  it("maps oneOf to enum and notOneOf to not.enum", () => {
    const json = toJsonSchema(yup.string().oneOf(["a", "b"]));
    expect(json.enum).toEqual(["a", "b"]);
    expect(toJsonSchema(yup.string().notOneOf(["x"])).not).toEqual({
      enum: ["x"],
    });
  });

  it("maps nullable to a type union under draft-2020-12, nullable: true under openapi-3.0", () => {
    expect(toJsonSchema(yup.string().nullable())).toMatchObject({
      type: ["string", "null"],
    });
    expect(
      toJsonSchema(yup.string().nullable(), { dialect: "openapi-3.0" }),
    ).toMatchObject({ type: "string", nullable: true });
  });

  it("maps moreThan/lessThan to exclusive bounds and integer to the integer type", () => {
    const json = toJsonSchema(yup.number().integer().moreThan(3).lessThan(10));
    expect(json).toMatchObject({
      type: "integer",
      exclusiveMinimum: 3,
      exclusiveMaximum: 10,
    });
  });

  it("maps arrays and tuples, min/max/length to items and length bounds", () => {
    expect(
      toJsonSchema(yup.array(yup.string().min(2)).length(3)),
    ).toMatchObject({
      type: "array",
      items: { type: "string", minLength: 2 },
      minItems: 3,
      maxItems: 3,
    });
    expect(toJsonSchema(yup.tuple([yup.string(), yup.number()]))).toMatchObject(
      {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: false,
      },
    );
  });

  it("maps an object's fields and required, dropping unrecognised tests", () => {
    const json = toJsonSchema(
      yup.object({ id: yup.string().required(), note: yup.string() }),
    );
    expect(json).toMatchObject({
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string" } },
      required: ["id"],
    });
  });

  it("degrades a schema with no describe to {} plus warnings, never a throw", () => {
    const warnings: ConversionWarning[] = [];
    const schema = fakeSchema("yup");
    expect(
      toJsonSchema(schema, { onWarning: (w) => warnings.push(w) }),
    ).toEqual({});
    expect(warnings.map((w) => w.stage)).toEqual(["converter", "unsupported"]);
  });
});

describe("arktypeConverter: the morph recovery", () => {
  it("recovers a morph to its input side via the fallback option", () => {
    const schema = fakeSchema("arktype", {
      toJsonSchema: (options: {
        fallback: { morph: (ctx: { base: unknown }) => unknown };
      }) => ({
        // What arktype does with the fallback, structurally: the morph's
        // base stands in for it (measured: string.integer.parse →
        // {type:"string",pattern:…}).
        base: options.fallback.morph({ base: { type: "string" } }),
      }),
    });
    expect(toJsonSchema(schema)).toEqual({ base: { type: "string" } });
  });

  it("returns undefined for a schema with no toJsonSchema, never throwing", () => {
    const warnings: ConversionWarning[] = [];
    expect(
      toJsonSchema(fakeSchema("arktype"), {
        onWarning: (w) => warnings.push(w),
      }),
    ).toEqual({});
    expect(warnings.map((w) => w.stage)).toEqual(["converter", "unsupported"]);
  });
});

describe("bunJobsConverter: the .json skew fallback", () => {
  it("reads .json for a pre-V4-shaped schema, by identity", () => {
    const json = Object.freeze({
      type: "object",
      properties: { id: { type: "string" } },
    });
    const schema = fakeSchema("bun-jobs", { json });
    expect(toJsonSchema(schema)).toBe(json);
  });

  it("is a fallback: a V4 schema's own ~standard.jsonSchema wins", () => {
    const schema = fakeSchema(
      "bun-jobs",
      { json: { title: "from .json" } },
      {
        jsonSchema: {
          input: () => ({ title: "from jsonSchema" }),
          output: () => ({ title: "from jsonSchema" }),
        },
      },
    );
    expect(toJsonSchema(schema)).toEqual({ title: "from jsonSchema" });
  });

  it("returns undefined for a schema with no .json, never throwing", () => {
    const warnings: ConversionWarning[] = [];
    expect(
      toJsonSchema(fakeSchema("bun-jobs"), {
        onWarning: (w) => warnings.push(w),
      }),
    ).toEqual({});
    expect(warnings.map((w) => w.stage)).toEqual(["converter", "unsupported"]);
  });
});

describe("valibotConverter: the injected function", () => {
  it("converts with the dialect as target, degrading a transform (errorMode: ignore)", () => {
    // Measured against @valibot/to-json-schema 1.8.0: a transform throws
    // under "throw" and converts as its input side under "ignore".
    const schema = v.pipe(
      v.string(),
      v.transform((s) => s.length),
    );
    const warnings: ConversionWarning[] = [];
    const json = toJsonSchema(schema, {
      converters: { valibot: valibotConverter(valibotToJsonSchema) },
      onWarning: (w) => warnings.push(w),
    });
    expect(json).toMatchObject({ type: "string" });
    expect(warnings).toEqual([]);
  });

  it("a toStandardJsonSchema-wrapped schema takes the primary path with no registration", () => {
    // @valibot/to-json-schema's other entry point stamps the schema itself —
    // the registry is not involved at all.
    const wrapped = fakeSchema(
      "valibot",
      {},
      {
        jsonSchema: {
          input: () => ({ type: "string", title: "wrapped" }),
          output: () => ({ type: "string", title: "wrapped" }),
        },
      },
    );
    expect(toJsonSchema(wrapped)).toEqual({
      type: "string",
      title: "wrapped",
    });
  });

  it("returns undefined when the injected function throws, never throwing itself", () => {
    const warnings: ConversionWarning[] = [];
    const schema = v.string();
    const json = toJsonSchema(schema, {
      converters: {
        valibot: valibotConverter(() => {
          throw new Error("cannot convert");
        }),
      },
      onWarning: (w) => warnings.push(w),
    });
    expect(json).toEqual({});
    expect(warnings.map((w) => w.stage)).toEqual(["converter", "unsupported"]);
  });
});
