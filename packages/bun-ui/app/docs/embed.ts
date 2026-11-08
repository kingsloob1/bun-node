/**
 * The embedding surface (`@kingsleyweb/bun-api-docs-ui/embed`): the viewer's
 * screens and models for a host app to render inside its own shell, with the
 * host's router, client, permissions and console injected through the seam
 * props. bun-jobs-ui's docs section is built from these.
 *
 * This is browser code (React, TSX, CSS side-effect imports): it is for a host
 * that bundles it (Bun.build does), never for a Node consumer, and it ships as
 * source — there are no declarations, the types ARE the source. It is covered
 * in-repo (bun-jobs-ui consumes it through the workspace); the package's
 * consumer check covers the server-side `lib/` surface.
 *
 * The two models come out as namespaces: both name a `filterGroups`, and the
 * WebSocket one a `refName` that is not the schema's.
 */

// The shared JSON Schema renderer.
export * from "./screens/docs/schema";

// The HTTP reference (OpenAPI 3.1).
export * as httpModel from "./screens/docs/http/model";
export * as httpTryIt from "./screens/docs/http/tryIt";
export { HttpReference } from "./screens/docs/http/index";
export type { HttpReferenceProps } from "./screens/docs/http/index";

// The WebSocket reference (AsyncAPI 3.0).
export * as wsModel from "./screens/docs/ws/model";
export * as wsFormat from "./screens/docs/ws/format";
export { InlineText } from "./screens/docs/ws/InlineText";
export { PayloadSchema } from "./screens/docs/ws/PayloadSchema";
export type { PayloadSchemaProps } from "./screens/docs/ws/PayloadSchema";
export { PermissionMarker } from "./screens/docs/ws/items";
export { WsReference } from "./screens/docs/ws/index";
export type { WsConsole, WsPaneOptions } from "./screens/docs/ws/items";
export type { WsReferenceProps } from "./screens/docs/ws/index";

// The seams.
export type { PermissionProbe } from "./screens/docs/permissions";
export type { WsAddressOptions } from "./screens/docs/ws/model";
export type { LimitInfo } from "./screens/docs/ws/format";

// The host provides the config and the try-it client through these.
export {
  DocsClientContext,
  DocsFetchContext,
  DocsUiConfigContext,
} from "./context";

// The host's app shares the router's contexts by re-exporting these.
export * from "./routing";
export { Link, Navigate, RouterProvider } from "./router";
export type { LinkProps, RouterProviderProps } from "./router";

// The client and the document type, for the host's adapters, and the error
// class (the host re-homes its own errors into it for the try-it's banner).
export { ApiError, isApiError } from "./api/errors";
export type {
  ApiErrorInit,
  ApiErrorKind,
  ProblemDto,
  ProblemIssueDto,
} from "./api/errors";
export { createDocsClient } from "./api/client";
export type {
  DocsClient,
  FetchLike,
  HttpMethod,
  QueryParams,
  QueryScalar,
  QueryValue,
  RawResponse,
  RequestOptions,
} from "./api/client";
export type { SpecDocument } from "./api/docs";
