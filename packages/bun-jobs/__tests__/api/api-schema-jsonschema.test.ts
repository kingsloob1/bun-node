/**
 * `s`'s Standard JSON Schema converter, `~standard.jsonSchema` (plan
 * `docs/plans/bun-validate/` §4.8.5, §4.12 m11): what it produces for each
 * target, a defaulted key optional on input and required in output, and how
 * bun-common's readers of `~standard.jsonSchema` (`mergeContracts`,
 * `res.variant()`'s adjust, `recordOf`) behave with `s`.
 */
import type { BunResponse } from "@kingsleyweb/bun-common";
import type { Schema } from "../../lib/api/schema/builder";
import {
  BunRouter,
  createTestLogger,
  documented,
  getContract,
  mergeContracts,
  recordOf,
  validate,
  variants,
} from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { recursiveSchema, s, toJsonSchema } from "../../lib/api/schema/builder";
import { AddFlowResultSchema } from "../../lib/api/schemas/jobs";
import { ConfigError } from "../../lib/index";

/** A JSON object, loosely. */
type Json = Record<string, unknown>;

/** The input document for `target` (default draft 2020-12). */
const input = (schema: Schema<any, any>, target = "draft-2020-12"): Json =>
  schema["~standard"].jsonSchema.input({ target });

/** The output document for `target` (default draft 2020-12). */
const output = (schema: Schema<any, any>, target = "draft-2020-12"): Json =>
  schema["~standard"].jsonSchema.output({ target });

/** A document without its `$schema`. */
function bare(document: Json): Json {
  const { $schema: _dialect, ...rest } = document;
  return rest;
}

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

