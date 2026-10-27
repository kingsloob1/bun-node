/**
 * The `"self-hosted"` docs viewer (AD (f) F2): the pages and assets of
 * `@kingsleyweb/bun-api-docs-ui`, served from this origin — nothing from a
 * CDN. Where the CDN viewers (./viewer) load a pinned third-party bundle,
 * this serves the package's own prebuilt one: hash-named immutable files,
 * SRI computed over the local bytes when the bundle is read, and the strict
 * self-only CSP (`default-src 'self'; script-src 'self' 'nonce-…'; style-src
 * 'self'`).
 *
 * The package is an **optional peer**: naming the viewer without it installed
 * is a {@link ConfigError} at `docsRouter()` construction, naming the fix.
 *
 * The viewer is a small client-routed app: the OpenAPI page is the mount
 * root (`/`) with its reference under `/http`, and the AsyncAPI page is
 * `/asyncapi` with its reference under `/asyncapi/ws`; both load the hashed
 * bundle from `<mount>/assets/`. The documents are the router's own JSON
 * routes, same-origin, so the page's `connect-src` stays `'self'`.
 */
import type { BunRequest } from "../BunRequest";
import type { BunResponse } from "../BunResponse";
import type { BunRouter } from "../BunRouter";
import { createRequire } from "node:module";
import { ConfigError } from "../errors";
import { noopLogger } from "../logging";

/** The optional peer's package name, in every message that names it. */
export const SELF_HOSTED_PACKAGE = "@kingsleyweb/bun-api-docs-ui";

/** The subpath of the peer this module loads. */
const HOSTED_SUBPATH = `${SELF_HOSTED_PACKAGE}/lib/hosted`;

/** A viewer page's own options (the `{ name, ...options }` pass-through). */
export interface SelfHostedViewerOptions {
  /** Initial colour scheme: `"system"` (default), `"light"` or `"dark"`. */
  theme?: "system" | "light" | "dark";
  /**
   * The specification-extension prefixes the viewer reads, first hit
   * winning. Default: `["x-bun-common", "x-bun-jobs"]`.
   */
  extensions?: readonly string[];
  /** The CSRF header the try-it panel adds on mutations, or `false` for none. */
  csrfHeader?: string | false;
}

/** One document the self-hosted viewer shows. */
export interface SelfHostedDocument {
  /** The document, read per request (a page's title falls back to its `info.title`). */
  document: () => Record<string, unknown>;
  /** Its JSON route's path under the mount (e.g. `"/openapi.json"`). */
  path: string;
  /** The `{ name, ...options }` pass-through. */
  options: SelfHostedViewerOptions;
}

/** A document with its pass-through options resolved. */
interface ResolvedDocument extends SelfHostedDocument {
  /** The resolved pass-through. */
  resolved: Pick<HostedConfig, "csrfHeader" | "extensions" | "theme">;
}

/** What {@link registerSelfHostedViewer} registers. */
export interface SelfHostedRegistration {
  /** The OpenAPI page: the mount root and `/http/*`. */
  openapi?: SelfHostedDocument;
  /** The AsyncAPI page: `/asyncapi` and `/asyncapi/ws/*`. */
  asyncapi?: SelfHostedDocument;
}

/* ------------------------------------------------------------------ *
 * The peer, loaded lazily and structurally: no `import`, so nothing of
 * it reaches the declarations (a consumer without the peer never sees a
 * type error for it), and the require failure is the ConfigError.
 * ------------------------------------------------------------------ */

/** One served bundle file (the peer's `UiAsset`, mirrored). */
interface HostedAsset {
  /** The hashed file name. */
  name: string;
  /** The bytes served. */
  body: Uint8Array;
  /** The `Content-Type`. */
  type: string;
  /** The size in bytes. */
  size: number;
  /** The `sha384-…` SRI digest of the local bytes. */
  integrity: string;
  /** The ETag. */
  etag: string;
}

/** The resolved bundle (the peer's `UiAssets`, mirrored). */
interface HostedAssets {
  /** The files the shell links. */
  entry: { js: string; css: string[] };
  /** Every file, by hashed name. */
  files: ReadonlyMap<string, HostedAsset>;
}

