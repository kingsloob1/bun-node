/**
 * {@link docsRouter} (AD (c), plan `docs/plans/api-docs-generation/` §7.1): a
 * mountable router serving the OpenAPI document — and, when one is handed in,
 * the AsyncAPI document — plus, only when `viewer` asks for them, the
 * pinned-CDN viewer pages (`./viewer`).
 *
 * ```ts
 * app.use("/docs", docsRouter({
 *   openapi: () => generateOpenApi(app, …).document,   // re-read per request
 *   viewer: { openapi: "scalar" },                      // the default viewer
 * }));
 * ```
 *
 * The JSON is always served and costs nothing; the pages are **off by
 * default**, because they load third-party script into an origin that may
 * hold session cookies and "try it out" is a mutation console. Every route
 * the router registers is `.describe({ hidden: true })`, so a later
 * `generateOpenApi` over the parent never documents the docs.
 *
 * The AsyncAPI side covers any realtime or event-driven mechanism OpenAPI
 * cannot document (WebSocket, Kafka, AMQP, MQTT, SSE, …) — it is not tied to
 * a transport; the document is hand-supplied until phase (e)'s generator.
 *
 * Misconfiguration is a {@link ConfigError} at construction: neither document
 * given, a `viewer` page without its document, an unknown viewer name, or a
 * bad `cdn` ({@link resolveDocsCdn} runs here, not on the first request).
 */
import type { BunRequest } from "../BunRequest";
import type { BunResponse } from "../BunResponse";
import { BunRouter } from "../BunRouter";
import { ConfigError } from "../errors";
import type { RouterHandler } from "../types/general";
import type { AsyncApiDocument, OpenApiDocument } from "./types";
import type { DocsCdnOptions, DocsPage } from "./viewer";
import {
  asyncApiUiPage,
  DOCS_CDN,
  rapidocPage,
  redocPage,
  resolveDocsCdn,
  scalarPage,
  swaggerUiPage,
} from "./viewer";

/**
 * The viewers an OpenAPI page can use. `"scalar"` is the default — docsRouter
 * is a new, opt-in surface, so the modern default is free of compat weight.
 */
export type OpenApiViewerName = "scalar" | "swagger-ui" | "redoc" | "rapidoc";

/**
 * The viewers an AsyncAPI page can use. `"asyncapi"` (the official component)
 * is the default; `"scalar"` renders the AsyncAPI document too, but its
 * AsyncAPI support is upstream work-in-progress — opt in knowingly.
 */
export type AsyncApiViewerName = "asyncapi" | "scalar";

/**
 * One viewer page's declaration: the viewer's name as a string (defaults
 * applying), or `{ name, ...options }` — the remaining properties are passed
 * through to the viewer's own configuration (spread into the initialiser
 * config for swagger-ui/Scalar/Redoc, assigned as element properties for
 * RapiDoc, spread into `config` for the AsyncAPI component).
 */
export interface ViewerConfig<Name extends string = string> {
  /** The viewer. Default: the document's own (`"scalar"`, `"asyncapi"`). */
  name?: Name;
  /** The viewer's own configuration options, passed through. */
  [option: string]: unknown;
}

