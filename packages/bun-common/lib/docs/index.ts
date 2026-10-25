/**
 * The Standard Schema → JSON Schema converter (AD phase (b), plan
 * `docs/plans/api-docs-generation/` §4) and the OpenAPI 3.1 generator (AD
 * phase (a), §3.2/§3.3), published as `@kingsleyweb/bun-common/lib/docs`.
 * {@link generateOpenApi} builds a document from a router's routes (V12's
 * `listRoutes`) and their `.describe()` docs; {@link toJsonSchema},
 * {@link liftComponents} and the vendor converters are the standalone
 * conversion half.
 *
 * Nothing here imports a vendor package — the converters are structural
 * (plan risk 1f; `__tests__/docs/packaging.test.ts` proves the import graph).
 */
export {
  type ConversionWarning,
  type ConvertContext,
  type JsonSchemaConverter,
  type JsonSchemaDialect,
  type JsonSchemaLike,
  registerJsonSchemaConverter,
  type SchemaDirection,
  toJsonSchema,
  type ToJsonSchemaOptions,
  withJsonSchema,
} from "./convert";
export {
  arktypeConverter,
  bunJobsConverter,
  valibotConverter,
  yupConverter,
  zodConverter,
} from "./converters";
export {
  liftComponents,
  type LiftComponentsOptions,
  type LiftedSchema,
} from "./lift";
export {
  collectRefs,
  danglingRefs,
  pruneSchemaComponents,
  resolveRef,
  SCHEMA_REF_PREFIX,
} from "./refs";
export {
  type AsyncApiSecurityScheme,
  type MappedAsyncApiScheme,
  type OpenApiSecurity,
  type OpenApiSecurityOptions,
  type OpenApiSecurityScheme,
  openApiSecurity,
  toAsyncApiSecurityScheme,
} from "./security";
export type { RouteDoc, RouteResponseDoc } from "./routeDoc";
export {
  type DocWarning,
  generateOpenApi,
  type OpenApiDocument,
  type OpenApiOptions,
  type OpenApiPathOptions,
  type OpenApiPathParam,
  type OpenApiPathResult,
  type OpenApiPathTemplate,
  type OpenApiResult,
  toOpenApiPath,
} from "./openapi";
