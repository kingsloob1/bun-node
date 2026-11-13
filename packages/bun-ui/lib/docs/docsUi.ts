/**
 * `docsUi()`: a {@link BunRouter} serving the API-docs viewer — the HTML shell
 * for every client route under `basePath`, the hashed bundle under
 * `<basePath>/assets/`, and a `document` thunk's document at
 * `<basePath>/document.json`.
 *
 * Like `jobsUi()`, its routes are registered **relative to the mount** (`/`,
 * `/*`, `/assets/:file`, `/document.json`), so it is mounted with
 * `app.use(ui.basePath, ui.router)` and `ui.router.fetch("/")` works on its
 * own. The mount path must equal `basePath`: the injected configuration and
 * every asset URL are built from it.
 */
import type { RouterHandler } from "@kingsleyweb/bun-common";
import type { ConfigFail } from "../kit/options";
import type { DocsUiConfig } from "./browser/config";
import type { DocsUi, DocsUiOptions } from "./types";
import { ConfigError, resolveLogger } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { ASSET_CACHE_CONTROL } from "../kit/browser/shared";
import {
  freezeConfig,
  normalizeMountPath,
  requireOptionsObject,
  resolveCommonOptions,
  resolveCsrfHeader,
} from "../kit/options";
import { ASSETS_SUBPATH, createUiRouter, problemSender } from "../kit/serve";
import { resolveThemeInput, themedAssets } from "../kit/theme";
import { resolveUnauthorized } from "../kit/unauthorized";
import { DEFAULT_DIST_DIR, DEFAULT_ENTRY, resolveAssetSource } from "./assets";
import { DEFAULT_EXTENSION_PREFIXES } from "./browser/config";
import { createShellRenderer, documentOriginSource } from "./shell";

/** The viewer's default mount path. */
export const DEFAULT_BASE_PATH = "/docs";

/** The default page title. */
export const DEFAULT_TITLE = "API docs";

/** The path under `basePath` a `document` thunk is served from. */
export const DOCUMENT_SUBPATH = "/document.json";

export { ASSET_CACHE_CONTROL, ASSETS_SUBPATH };

/** Every option error is bun-common's `ConfigError`, a dependency, not a peer. */
const fail: ConfigFail = (message, context) =>
  new ConfigError(message, context);

/** Its problems' `type`: `urn:bun-api-docs-ui:error:<code>`. */
const sendProblem = problemSender("urn:bun-api-docs-ui:error:");

/** An extension prefix (`x-bun-common`): `x-`, then a dotted-lowercase name. */
const EXTENSION_PREFIX = /^x-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Where the bundle comes from; tests point these at a fixture. */
export interface DocsUiInternals {
  /** The dist directory read when present. Defaults to the package's `dist/`. */
  distDir?: string;
  /** The entry built in memory without a dist. Defaults to `app/main.tsx`. */
  entry?: string;
}

/**
 * Validates and normalises an absolute mount path: absolute, trailing slashes
 * dropped, not `"/"`, and only segments of letters, digits, `_`, `.`, `~` and
 * `-`.
 */
export function normalizeBasePath(value: unknown, what: string): string {
  return normalizeMountPath(value, what, "viewer", fail);
}

/**
 * Validates a `document` URL: a same-origin absolute path (no `//`), or an
 * `http(s)://` URL without credentials whose path follows the segment rules.
 * The rules are checked on the **raw** string, because `new URL()` has already
 * resolved `..`, percent-encoded a space and turned `\` into `/`.
 */