/** The viewer's page configuration (the peer's `DocsUiConfig`, mirrored). */
interface HostedConfig {
  version: 1;
  title: string;
  basePath: string;
  assetsPath: string;
  documentUrl: string;
  csrfHeader: string | null;
  extensions: readonly string[];
  theme: "system" | "light" | "dark";
}

/** The slice of the peer's `lib/hosted` this module uses. */
interface HostedModule {
  /** Resolves the bundle: the prebuilt `dist/` when present, else an in-memory build on first use. */
  resolveHostedAssets: (logger: unknown) => () => Promise<HostedAssets>;
  /** Prepares the shell for a config and a bundle; the result splices a nonce in. */
  createShellRenderer: (
    config: HostedConfig,
    assets: HostedAssets,
  ) => (nonce: string) => string;
  /** The page's Content-Security-Policy for a nonce. */
  cspHeader: (options: { nonce: string }) => string;
  /** A fresh nonce. */
  createNonce: () => string;
}

/** Test seam: how the peer is loaded. */
export interface SelfHostedInternals {
  /** Replaces the module `require` (the missing-package test). */
  require?: (specifier: string) => unknown;
}

/** Loads the peer, or fails naming the install. */
function defaultLoad(internals: SelfHostedInternals): HostedModule {
  const require = internals.require ?? createRequire(import.meta.url);
  try {
    return require(HOSTED_SUBPATH) as HostedModule;
  } catch {
    throw new ConfigError(
      `the "self-hosted" docs viewer needs ${SELF_HOSTED_PACKAGE} installed: \`bun add ${SELF_HOSTED_PACKAGE}\``,
      { package: SELF_HOSTED_PACKAGE },
    );
  }
}

/** The pass-through options, checked (a bad one is a ConfigError at construction). */
function resolveOptions(
  options: SelfHostedViewerOptions,
  what: string,
): Pick<HostedConfig, "csrfHeader" | "extensions" | "theme"> {
  const theme = options.theme ?? "system";
  if (theme !== "system" && theme !== "light" && theme !== "dark") {
    throw new ConfigError(
      `${what}: theme must be "system", "light" or "dark"`,
      { theme: options.theme },
    );
  }
  const extensions = options.extensions ?? ["x-bun-common", "x-bun-jobs"];
  if (
    !Array.isArray(extensions) ||
    extensions.length === 0 ||
    !extensions.every(
      (prefix) =>
        typeof prefix === "string" &&
        /^x-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(prefix),
    )
  ) {
    throw new ConfigError(
      `${what}: extensions must be a non-empty array of prefixes like "x-bun-common"`,
      { extensions: options.extensions },
    );
  }
  const csrfHeader = options.csrfHeader ?? null;
  if (csrfHeader !== null && typeof csrfHeader !== "string") {
    throw new ConfigError(
      `${what}: csrfHeader must be a header name or false`,
      {
        csrfHeader: options.csrfHeader,
      },
    );
  }
  return { theme, extensions, csrfHeader };
}

/** The `info.title` of a document, when it is one. */
function infoTitle(document: Record<string, unknown>): string | undefined {
  const info = document.info;
  if (typeof info !== "object" || info === null) {
    return undefined;
  }
  const title = (info as { title?: unknown }).title;
  return typeof title === "string" && title !== "" ? title : undefined;
}

/**
 * Registers the self-hosted viewer's routes on `router` (the paths are
 * relative to the mount, as the router's own are): the shell for each
 * document's page and its client routes, and the hashed bundle under
 * `/assets/`. The peer is loaded here, so naming the viewer without it
 * installed fails the `docsRouter()` call.
 */
