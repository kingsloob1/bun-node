import type { BunResponse } from "@kingsleyweb/bun-common";
import type { ResolvedJobsApiConfig } from "../config";
import type { DocsPage } from "../docs/html";
import type { AnyRouteDef } from "./define";
import { resolveDocsCdn } from "../docs/cdn";
import { asyncApiUiPage, swaggerUiPage } from "../docs/html";
import { ApiError } from "../errors";
import { AsyncApiDocumentSchema, OpenApiDocumentSchema } from "../schemas/meta";
import { asyncApiDocumentFor } from "../spec/asyncapi";
import { isWebSocketEnabled } from "../ws/channels";
import { defineRoute } from "./define";

/**
 * The docs routes: the OpenAPI document, the AsyncAPI document when the API
 * has a socket, and — only with `docs.ui` — an HTML viewer for each.
 *
 * The pages are off by default: they load third-party script into an origin
 * that holds admin cookies, and "try it out" is a mutation console. The JSON
 * documents cost nothing and are always available behind `docs.read`.
 */
export function docsRoutes(config: ResolvedJobsApiConfig): AnyRouteDef[] {
  if (config.docs === false) {
    return [];
  }
  // Resolved once, here, so a bad `docs.cdn` fails at construction rather than
  // on the first page request.
  const cdn = resolveDocsCdn(config.docs);
  const docs = config.docs;

  /** Serves a generated page, writing the response itself. */
  const servePage = (page: DocsPage, res: BunResponse) => {
    for (const [name, value] of Object.entries(page.headers)) {
      res.setHeader(name, value);
    }
    res.status(200);
    res.send(page.html);
    return {};
  };

  return [
    defineRoute({
      method: "GET",
      path: docs.openapiPath as `/${string}`,
      operationId: "getOpenApiDocument",
      action: "docs.read",
      mode: "any",
      summary: "The OpenAPI 3.1 document for exactly what is routed",
      tags: ["Docs"],
      enabledWhen: (resolved) => resolved.docs !== false,
      responses: { 200: OpenApiDocumentSchema },
      handler: ({ services }) => ({ body: services.openapi() }),
    }),
    defineRoute({
      method: "GET",
      path: docs.asyncapiPath as `/${string}`,
      operationId: "getAsyncApiDocument",
      action: "docs.read",
      mode: "any",
      summary: "The AsyncAPI 3.0 document for the live-events socket",
      description:
        "Routed only when the API has a socket. The server's host is the one this request was sent to, unless `docs.asyncapiServer` fixes it.",
      tags: ["Docs"],
      enabledWhen: (resolved) =>
        resolved.docs !== false && isWebSocketEnabled(resolved),
      responses: { 200: AsyncApiDocumentSchema },
      handler: ({ req, services }) => {
        const document = asyncApiDocumentFor(services.config, req);
        if (!document) {
          // Only reachable through a router built without the socket
          // (`buildJobsApi` always registers the source when it routes this).
          throw new ApiError(
            "ROUTE_NOT_FOUND",
            404,
            "This API has no live-events socket",
          );
        }
        return { body: document };
      },
    }),
    defineRoute({
      method: "GET",
      path: docs.uiPath as `/${string}`,
      operationId: "getDocsUi",
      action: "docs.read",
      mode: "any",
      summary: "Swagger UI for the OpenAPI document",
      description:
        "An HTML page loading Swagger UI from a pinned CDN, under a Content Security Policy that allows only that origin and one nonce'd initialiser. Registered only with `docs.ui`.",
      tags: ["Docs"],
      enabledWhen: (resolved) => resolved.docs !== false && resolved.docs.ui,
      responses: { 200: null },
      handler: ({ res, services }) =>
        servePage(swaggerUiPage({ config: services.config, cdn }), res),
    }),
    defineRoute({
      method: "GET",
      path: docs.asyncapiUiPath as `/${string}`,
      operationId: "getAsyncApiUi",
      action: "docs.read",
      mode: "any",
      summary: "The AsyncAPI viewer for the live-events document",
      description:
        "An HTML page loading the AsyncAPI React component from a pinned CDN. Registered only with `docs.ui` and a socket.",
      tags: ["Docs"],
      enabledWhen: (resolved) =>
        resolved.docs !== false &&
        resolved.docs.ui &&
        isWebSocketEnabled(resolved),
      responses: { 200: null },
      handler: ({ res, services }) =>
        servePage(asyncApiUiPage({ config: services.config, cdn }), res),
    }),
  ];
}