function resolveDocumentUrl(documentUrl: string): string {
  if (documentUrl === "") {
    throw new ConfigError(
      "document must be an absolute path, an http(s) URL or a thunk",
      { document: documentUrl },
    );
  }
  if (documentUrl.startsWith("/") && !documentUrl.startsWith("//")) {
    normalizeBasePath(documentUrl.split(/[?#]/)[0], "document");
    return documentUrl;
  }
  let url: URL;
  try {
    url = new URL(documentUrl);
  } catch {
    throw new ConfigError(
      "document must be an absolute path, an http(s) URL or a thunk",
      { document: documentUrl },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("document must use http: or https:", {
      document: documentUrl,
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("document may not carry credentials", {
      document: documentUrl,
    });
  }
  const rawPath = /^https?:\/\/[^/?#]*([^?#]*)/i.exec(documentUrl)?.[1] ?? "";
  const path = /^\/*$/.test(rawPath)
    ? ""
    : normalizeBasePath(rawPath, "document");
  if (url.pathname.replace(/\/+$/, "") !== path) {
    throw new ConfigError(
      `document's path may only contain "/"-separated segments of letters, digits, "_", ".", "~" and "-"`,
      { document: documentUrl },
    );
  }
  return documentUrl;
}

/** Validates `extensions`. */
function resolveExtensions(value: unknown): readonly string[] {
  if (value === undefined) {
    return DEFAULT_EXTENSION_PREFIXES;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(
      "extensions must be a non-empty array of extension prefixes",
      { extensions: value },
    );
  }
  for (const prefix of value) {
    if (typeof prefix !== "string" || !EXTENSION_PREFIX.test(prefix)) {
      throw new ConfigError(
        `extensions entries must look like "x-bun-common": "x-", then a lowercase name`,
        { extensions: value },
      );
    }
  }
  return Object.freeze([...value]);
}

/**
 * Creates the viewer with an explicit bundle source. {@link docsUi} is this
 * with the package's own `dist/` and `app/main.tsx`; tests point it at a
 * fixture.
 */
export function createDocsUi(
  options: DocsUiOptions,
  internals: DocsUiInternals = {},
): DocsUi {
  requireOptionsObject(options, "docsUi()", fail);
  const { document } = options;
  const thunk = typeof document === "function" ? document : undefined;
  if (thunk === undefined && typeof document !== "string") {
    throw new ConfigError(
      "document must be an absolute path, an http(s) URL or a thunk",
      { document },
    );
  }

  const basePath = normalizeBasePath(
    options.basePath ?? DEFAULT_BASE_PATH,
    "basePath",
  );
  const { title, middleware } = resolveCommonOptions(
    options,
    DEFAULT_TITLE,
    fail,
  );

  const documentUrl =
    thunk !== undefined
      ? `${basePath}${DOCUMENT_SUBPATH}`
      : resolveDocumentUrl(document as string);

  // The starting scheme goes to the browser; colours become a stylesheet.
  const theme = resolveThemeInput(options.theme, fail);
  const config = freezeConfig<DocsUiConfig>({
    version: 1,
    title,
    basePath,
    assetsPath: `${basePath}${ASSETS_SUBPATH}`,
    documentUrl,
    csrfHeader: resolveCsrfHeader(options.csrfHeader, () => null, fail),
    extensions: resolveExtensions(options.extensions),
    theme: theme.mode,
    unauthorized: resolveUnauthorized(options.unauthorized, basePath, fail),
  });

  const logger = resolveLogger(options.logger).child({
    component: "api-docs-ui",
  });
  const loadAssets = themedAssets(
    theme,
    resolveAssetSource({
      dev: options.dev,
      distDir: internals.distDir ?? DEFAULT_DIST_DIR,
      entry: internals.entry ?? DEFAULT_ENTRY,
      logger,
    }),
    (message) => {
      logger.warn(message);
    },
  );

  // A cross-origin document URL is the one connection beyond this origin.
  const origin = documentOriginSource(documentUrl);
  const connectSrc = origin === undefined ? [] : [origin];

  /** Serves a `document` thunk's document. */
  const serveDocument: RouterHandler = async (req, res) => {
    if (thunk === undefined) {
      sendProblem(
        req,
        res,
        404,
        "NOT_FOUND",
        "Not found",
        `No document ${req.path}`,
      );
      return;
    }
    let body: object;
    try {
      body = await thunk();
    } catch (error) {
      logger.error("api docs ui document thunk threw", { error });
      sendProblem(
        req,
        res,
        500,
        "INTERNAL",
        "Internal server error",
        "Internal server error",
      );
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      logger.error("api docs ui document thunk returned no object", {});
      sendProblem(
        req,
        res,
        500,
        "INTERNAL",
        "Internal server error",
        "Internal server error",
      );
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = JSON.stringify(body);
    if (req.method === "HEAD") {
      res.setHeader("Content-Length", String(Buffer.byteLength(json)));
      void res.end();
      return;
    }
    res.send(json);
  };

  const router = createUiRouter({
    label: "api docs ui",
    logger,
    problem: sendProblem,
    loadAssets,
    createRenderer: (assets) => createShellRenderer(config, assets),
    connectSrc: () => connectSrc,
    middleware,
    authorize: options.authorize,
    unauthorized: config.unauthorized,
    routes: [{ path: DOCUMENT_SUBPATH, handler: serveDocument }],
  });

  return Object.freeze({ router, basePath, config });
}

/**
 * Creates the API-docs viewer: validates the options (throwing `ConfigError`
 * for anything unusable), resolves the configuration the app is given, and
 * builds the router.
 *
 * ```ts
 * const ui = docsUi({ document: () => api.openapi(), basePath: "/docs" });
 * app.use(ui.basePath, ui.router);
 * ```
 */
export function docsUi(options: DocsUiOptions): DocsUi {
  return createDocsUi(options);
}
