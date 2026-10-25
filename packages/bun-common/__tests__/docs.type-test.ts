/**
 * Compile-time assertions for the docs converter's types (AD (b)). Checked by
 * the tests typecheck (`bun check`), not by `bun test` — the repo's
 * convention (`logging.type-test.ts`). Every `@ts-expect-error` doubles as a
 * regression guard: if the error ever stops appearing, the build fails on
 * the unused directive.
 */
import { z } from "zod";
import { toStandardSchema } from "../lib/BunValidate";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import type {
  ConversionWarning,
  ConvertContext,
  JsonSchemaConverter,
  JsonSchemaDialect,
  JsonSchemaLike,
  LiftComponentsOptions,
  LiftedSchema,
  SchemaDirection,
  ToJsonSchemaOptions,
} from "../lib/docs/index";
import {
  arktypeConverter,
  bunJobsConverter,
  liftComponents,
  registerJsonSchemaConverter,
  toJsonSchema,
  valibotConverter,
  withJsonSchema,
  yupConverter,
  zodConverter,
} from "../lib/docs/index";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/* The closed unions. */
type _direction = Expect<Equal<SchemaDirection, "input" | "output">>;
type _dialect = Expect<
  Equal<JsonSchemaDialect, "draft-2020-12" | "openapi-3.0">
>;

/* The converter shape, and that every built-in satisfies it. */
type _converter = Expect<
  Equal<
    JsonSchemaConverter,
    (
      schema: StandardSchemaV1,
      context: ConvertContext,
    ) => JsonSchemaLike | undefined
  >
>;
const _builtins: JsonSchemaConverter[] = [
  zodConverter,
  arktypeConverter,
  yupConverter,
  bunJobsConverter,
];

/* ConvertContext.convert recurses, with an optional direction. */
type _contextConvert = Expect<
  Equal<
    ConvertContext["convert"],
    (
      schema: StandardSchemaV1,
      direction?: SchemaDirection,
    ) => JsonSchemaLike | undefined
  >
>;

declare const schema: StandardSchemaV1;

/* toJsonSchema: the happy path types. */
const json: JsonSchemaLike = toJsonSchema(schema);
const options: ToJsonSchemaOptions = {
  direction: "output",
  dialect: "openapi-3.0",
  converters: { acme: zodConverter },
  onWarning: (warning: ConversionWarning) => void warning.stage,
};
toJsonSchema(schema, options);
// @ts-expect-error a direction that is neither side
toJsonSchema(schema, { direction: "sideways" });
// @ts-expect-error a dialect that is neither target
toJsonSchema(schema, { dialect: "draft-07" });
// @ts-expect-error a converter that returns the wrong thing
toJsonSchema(schema, { converters: { acme: () => 42 } });
// @ts-expect-error the schema must be a Standard Schema
toJsonSchema({ type: "string" });

/* registerJsonSchemaConverter: a vendor string and a converter. */
registerJsonSchemaConverter("acme", (s, ctx) =>
  ctx.direction === "input" ? {} : undefined,
);
// @ts-expect-error the converter is not optional
registerJsonSchemaConverter("acme");
// @ts-expect-error the converter's context is not a string
registerJsonSchemaConverter("acme", (_s, _ctx: string) => undefined);

/* valibotConverter: the injected function is structural, never imported. */
declare const injected: (
  schema: unknown,
  config?: { target?: string; errorMode?: "throw" | "warn" | "ignore" },
) => unknown;
const _valibot: JsonSchemaConverter = valibotConverter(injected);
// @ts-expect-error the injected function must take a config
const _badValibot = valibotConverter((_s: unknown, _config: number) => ({}));

/* withJsonSchema: returns its schema, typed as it was. */
const zodSchema = z.object({ id: z.string() });
const stamped = withJsonSchema(zodSchema, { type: "object" });
type _stampedKeepsType = Expect<Equal<typeof stamped, typeof zodSchema>>;
const wrapped = toStandardSchema((value: unknown) => ({ value }));
const stampedWrapped = withJsonSchema(wrapped, {});
type _stampedWrapped = Expect<Equal<typeof stampedWrapped, typeof wrapped>>;
// @ts-expect-error not a schema
withJsonSchema({}, { type: "string" });
// @ts-expect-error not a JSON Schema object
withJsonSchema(zodSchema, "schema");

/* liftComponents. */
const lifted: LiftedSchema = liftComponents(json);
const _liftedSchema: JsonSchemaLike = lifted.schema;
const _liftedComponents: Record<string, JsonSchemaLike> = lifted.components;
const liftOptions: LiftComponentsOptions = {
  name: "Category",
  onWarning: (warning) => void warning.vendor,
};
liftComponents(json, liftOptions);
// @ts-expect-error the input is a JSON Schema object, not a Standard Schema
liftComponents(schema);
// @ts-expect-error the name is a string
liftComponents(json, { name: 42 });

/* A ConversionWarning's stages are a closed set. */
type _stages = Expect<
  Equal<
    ConversionWarning["stage"],
    "jsonSchema" | "converter" | "unsupported" | "lift"
  >
>;

export const _uses = [
  json,
  options,
  _builtins,
  _valibot,
  stamped,
  stampedWrapped,
  lifted,
  _liftedSchema,
  _liftedComponents,
  liftOptions,
];
export type _types = [
  _direction,
  _dialect,
  _converter,
  _contextConvert,
  _stampedKeepsType,
  _stampedWrapped,
  _stages,
];
