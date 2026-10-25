/**
 * Compile-time assertions for the docs converter's types (AD (b)). Checked by
 * the tests typecheck (`bun check`), not by `bun test` — the repo's
 * convention (`logging.type-test.ts`). Every `@ts-expect-error` doubles as a
 * regression guard: if the error ever stops appearing, the build fails on
 * the unused directive.
 */
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import { toStandardSchema, validate } from "../lib/BunValidate";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import type {
  ConversionWarning,
  ConvertContext,
  DocWarning,
  JsonSchemaConverter,
  JsonSchemaDialect,
  JsonSchemaLike,
  LiftComponentsOptions,
  LiftedSchema,
  OpenApiDocument,
  OpenApiPathResult,
  OpenApiResult,
  RouteDoc,
  RouteResponseDoc,
  SchemaDirection,
  ToJsonSchemaOptions,
} from "../lib/docs/index";
import {
  arktypeConverter,
  bunJobsConverter,
  danglingRefs,
  generateOpenApi,
  liftComponents,
  openApiSecurity,
  registerJsonSchemaConverter,
  toJsonSchema,
  toOpenApiPath,
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
type IsAny<T> = 0 extends 1 & T ? true : false;

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

/* ------------------------------------------------------------------ *
 * AD (a): `.describe()`, `generateOpenApi` and the moved utilities.
 * ------------------------------------------------------------------ */

/* `.describe()` returns `this` and chains with `setName`. */
const describedRouter = new BunRouter();
const chained = describedRouter
  .get("/users/:id", (req, res) => {
    // The critical one (plan §9.5): `.describe()` must not disturb the
    // overloads — the handler's types are exactly what the path gives.
    type Params = typeof req.params;
    type _paramsNotAny = Expect<Equal<IsAny<Params>, false>>;
    type _paramsId = Expect<Equal<Params["id"], string>>;
    res.json({ id: req.params.id });
  })
  .describe({ summary: "Read one user", tags: ["Users"] })
  .setName("user.read")
  .describe({ deprecated: true });
type _chains = Expect<Equal<typeof chained, typeof describedRouter>>;

/* `.describe()` after a validated route: `req.query` is the validator's. */
const validatedRouter = new BunRouter();
validatedRouter
  .get(
    "/typed",
    validate({ query: z.object({ q: z.string() }) }),
    (req, res) => {
      type _queryQ = Expect<Equal<(typeof req.query)["q"], string>>;
      res.json({ ok: true });
    },
  )
  .describe({
    request: { cookies: { type: "object" } },
    responses: { 200: { schema: z.object({ ok: z.boolean() }) }, 204: null },
  });

/* RouteDoc.responses: a bare Standard Schema, a RouteResponseDoc, `null`. */
const IdParams = z.object({ id: z.string() });
const responseDoc: RouteResponseDoc = {
  description: "one user",
  schema: IdParams,
  mediaType: "application/json",
  headers: { "x-request-id": { schema: { type: "string" } } },
  examples: { one: { value: { id: "u_1" } } },
};
const _responses: RouteDoc["responses"] = {
  200: IdParams,
  201: responseDoc,
  204: null,
  default: { description: "A problem" },
};
// @ts-expect-error a response is a schema, a RouteResponseDoc or null
const _badResponses: RouteDoc["responses"] = { 200: 42 };

/* RouteDoc.request takes a schema of any vendor, or a raw JSON Schema. */
declare const valibotSchema: StandardSchemaV1;
declare const arktypeSchema: StandardSchemaV1;
declare const yupSchema: StandardSchemaV1;
const _request: RouteDoc["request"] = {
  params: IdParams,
  query: valibotSchema,
  headers: arktypeSchema,
  cookies: yupSchema,
  body: { type: "object", properties: { name: { type: "string" } } },
};

/* `security` overrides; `[]` means explicitly public. */
const _security: RouteDoc = { security: [{ bearer: [] }] };
const _public: RouteDoc = { security: [] };
/* Extensions must be `x-` keys. */
const _extensions: RouteDoc = { extensions: { "x-audience": "partners" } };
// @ts-expect-error an extension key must start with x-
const _badExtension: RouteDoc = { extensions: { audience: "partners" } };

/* generateOpenApi's shape. */
const openApiResult: OpenApiResult = generateOpenApi(describedRouter, {
  title: "API",
  version: "1.0.0",
});
const _document: OpenApiDocument = openApiResult.document;
const _warnings: readonly DocWarning[] = openApiResult.warnings;
// @ts-expect-error title is required
generateOpenApi(describedRouter, { version: "1.0.0" });
generateOpenApi(describedRouter, {
  title: "API",
  version: "1.0.0",
  strict: "strict",
  optionalParams: "warn",
  filter: (route) => route.method === "GET",
  operationId: (route) => route.key,
  componentName: (s) => (typeof s === "object" ? undefined : undefined),
  converters: {
    acme: (s, ctx) => (ctx.direction === "input" ? {} : undefined),
  },
});
// @ts-expect-error strict is a closed union
generateOpenApi(describedRouter, { title: "t", version: "1", strict: "hard" });

/* toOpenApiPath never throws; its result is the union it documents. */
const pathResult: OpenApiPathResult = toOpenApiPath("/users/:id", {
  optionalParams: "two-paths",
});
const _templatePath: string = pathResult.templates[0]?.path ?? "";
// @ts-expect-error optionalParams is a closed union
toOpenApiPath("/x", { optionalParams: "skip" });

/* The moved utilities. */
const _dangling: string[] = danglingRefs({});
const _securityParts = openApiSecurity({
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
});
type _securitySchemes = Expect<
  Equal<
    NonNullable<typeof _securityParts.securitySchemes>["bearer"]["type"],
    "apiKey" | "http" | "oauth2" | "openIdConnect"
  >
>;

export const _usesA = [
  chained,
  validatedRouter,
  responseDoc,
  _responses,
  _badResponses,
  _request,
  _security,
  _public,
  _extensions,
  _badExtension,
  openApiResult,
  _document,
  _warnings,
  pathResult,
  _templatePath,
  _dangling,
  _securityParts,
];
export type _typesA = [_chains, _securitySchemes];