describe("s carries ~standard.jsonSchema", () => {
  /** Schemas with no named part and no documented keyword: their input is exactly `.json`. */
  const PLAIN: Record<string, Schema<any, any>> = {
    string: s.string({ minLength: 1, maxLength: 9, pattern: "^a" }),
    "date-time": s.string({ format: "date-time", description: "When" }),
    integer: s.integer({ minimum: 0, maximum: 10, default: 3 }),
    number: s.number(),
    boolean: s.boolean({ default: false }),
    literal: s.literal("x"),
    enum: s.enum(["a", "b"], { default: "a" }),
    array: s.array(s.string(), { minItems: 1, maxItems: 3 }),
    object: s.object(
      {
        a: s.string(),
        b: s.optional(s.integer()),
        c: s.integer({ default: 1 }),
      },
      { additionalProperties: s.boolean() },
    ),
    record: s.record(s.number()),
    nullable: s.nullable(s.string()),
    union: s.union(s.literal(1), s.object({ x: s.string() })),
    unknown: s.unknown({ description: "anything" }),
    query: s.query(s.object({ limit: s.optional(s.integer({ default: 20 })) })),
  };

  it("an unnamed, undocumented schema's input is its .json, under each supported target", () => {
    for (const [name, schema] of Object.entries(PLAIN)) {
      for (const [target, uri] of [
        ["draft-2020-12", DRAFT_2020_12],
        ["draft-07", DRAFT_07],
      ] as const) {
        const document = input(schema, target);
        expect(document.$schema, name).toBe(uri);
        expect(bare(document), `${name} (${target})`).toEqual(
          structuredClone(schema.json) as Json,
        );
      }
      expect(schema["~standard"].vendor).toBe("bun-jobs");
    }
  });

  it("names a named component once, in the target's definitions, and refers to it", () => {
    const Item = s.named("Item", s.object({ id: s.string() }));
    const List = s.object({ items: s.array(Item), first: s.nullable(Item) });
    const modern = input(List);
    expect(modern.$defs).toEqual({ Item: structuredClone(Item.json) as Json });
    expect(modern.properties).toEqual({
      items: { type: "array", items: { $ref: "#/$defs/Item" } },
      first: { anyOf: [{ $ref: "#/$defs/Item" }, { type: "null" }] },
    });
    const old = input(List, "draft-07");
    expect(old.$defs).toBeUndefined();
    expect(old.definitions).toEqual({
      Item: structuredClone(Item.json) as Json,
    });
    expect(JSON.stringify(old)).toContain('"#/definitions/Item"');
    expect(JSON.stringify(old)).not.toContain("$defs");

    // A named root is inlined, as `toJsonSchema` emits a component's body.
    const emitted: unknown = toJsonSchema(Item, { inlineRoot: true });
    expect(bare(input(Item))).toEqual(emitted as Json);
  });

  it("states what the documents state: s.documented's keywords are in it", () => {
    const Name = s.documented(s.string(), {
      pattern: "^[a-z]+$",
      deprecated: true,
    });
    expect(Name.json).toEqual({ type: "string" });
    expect(bare(input(Name))).toEqual({
      type: "string",
      pattern: "^[a-z]+$",
      deprecated: true,
    });
  });

  it("emits a recursive schema as a self-referring definition, with no cycle in the document", () => {
    const Tree = recursiveSchema<{ children: unknown[] }>("Tree", (self) =>
      s.object({ children: s.array(self) }),
    );
    const document = input(Tree);
    expect(() => JSON.stringify(document)).not.toThrow();
    expect(document.properties).toEqual({
      children: { type: "array", items: { $ref: "#/$defs/Tree" } },
    });
    const { $defs, ...body } = bare(document);
    expect(($defs as Json).Tree).toEqual(body);

    // The API's own recursive response: every reference resolves.
    const flow = input(AddFlowResultSchema);
    const defs = flow.$defs as Json;
    for (const ref of JSON.stringify(flow).matchAll(/"#\/\$defs\/([^"]+)"/g)) {
      expect(Object.keys(defs)).toContain(ref[1]);
    }
    expect(Object.keys(defs)).toContain("AddFlowResult");
  });

  it("throws a ConfigError for a target it does not support, as the spec asks", () => {
    const schema = s.string();
    for (const target of ["openapi-3.0", "draft-04", ""]) {
      expect(() => input(schema, target)).toThrow(ConfigError);
      expect(() => output(schema, target)).toThrow(ConfigError);
    }
    expect(() =>
      schema["~standard"].jsonSchema.input(undefined as never),
    ).toThrow(ConfigError);
  });

  it("returns a fresh document each call, and never touches the schema", () => {
    const schema = s.object({ a: s.integer({ default: 1 }) });
    const first = input(schema);
    (first.properties as Json).a = "changed";
    expect(input(schema)).toEqual({ $schema: DRAFT_2020_12, ...schema.json });
    expect(Object.isFrozen(schema.json)).toBe(true);
    expect(output(schema)).not.toBe(output(schema));
  });
});

