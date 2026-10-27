/**
 * The Standard Schema → JSON Schema converter (AD phase (b), plan
 * `docs/plans/api-docs-generation/` §4), the OpenAPI 3.1 generator (AD
 * phase (a), §3.2/§3.3), the AsyncAPI 3.0 generator (AD phase (e), §5) and
 * the serving/viewing half (AD phase (c), §7),
 * published as `@kingsleyweb/bun-common/lib/docs`. {@link generateOpenApi}
 * builds a document from a router's routes (V12's `listRoutes`) and their
 * `.describe()` docs; {@link generateAsyncApi} builds one from its WebSocket
 * channels and SSE endpoints (plus `BunWebSocket.wsRoutes()`'s bare routes
 * and their `describeChannel()` docs); {@link toJsonSchema}, {@link liftComponents} and the
 * vendor converters are the standalone conversion half; {@link docsRouter}
 * serves the document(s) and the viewer pages, off by default: the pinned-CDN
 * ones (`./viewer`), and `"self-hosted"` (`./selfHosted`) — the
 * `@kingsleyweb/bun-api-docs-ui` bundle served from this origin, an optional
 * peer. The browser-safe document types are the `./types` entry (plan risk
 * 10) — this index pulls the router in, so it is server-side.
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
export {
  type AsyncApiDocument,
  type AsyncApiOptions,
  type AsyncApiResult,
  type AsyncApiServerOptions,
  type AsyncApiWalkEntry,
  generateAsyncApi,
  type WsChannelDoc,
  type WsMessageDoc,
} from "./asyncapi";
export {
  type AsyncApiViewerName,
  docsRouter,
  type DocsRouterOptions,
  type OpenApiViewerName,
  type ViewerConfig,
} from "./router";
export {
  registerSelfHostedViewer,
  SELF_HOSTED_PACKAGE,
  type SelfHostedDocument,
  type SelfHostedRegistration,
  type SelfHostedViewerOptions,
} from "./selfHosted";
export {
  type AssetIntegrity,
  assetUrl,
  asyncApiUiPage,
  DOCS_CDN,
  type DocsCdnAssetOverride,
  type DocsCdnOptions,
  docsPageHeaders,
  type DocsPage,
  type PinnedAsset,
  rapidocPage,
  redocPage,
  resolveDocsCdn,
  type ResolvedDocsCdn,
  scalarPage,
  swaggerUiPage,
} from "./viewer";