/** Options for {@link docsRouter}. */
export interface DocsRouterOptions {
  /**
   * The OpenAPI document, or a function returning a fresh one (re-read per
   * request). Required unless `asyncapi` is given.
   */
  openapi?: OpenApiDocument | (() => OpenApiDocument);
  /**
   * The AsyncAPI document, or a function returning one. Default: none, and
   * the route (and its page) is absent. Any realtime/event-driven API OpenAPI
   * cannot document belongs here — not only WebSocket. AD (e) tightened this
   * from a structural `AsyncApiDocumentLike` to the generator's own
   * `AsyncApiDocument` (a deliberate, announced tightening: the real type
   * satisfies the structural one — pin the literal, `asyncapi: "3.0.0"`).
   */
  asyncapi?: AsyncApiDocument | (() => AsyncApiDocument);
  /** Where the OpenAPI JSON is served, under the mount. Default: `"/openapi.json"`. */
  openapiPath?: string;
  /** Where the AsyncAPI JSON is served. Default: `"/asyncapi.json"`. */
  asyncapiPath?: string;
  /**
   * The viewer pages. **Default: neither is served** — they load third-party
   * script into an origin that may hold session cookies, and "try it out" is
   * a mutation console. The JSON costs nothing and is always served.
   */
  viewer?: {
    /**
     * The OpenAPI viewer page, served at the mount root (`/`): the viewer's
     * name (a string, defaults applying — `"scalar"`) or
     * `{ name, ...options }`. Default: not served.
     */
    openapi?: OpenApiViewerName | ViewerConfig<OpenApiViewerName>;
    /**
     * The AsyncAPI viewer page, served at `/asyncapi`: the viewer's name
     * (defaults applying — `"asyncapi"`) or `{ name, ...options }`. Requires
     * `asyncapi`. Default: not served.
     */
    asyncapi?: AsyncApiViewerName | ViewerConfig<AsyncApiViewerName>;
  };
  /** Page title. Default: the document's `info.title`. */
  title?: string;
  /**
   * CDN pins and mirror base URL ({@link DocsCdnOptions}). Default: the
   * built-in pins ({@link DOCS_CDN}).
   */
  cdn?: DocsCdnOptions;
  /** Runs before every docs route — put authorization here. Default: none. */
  authorize?: RouterHandler;
}

/** The document's `info.title`, when it is a non-empty string. */
function infoTitle(document: Record<string, unknown>): string | undefined {
  const info = document.info;
  if (typeof info !== "object" || info === null) return undefined;
  const title = (info as { title?: unknown }).title;
  return typeof title === "string" && title !== "" ? title : undefined;
}

/** One viewer declaration, checked and normalised to `{ name, options }`. */
function normalizeViewer<Name extends string>(
  spec: Name | ViewerConfig<Name>,
  defaultName: Name,
  allowed: readonly Name[],
  what: string,
): { name: Name; options: Record<string, unknown> } {
  if (
    typeof spec !== "string" &&
    (typeof spec !== "object" || spec === null || Array.isArray(spec))
  ) {
    throw new ConfigError(
      `${what}: pass a viewer name or a { name, ...options } object`,
      { spec },
    );
  }
  const config: ViewerConfig<Name> =
    typeof spec === "string" ? { name: spec } : spec;
  const { name = defaultName, ...options } = config;
  if (!allowed.includes(name)) {
    throw new ConfigError(
      `${what}: unknown viewer ${JSON.stringify(name)} — one of ${allowed
        .map((one) => JSON.stringify(one))
        .join(", ")}`,
      { name },
    );
  }
  return { name, options };
}

const OPENAPI_VIEWERS: readonly OpenApiViewerName[] = [
  "scalar",
  "swagger-ui",
  "redoc",
  "rapidoc",
];
const ASYNCAPI_VIEWERS: readonly AsyncApiViewerName[] = ["asyncapi", "scalar"];

/**
 * A mountable router serving the documents and, optionally, the viewer pages.
 *
 * The viewer pages point at their document resolved per request from
 * `req.baseUrl`, so the router does not need to know where it is mounted:
 * under `app.use("/docs", docsRouter(…))` the page fetches
 * `/docs/openapi.json`.
 *
 * @param options See {@link DocsRouterOptions}.
 * @throws ConfigError when neither `openapi` nor `asyncapi` is given, when a
 *   `viewer` page has no document to point at, when a viewer name is unknown,
 *   or for a bad `cdn` (resolved at construction, so a bad pin fails fast).
 */