export function registerSelfHostedViewer(
  router: BunRouter,
  registration: SelfHostedRegistration,
  title: string | undefined,
  internals: SelfHostedInternals = {},
): void {
  if (
    registration.openapi === undefined &&
    registration.asyncapi === undefined
  ) {
    return;
  }
  const mod = defaultLoad(internals);
  // The pass-through options are validated here, at construction, with the
  // peer's load: a bad one never waits for a request.
  const resolved = {
    openapi:
      registration.openapi === undefined
        ? undefined
        : {
            ...registration.openapi,
            resolved: resolveOptions(
              registration.openapi.options,
              "the openapi viewer",
            ),
          },
    asyncapi:
      registration.asyncapi === undefined
        ? undefined
        : {
            ...registration.asyncapi,
            resolved: resolveOptions(
              registration.asyncapi.options,
              "the asyncapi viewer",
            ),
          },
  };
  const loadAssets = mod.resolveHostedAssets(noopLogger);
  /** The bundle, shared by every route; a failure answers 500, logged nowhere (the peer logs the build notice). */
  let bundle: Promise<HostedAssets> | undefined;
  const ready = (): Promise<HostedAssets> => (bundle ??= loadAssets());

  /** A renderer per mount path and page (the config is fixed for both). */
  const renderers = new Map<string, (nonce: string) => string>();

  /** Serves one page's shell. `basePath` is the page's client-route root. */
  const servePage =
    (
      page: ResolvedDocument,
      kind: "openapi" | "asyncapi",
    ): ((req: BunRequest, res: BunResponse) => Promise<void>) =>
    async (req, res) => {
      let assets: HostedAssets;
      try {
        assets = await ready();
      } catch {
        res.status(500);
        res.setHeader("Content-Type", "application/problem+json");
        res.send(
          JSON.stringify({
            type: "urn:bun-common:error:DOCS_VIEWER_BUNDLE",
            title: "The documentation viewer's bundle could not be built",
            status: 500,
            code: "DOCS_VIEWER_BUNDLE",
          }),
        );
        return;
      }
      const base = req.baseUrl;
      const basePath = kind === "asyncapi" ? `${base}/asyncapi` : base;
      const key = `${kind}${basePath}`;
      let render = renderers.get(key);
      if (render === undefined) {
        const config: HostedConfig = {
          version: 1,
          title: title ?? infoTitle(page.document()) ?? "API documentation",
          basePath,
          assetsPath: `${base}/assets`,
          documentUrl: `${base}${page.path}`,
          ...page.resolved,
        };
        render = mod.createShellRenderer(config, assets);
        renderers.set(key, render);
      }
      const nonce = mod.createNonce();
      res.status(200);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", mod.cspHeader({ nonce }));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (req.method === "HEAD") {
        void res.end();
        return;
      }
      res.send(render(nonce));
    };

  /** Serves one bundle file. */
  const serveAsset = async (
    req: BunRequest,
    res: BunResponse,
  ): Promise<void> => {
    let assets: HostedAssets;
    try {
      assets = await ready();
    } catch {
      res.status(500);
      void res.end();
      return;
    }
    const name = (req.params as Record<string, string | undefined>).file;
    const file = name === undefined ? undefined : assets.files.get(name);
    if (file === undefined) {
      res.status(404);
      res.setHeader("Content-Type", "application/problem+json");
      res.setHeader("Cache-Control", "no-store");
      res.send(
        JSON.stringify({
          type: "urn:bun-common:error:NOT_FOUND",
          title: "Not found",
          status: 404,
          code: "NOT_FOUND",
          detail: `No asset ${req.path}`,
        }),
      );
      return;
    }
    res.setHeader("Content-Type", file.type);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", file.etag);
    res.setHeader("X-Content-Type-Options", "nosniff");
    const match = req.get("if-none-match");
    if (
      match !== null &&
      match
        .split(",")
        .some((tag) => tag.trim().replace(/^W\//, "") === file.etag)
    ) {
      res.status(304);
      void res.end();
      return;
    }
    res.status(200);
    if (req.method === "HEAD") {
      res.setHeader("Content-Length", String(file.size));
      void res.end();
      return;
    }
    res.send(file.body);
  };

  const hide = { hidden: true } as const;
  for (const verb of ["get", "head"] as const) {
    const register = router[verb].bind(router) as unknown as (
      path: string,
      handler: (req: BunRequest, res: BunResponse) => Promise<void>,
    ) => { describe: (meta: typeof hide) => void };
    register("/assets/:file", serveAsset).describe(hide);
  }
  if (resolved.openapi !== undefined) {
    const page = servePage(resolved.openapi, "openapi");
    for (const path of ["/", "/http", "/http/*"]) {
      router.get(path, page).describe(hide);
      router.head(path, page).describe(hide);
    }
  }
  if (resolved.asyncapi !== undefined) {
    const page = servePage(resolved.asyncapi, "asyncapi");
    for (const path of ["/asyncapi", "/asyncapi/ws", "/asyncapi/ws/*"]) {
      router.get(path, page).describe(hide);
      router.head(path, page).describe(hide);
    }
  }
}
