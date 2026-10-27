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
import type {
  BunRequest,
  BunResponse,
  Logger,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type { UiAsset, UiAssets } from "./assets";
import type { DocsUiConfig, DocsUiTheme } from "./shared/config";
import type { ShellRenderer } from "./shell";
import type {
  DocsUi,
  DocsUiAuthorize,
  DocsUiAuthorizeContext,
  DocsUiOptions,
} from "./types";
import { BunRouter, ConfigError, resolveLogger } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { DEFAULT_DIST_DIR, DEFAULT_ENTRY, resolveAssetSource } from "./assets";
import { DEFAULT_EXTENSION_PREFIXES } from "./shared/config";
import {
  createNonce,
  createShellRenderer,
  cspHeader,
  documentOriginSource,
} from "./shell";

/** The viewer's default mount path. */
export const DEFAULT_BASE_PATH = "/docs";

/** The default page title. */
export const DEFAULT_TITLE = "API docs";

/** The path under `basePath` the bundle is served from. */
export const ASSETS_SUBPATH = "/assets";

/** The path under `basePath` a `document` thunk is served from. */
export const DOCUMENT_SUBPATH = "/document.json";

/** `Cache-Control` for hashed bundle files: their name changes with their content. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** A path segment `basePath` may contain — the bun-jobs API's own rule. */
const PATH_SEGMENT = /^[\w.~-]+$/;

/** A header name (an RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^`|~\w-]+$/;

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
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new ConfigError(
      `${what} must be an absolute path starting with "/"`,
      {
        value,
      },
    );
  }
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed === "") {
    throw new ConfigError(
      `${what} may not be "/": the viewer's catch-all would answer for every GET route of the host`,
      { value },
    );
  }
  for (const segment of trimmed.slice(1).split("/")) {
    if (!PATH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new ConfigError(
        `${what} may only contain "/"-separated segments of letters, digits, "_", ".", "~" and "-"`,
        { value },
      );
    }
  }
  return trimmed;
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

/** Validates `theme`. */
function resolveTheme(value: unknown): DocsUiTheme {
  if (value === undefined) {
    return "system";
  }
  if (value === "system" || value === "light" || value === "dark") {
    return value;
  }
  throw new ConfigError(`theme must be "system", "light" or "dark"`, {
    value,
  });
}

/** Validates `csrfHeader`. */
function resolveCsrfHeader(value: unknown): string | null {
  if (value === undefined || value === false) {
    return null;
  }
  if (typeof value !== "string" || !HEADER_NAME.test(value)) {
    throw new ConfigError("csrfHeader must be a header name or false", {
      value,
    });
  }
  return value;
}

/** A frozen copy of the config, nested objects included. */
function freezeConfig(config: DocsUiConfig): Readonly<DocsUiConfig> {
  for (const value of Object.values(config)) {
    if (typeof value === "object" && value !== null) {
      Object.freeze(value);
    }
  }
  return Object.freeze(config);
}

/** Sends an RFC 9457 problem. */
function sendProblem(
  req: BunRequest,
  res: BunResponse,
  status: number,
  code: string,
  title: string,
  detail: string,
): void {
  res.status(status);
  res.setHeader("Content-Type", "application/problem+json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") {
    void res.end();
    return;
  }
  res.send(
    JSON.stringify({
      type: `urn:bun-api-docs-ui:error:${code}`,
      title,
      status,
      code,
      detail,
      instance: req.path,
    }),
  );
}

/**
 * Normalises an `authorize` answer: a denial is 401 only for `status: 401`,
 * 403 for any other status, and anything unrecognised denies with 403.
 */
function decide(result: unknown):
  | { allow: true }
  | {
      allow: false;
      status: 401 | 403;
      reason?: string;
    } {
  if (result === true) {
    return { allow: true };
  }
  if (typeof result === "object" && result !== null && "allow" in result) {
    const answer = result as {
      allow: unknown;
      status?: unknown;
      reason?: unknown;
    };
    if (answer.allow === true) {
      return { allow: true };
    }
    if (answer.allow === false) {
      return {
        allow: false,
        status: answer.status === 401 ? 401 : 403,
        ...(typeof answer.reason === "string" && answer.reason !== ""
          ? { reason: answer.reason }
          : {}),
      };
    }
  }
  return { allow: false, status: 403 };
}

/** The `authorize` step of every viewer route. */
function authorizeStep(
  authorize: DocsUiAuthorize,
  asset: boolean,
  logger: Logger,
): RouterHandler {
  return async (req, res, next) => {
    const context: DocsUiAuthorizeContext = { asset, path: req.path };
    let decision: ReturnType<typeof decide>;
    try {
      decision = decide(await authorize(req, context));
    } catch (error) {
      logger.error("api docs ui authorize threw; refusing the request", {
        error,
        path: req.path,
      });
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
    if (decision.allow) {
      return next();
    }
    if (decision.status === 401) {
      sendProblem(
        req,
        res,
        401,
        "UNAUTHORIZED",
        "Authentication required",
        decision.reason ?? "Authentication required",
      );
    } else {
      sendProblem(
        req,
        res,
        403,
        "FORBIDDEN",
        "Forbidden",
        decision.reason ?? "Not allowed to open this page",
      );
    }
  };
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
  if (typeof options !== "object" || options === null) {
    throw new ConfigError("docsUi() needs an options object", {});
  }
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
  const title = options.title ?? DEFAULT_TITLE;
  if (typeof title !== "string" || title.trim() === "") {
    throw new ConfigError("title must be a non-empty string", { title });
  }
  const middleware = options.middleware ?? [];
  if (
    !Array.isArray(middleware) ||
    !middleware.every((handler) => typeof handler === "function")
  ) {
    throw new ConfigError("middleware must be an array of functions", {});
  }
  if (
    options.authorize !== undefined &&
    typeof options.authorize !== "function"
  ) {
    throw new ConfigError("authorize must be a function", {});
  }
  if (options.dev !== undefined && typeof options.dev !== "boolean") {
    throw new ConfigError("dev must be a boolean", { dev: options.dev });
  }

  const documentUrl =
    thunk !== undefined
      ? `${basePath}${DOCUMENT_SUBPATH}`
      : resolveDocumentUrl(document as string);

  const config = freezeConfig({
    version: 1,
    title,
    basePath,
    assetsPath: `${basePath}${ASSETS_SUBPATH}`,
    documentUrl,
    csrfHeader: resolveCsrfHeader(options.csrfHeader),
    extensions: resolveExtensions(options.extensions),
    theme: resolveTheme(options.theme),
  });

  const logger = resolveLogger(options.logger).child({
    component: "api-docs-ui",
  });
  const loadAssets = resolveAssetSource({
    dev: options.dev,
    distDir: internals.distDir ?? DEFAULT_DIST_DIR,
    entry: internals.entry ?? DEFAULT_ENTRY,
    logger,
  });

  // The shell is rendered from the bundle, so it waits for the first load.
  let renderer: { assets: UiAssets; render: ShellRenderer } | undefined;
  const ready = async (): Promise<{
    assets: UiAssets;
    render: ShellRenderer;
  }> => {
    if (renderer === undefined) {
      const assets = await loadAssets();
      renderer ??= { assets, render: createShellRenderer(config, assets) };
    }
    return renderer;
  };
  /** Loads the bundle, or answers 500 and returns `undefined`. */
  const readyOrFail = async (
    req: BunRequest,
    res: BunResponse,
  ): Promise<{ assets: UiAssets; render: ShellRenderer } | undefined> => {
    try {
      return await ready();
    } catch (error) {
      logger.error("api docs ui could not load its bundle", { error });
      sendProblem(
        req,
        res,
        500,
        "INTERNAL",
        "Internal server error",
        "Internal server error",
      );
      return undefined;
    }
  };

  // A cross-origin document URL is the one connection beyond this origin.
  const origin = documentOriginSource(documentUrl);
  const connectSrc = origin === undefined ? [] : [origin];
  const serveShell: RouterHandler = async (req, res) => {
    const loaded = await readyOrFail(req, res);
    if (!loaded) {
      return;
    }
    const nonce = createNonce();
    const html = loaded.render(nonce);
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", cspHeader({ nonce, connectSrc }));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method === "HEAD") {
      void res.end();
      return;
    }
    res.send(html);
  };

  const serveAsset: RouterHandler = async (req, res) => {
    const loaded = await readyOrFail(req, res);
    if (!loaded) {
      return;
    }
    const name = (req.params as Record<string, string | undefined>).file;
    const file: UiAsset | undefined =
      name === undefined ? undefined : loaded.assets.files.get(name);
    if (file === undefined) {
      sendProblem(
        req,
        res,
        404,
        "NOT_FOUND",
        "Not found",
        `No asset ${req.path}`,
      );
      return;
    }
    res.setHeader("Content-Type", file.type);
    res.setHeader("Cache-Control", ASSET_CACHE_CONTROL);
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

  const notFound: RouterHandler = (req, res) => {
    sendProblem(
      req,
      res,
      404,
      "NOT_FOUND",
      "Not found",
      `No asset ${req.path}`,
    );
  };

  const guards = (asset: boolean): RouterHandler[] => [
    ...middleware,
    ...(options.authorize
      ? [authorizeStep(options.authorize, asset, logger)]
      : []),
  ];

  const router = new BunRouter();
  for (const verb of ["get", "head"] as const) {
    const register = router[verb].bind(router) as unknown as (
      path: string,
      ...callbacks: RouterHandler[]
    ) => unknown;
    // `:file` is one segment; anything deeper under the assets path is a 404,
    // never the shell. (A named `*file` would lose its name when the router is
    // mounted — bun-common flattens it to a positional wildcard.)
    register(`${ASSETS_SUBPATH}/:file`, ...guards(true), serveAsset);
    register(ASSETS_SUBPATH, ...guards(true), notFound);
    register(`${ASSETS_SUBPATH}/*`, ...guards(true), notFound);
    register(DOCUMENT_SUBPATH, ...guards(false), serveDocument);
    register("/", ...guards(false), serveShell);
    register("/*", ...guards(false), serveShell);
  }

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