export function docsRouter(options: DocsRouterOptions): BunRouter {
  if (options.openapi === undefined && options.asyncapi === undefined) {
    throw new ConfigError(
      "docsRouter(): pass `openapi`, `asyncapi`, or both — there is nothing to serve otherwise",
    );
  }
  // Resolved once, here, so a bad `cdn` fails at construction rather than on
  // the first page request.
  const cdn = resolveDocsCdn(DOCS_CDN, options.cdn);
  const openapiPath = options.openapiPath ?? "/openapi.json";
  const asyncapiPath = options.asyncapiPath ?? "/asyncapi.json";

  /* The viewer pages, normalised (an unknown name fails at construction). */
  const openApiViewer =
    options.viewer?.openapi === undefined
      ? undefined
      : normalizeViewer(
          options.viewer.openapi,
          "scalar",
          OPENAPI_VIEWERS,
          "docsRouter's viewer.openapi",
        );
  const asyncApiViewer =
    options.viewer?.asyncapi === undefined
      ? undefined
      : normalizeViewer(
          options.viewer.asyncapi,
          "asyncapi",
          ASYNCAPI_VIEWERS,
          "docsRouter's viewer.asyncapi",
        );
  if (openApiViewer !== undefined && options.openapi === undefined) {
    throw new ConfigError(
      "docsRouter(): viewer.openapi is set but there is no `openapi` document to point the page at",
    );
  }
  if (asyncApiViewer !== undefined && options.asyncapi === undefined) {
    throw new ConfigError(
      "docsRouter(): viewer.asyncapi is set but there is no `asyncapi` document to point the page at",
    );
  }

  const router = new BunRouter();
  if (options.authorize !== undefined) {
    router.use(options.authorize);
  }

  /** A document's current value: itself, or its thunk's fresh return. */
  const openApiSource = options.openapi;
  const openApi =
    openApiSource === undefined
      ? undefined
      : () =>
          typeof openApiSource === "function" ? openApiSource() : openApiSource;
  const asyncApiSource = options.asyncapi;
  const asyncApi =
    asyncApiSource === undefined
      ? undefined
      : () =>
          typeof asyncApiSource === "function"
            ? asyncApiSource()
            : asyncApiSource;

  /** Serves a generated page, writing the response itself. */
  const servePage = (page: DocsPage, res: BunResponse): void => {
    for (const [name, value] of Object.entries(page.headers)) {
      res.setHeader(name, value);
    }
    res.status(200);
    res.send(page.html);
  };

  if (openApi !== undefined) {
    router
      .get(openapiPath, (_req: BunRequest, res: BunResponse) => {
        res.json(openApi());
      })
      .describe({ hidden: true });
  }
  if (asyncApi !== undefined) {
    router
      .get(asyncapiPath, (_req: BunRequest, res: BunResponse) => {
        res.json(asyncApi());
      })
      .describe({ hidden: true });
  }

  if (openApiViewer !== undefined && openApi !== undefined) {
    const viewer = openApiViewer;
    router
      .get("/", (req: BunRequest, res: BunResponse) => {
        const document = openApi();
        const base = {
          title: options.title ?? infoTitle(document) ?? "API documentation",
          documentUrl: `${req.baseUrl}${openapiPath}`,
          options: viewer.options,
        };
        servePage(
          viewer.name === "scalar"
            ? scalarPage({ cdn, ...base })
            : viewer.name === "swagger-ui"
              ? swaggerUiPage({ cdn, ...base })
              : viewer.name === "redoc"
                ? redocPage({ cdn, ...base })
                : rapidocPage({ cdn, ...base }),
          res,
        );
      })
      .describe({ hidden: true });
  }
  if (asyncApiViewer !== undefined && asyncApi !== undefined) {
    const viewer = asyncApiViewer;
    router
      .get("/asyncapi", (req: BunRequest, res: BunResponse) => {
        const document = asyncApi();
        const base = {
          title: options.title ?? infoTitle(document) ?? "API documentation",
          documentUrl: `${req.baseUrl}${asyncapiPath}`,
          options: viewer.options,
        };
        servePage(
          viewer.name === "asyncapi"
            ? asyncApiUiPage({ cdn, ...base })
            : scalarPage({ cdn, ...base, documentKind: "AsyncAPI" }),
          res,
        );
      })
      .describe({ hidden: true });
  }
  return router;
}