describe("a defaulted key: optional on input, required in output (m11)", () => {
  const Limit = s.named("Limit", s.integer({ minimum: 1, default: 20 }));
  const Shape = s.object({
    required: s.string(),
    optional: s.optional(s.string()),
    defaulted: s.integer({ default: 5 }),
    optionalDefaulted: s.optional(s.boolean({ default: true })),
    named: Limit,
    nested: s.optional(
      s.object({ inner: s.enum(["a", "b"], { default: "a" }), x: s.string() }),
    ),
    rows: s.array(s.object({ n: s.number({ default: 0 }), k: s.string() })),
    maybe: s.optional(s.nullable(s.object({ z: s.string({ default: "z" }) }))),
  });

  it("input: only the keys without a default or `s.optional` are required", () => {
    const document = input(Shape);
    expect(document.required).toEqual(["required", "rows"]);
    expect((document.properties as Json).nested).toMatchObject({
      required: ["x"],
    });
    expect(
      (document.properties as { rows: { items: Json } }).rows.items.required,
    ).toEqual(["k"]);
  });

  it("output: every defaulted key is required too, at every depth, through a $ref", () => {
    for (const target of ["draft-2020-12", "draft-07"]) {
      const document = output(Shape, target);
      expect(document.required).toEqual([
        "required",
        "defaulted",
        "optionalDefaulted",
        "named",
        "rows",
      ]);
      const properties = document.properties as Record<string, Json>;
      expect(properties.nested.required).toEqual(["inner", "x"]);
      expect((properties.rows.items as Json).required).toEqual(["n", "k"]);
      expect((properties.maybe.anyOf as Json[])[0].required).toEqual(["z"]);
    }
    // Only `required` differs between the two directions.
    const strip = (node: unknown): unknown =>
      JSON.parse(
        JSON.stringify(node, (key, value: unknown) =>
          key === "required" ? undefined : value,
        ),
      );
    expect(strip(output(Shape))).toEqual(strip(input(Shape)));
  });

  it("output's required keys inside a definition", () => {
    const Opts = s.named(
      "Opts",
      s.object({ attempts: s.integer({ default: 1 }), name: s.string() }),
    );
    const Wrapper = s.object({ opts: Opts });
    expect(((input(Wrapper).$defs as Json).Opts as Json).required).toEqual([
      "name",
    ]);
    expect(((output(Wrapper).$defs as Json).Opts as Json).required).toEqual([
      "attempts",
      "name",
    ]);
  });

  it("agrees with what validation does: the least input passes, and its output has every key output requires", () => {
    const least = { required: "r", rows: [{ k: "k" }] };
    const result = Shape["~standard"].validate(least) as { value: Json };
    expect(result.value).toEqual({
      required: "r",
      defaulted: 5,
      optionalDefaulted: true,
      named: 20,
      rows: [{ n: 0, k: "k" }],
    });
    for (const key of output(Shape).required as string[]) {
      expect(Object.keys(result.value)).toContain(key);
    }
    // And a key input requires is required by validation.
    for (const key of input(Shape).required as string[]) {
      const missing = { ...least } as Json;
      delete missing[key];
      expect(
        (Shape["~standard"].validate(missing) as { issues?: unknown }).issues,
        key,
      ).toBeDefined();
    }
  });
});

describe("bun-common's readers of ~standard.jsonSchema, with s", () => {
  const Body = s.object({ a: s.string(), n: s.integer({ default: 1 }) });

  it("mergeContracts compares a documented() part with an s validator, and agrees when they match", () => {
    const merge = (json: Json) => {
      const { logger, events } = createTestLogger();
      mergeContracts(
        [
          {
            contract: getContract(validate({ body: documented(json) }))!,
            origin: "docs",
          },
          { contract: getContract(validate({ body: Body }))!, origin: "route" },
        ],
        { logger },
      );
      return events.map((event) => event.message);
    };
    expect(merge(bare(input(Body)))).toEqual([]);
    expect(
      merge({ type: "object", properties: { a: { type: "integer" } } }),
    ).toEqual(["documented schema disagrees with the validator, which wins"]);
  });

  it("res.variant() fills an s schema's literal and strips what it does not declare", async () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger });
    router.get(
      "/v",
      validate(
        {},
        {
          responseValidation: "error",
          responses: {
            200: variants({
              a: {
                content: {
                  "application/json": s.object({
                    kind: s.literal("a"),
                    n: s.integer(),
                  }),
                },
              },
              b: {
                content: {
                  "application/json": s.object({
                    kind: s.literal("b"),
                    m: s.string(),
                  }),
                },
              },
            }),
          },
        },
      ),
      (_req, res) =>
        (res as unknown as { variant: (name: string) => BunResponse })
          .variant("a")
          .json({ n: 1, extra: true }),
    );
    const response = await router.fetch("/v");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "a", n: 1 });
    expect(
      events.filter((event) => event.message.includes("cannot adjust")),
    ).toEqual([]);
  });

  it("recordOf composes s members' JSON Schemas, a defaulted key required in output", () => {
    const record = recordOf({ body: Body, name: s.string() }) as unknown as {
      "~standard": { jsonSchema?: Schema<any, any>["~standard"]["jsonSchema"] };
    };
    const converter = record["~standard"].jsonSchema!;
    const inputDoc = converter.input({ target: "draft-2020-12" }) as {
      properties: { body: Json };
    };
    const outputDoc = converter.output({ target: "draft-2020-12" }) as {
      properties: { body: Json };
    };
    expect(inputDoc.properties.body.required).toEqual(["a"]);
    expect(outputDoc.properties.body.required).toEqual(["a", "n"]);
  });
});
