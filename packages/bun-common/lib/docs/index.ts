/**
 * The Standard Schema → JSON Schema converter (AD phase (b), plan
 * `docs/plans/api-docs-generation/` §4), published as
 * `@kingsleyweb/bun-common/lib/docs`. The document generator it feeds is
 * phase (a); what ships here is the standalone conversion: {@link toJsonSchema}
 * for one schema, {@link liftComponents} for the `$defs` →
 * `components.schemas` post-processing, the vendor converters, and
 * {@link withJsonSchema} for an explicit attachment.
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
