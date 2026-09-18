/**
 * `jobsUi()`: a {@link BunRouter} serving the management app — the HTML shell
 * for every client route under `basePath`, and the hashed bundle under
 * `<basePath>/assets/`.
 *
 * Like `createJobsApi`, its routes are registered **relative to the mount**
 * (`/`, `/*`, `/assets/:file`), so it is mounted with
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
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import type { UiConfig, UiSections, UiTheme } from "../shared/config";
import type { UiAsset, UiAssets } from "./assets";
import type { ShellRenderer } from "./shell";
import type {
  JobsUi,
  JobsUiAuthorize,
  JobsUiAuthorizeContext,
  JobsUiOptions,
} from "./types";
import { BunRouter, resolveLogger } from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-jobs";
import { DEFAULT_DIST_DIR, DEFAULT_ENTRY, resolveAssetSource } from "./assets";
import { createNonce, createShellRenderer, cspHeader } from "./shell";

/** The UI's default mount path. */
export const DEFAULT_BASE_PATH = "/jobs";

/** The default page title. */
export const DEFAULT_TITLE = "Jobs";

/** The path under `basePath` the bundle is served from. */
export const ASSETS_SUBPATH = "/assets";

/** `Cache-Control` for hashed bundle files: their name changes with their content. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** A path segment `basePath` may contain — the API's own rule. */
const PATH_SEGMENT = /^[\w.~-]+$/;

/** A header name (an RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^`|~\w-]+$/;

/** Where the bundle comes from; tests point these at a fixture. */
export interface JobsUiInternals {
  /** The dist directory read when present. Defaults to the package's `dist/`. */
  distDir?: string;
  /** The entry built in memory without a dist. Defaults to `app/main.tsx`. */
  entry?: string;
}

/**
 * Validates and normalises an absolute mount path, as the API validates its
 * `basePath`: absolute, trailing slashes dropped, not `"/"`, and only
 * segments of letters, digits, `_`, `.`, `~` and `-`.
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
      `${what} may not be "/": the UI's catch-all would answer for every GET route of the host`,
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

/** Whether `path` is `base` or lies under it, segment-wise. */
function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** Where the API is, as the browser will reach it. */
interface ResolvedApiTarget {
  /** `UiConfig.apiBase`. */
  apiBase: string;
  /** The API's same-origin path, when known: requests under it are left to the API. */
  apiPath: string | undefined;
  /** Extra `connect-src` sources: the API's origin when it is elsewhere. */
  connectSrc: string[];
}

/** Resolves `apiUrl`: a same-origin absolute path or an `http(s)` URL. */
function resolveApiUrl(apiUrl: unknown): ResolvedApiTarget {
  if (typeof apiUrl !== "string" || apiUrl === "") {
    throw new ConfigError("apiUrl must be an absolute path or an http(s) URL", {
      apiUrl,
    });
  }
  if (apiUrl.startsWith("/") && !apiUrl.startsWith("//")) {
    const path = normalizeBasePath(apiUrl, "apiUrl");
    return { apiBase: path, apiPath: path, connectSrc: [] };
  }
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new ConfigError("apiUrl must be an absolute path or an http(s) URL", {
      apiUrl,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("apiUrl must use http: or https:", { apiUrl });
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new ConfigError(
      "apiUrl may not carry a query, a fragment or credentials",
      { apiUrl },
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return {
    apiBase: `${url.origin}${path}`,
    apiPath: undefined,
    connectSrc: [url.origin],
  };
}

/**
 * The read-only summary a newer API exposes as `api.info` (bun-jobs'
 * `JobsApiInfo`). Typed structurally and feature-detected, so the UI works
 * with an API that predates it and prefers it once it is there.
 */
export interface JobsApiInfoLike {
  /** The API's CSRF settings; `header` is lower-cased, `null` for none. */
  csrf?: { header?: string | null };
  /** Full paths of the spec documents actually routed, or `null` when docs are off. */
  docs?: { openapi: string; asyncapi?: string } | null;
  /** The socket's full path and, for a dedicated socket, its bound port; `null` without one. */
  websocket?: { path: string; port?: number } | null;
}

/** `api.info`, when this API version has it. */
function infoOf(api: JobsApi): JobsApiInfoLike | undefined {
  const info = (api as { info?: unknown }).info;
  return typeof info === "object" && info !== null
    ? (info as JobsApiInfoLike)
    : undefined;
}

/** The CSRF header the API reports (`api.info.csrf.header`), when it reports one. */
function csrfHeaderFromApi(api: JobsApi): string | undefined {
  const header = infoOf(api)?.csrf?.header;
  return typeof header === "string" && header !== "" ? header : undefined;
}

/** The docs paths: `api.info.docs` when present, else from the API's routes. */
function docsFromApi(api: JobsApi): UiConfig["docs"] {
  const info = infoOf(api);
  if (info !== undefined && info.docs !== undefined) {
    return info.docs === null
      ? null
      : { openapi: info.docs.openapi, asyncapi: info.docs.asyncapi ?? null };
  }
  const pathOf = (operationId: string): string | undefined =>
    api.routes.find((route) => route.operationId === operationId)?.path;
  const openapi = pathOf("getOpenApiDocument");
  if (openapi === undefined) {
    return null;
  }
  return { openapi, asyncapi: pathOf("getAsyncApiDocument") ?? null };
}

/** The socket: `api.info.websocket` when present, else `api.websocket`. */
function websocketFromApi(api: JobsApi): UiConfig["websocket"] {
  const info = infoOf(api);
  if (info !== undefined && info.websocket !== undefined) {
    return info.websocket === null
      ? null
      : { path: info.websocket.path, port: info.websocket.port ?? null };
  }
  const socket = api.websocket;
  return socket ? { path: socket.path, port: socket.port ?? null } : null;
}

/** Validates `sections`, defaulting each to `true`. */
function resolveSections(value: JobsUiOptions["sections"]): UiSections {
  if (value !== undefined && (typeof value !== "object" || value === null)) {
    throw new ConfigError("sections must be an object", { value });
  }
  const sections: UiSections = { manage: true, docs: true };
  for (const key of ["manage", "docs"] as const) {
    const flag = value?.[key];
    if (flag !== undefined && typeof flag !== "boolean") {
      throw new ConfigError(`sections.${key} must be a boolean`, {
        value: flag,
      });
    }
    sections[key] = flag ?? true;
  }
  if (!sections.manage && !sections.docs) {
    throw new ConfigError(
      "sections: at least one of manage and docs must be enabled",
      { sections },
    );
  }
  return sections;
}

/** Validates `theme`. */
function resolveTheme(value: unknown): UiTheme {
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

/** Validates `csrfHeader`, falling back to what the API reports. */
function resolveCsrfHeader(
  value: unknown,
  api: JobsApi | undefined,
): string | null {
  if (value === undefined) {
    return (api && csrfHeaderFromApi(api)) ?? null;
  }
  if (value === false) {
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
function freezeConfig(config: UiConfig): Readonly<UiConfig> {
  for (const value of Object.values(config)) {
    if (typeof value === "object" && value !== null) {
      Object.freeze(value);
    }
  }
  return Object.freeze(config);
}

/** Sends an RFC 9457 problem, shaped as the API's (contract §2.1). */
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
      type: `urn:bun-jobs:error:${code}`,
      title,
      status,
      code,
      detail,
      instance: req.path,
    }),
  );
}

/** Normalises an `authorize` answer; anything unrecognised denies with 403. */
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

/** The `authorize` step of every UI route. */
function authorizeStep(
  authorize: JobsUiAuthorize,
  asset: boolean,
  logger: Logger,
): RouterHandler {
  return async (req, res, next) => {
    const context: JobsUiAuthorizeContext = { asset, path: req.path };
    let decision: ReturnType<typeof decide>;
    try {
      decision = decide(await authorize(req, context));
    } catch (error) {
      logger.error("jobs ui authorize threw; refusing the request", {
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
 * Creates the UI with an explicit bundle source. {@link jobsUi} is this with
 * the package's own `dist/` and `app/main.tsx`; tests point it at a fixture.
 */
export function createJobsUi(
  options: JobsUiOptions,
  internals: JobsUiInternals = {},
): JobsUi {
  if (typeof options !== "object" || options === null) {
    throw new ConfigError("jobsUi() needs an options object", {});
  }
  const hasApi = options.api !== undefined;
  const hasUrl = options.apiUrl !== undefined;
  if (hasApi === hasUrl) {
    throw new ConfigError(
      hasApi
        ? "jobsUi() takes api or apiUrl, not both"
        : "jobsUi() needs api (a createJobsApi result) or apiUrl",
      {},
    );
  }
  const api = options.api;
  if (
    api !== undefined &&
    (typeof api !== "object" ||
      api === null ||
      typeof api.basePath !== "string" ||
      !Array.isArray(api.routes))
  ) {
    throw new ConfigError("api must be the result of createJobsApi()", {});
  }

  const basePath = normalizeBasePath(
    options.basePath ?? DEFAULT_BASE_PATH,
    "basePath",
  );
  const target: ResolvedApiTarget = api
    ? { apiBase: api.basePath, apiPath: api.basePath, connectSrc: [] }
    : resolveApiUrl(options.apiUrl);
  if (target.apiPath !== undefined && isWithin(basePath, target.apiPath)) {
    throw new ConfigError(
      `basePath ${basePath} may not equal or sit under the API's basePath ${target.apiPath}: the API answers every request under its basePath with a JSON 404`,
      { basePath, apiBasePath: target.apiPath },
    );
  }
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

  const config = freezeConfig({
    version: 1,
    title,
    basePath,
    assetsPath: `${basePath}${ASSETS_SUBPATH}`,
    apiBase: target.apiBase,
    csrfHeader: resolveCsrfHeader(options.csrfHeader, api),
    websocket: api ? websocketFromApi(api) : null,
    docs: api ? docsFromApi(api) : null,
    sections: resolveSections(options.sections),
    theme: resolveTheme(options.theme),
  });

  const logger = resolveLogger(options.logger).child({ component: "jobs-ui" });
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
      logger.error("jobs ui could not load its bundle", { error });
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

  const connectSrc = target.connectSrc;
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

  // A request under the API's own path is the API's, even when the API is
  // mounted under this UI's basePath and after it.
  const apiPath = target.apiPath;
  const leaveApiAlone: RouterHandler = (req, _res, next) =>
    apiPath !== undefined && isWithin(req.path, apiPath)
      ? next("route")
      : next();

  const guards = (asset: boolean): RouterHandler[] => [
    leaveApiAlone,
    ...middleware,
    ...(options.authorize
      ? [authorizeStep(options.authorize, asset, logger)]
      : []),
  ];

  const router = new BunRouter();
  for (const verb of ["get", "head"] as const) {
    const register = router[verb] as unknown as (
      path: string,
      ...callbacks: RouterHandler[]
    ) => unknown;
    // `:file` is one segment; anything deeper under the assets path is a 404,
    // never the shell. (A named `*file` would lose its name when the router is
    // mounted — bun-common flattens it to a positional wildcard.)
    register.call(
      router,
      `${ASSETS_SUBPATH}/:file`,
      ...guards(true),
      serveAsset,
    );
    register.call(router, ASSETS_SUBPATH, ...guards(true), notFound);
    register.call(router, `${ASSETS_SUBPATH}/*`, ...guards(true), notFound);
    register.call(router, "/", ...guards(false), serveShell);
    register.call(router, "/*", ...guards(false), serveShell);
  }

  return Object.freeze({ router, basePath, config });
}

/**
 * Creates the management UI: validates the options (throwing `ConfigError`
 * for anything unusable), resolves the configuration the app is given, and
 * builds the router.
 *
 * ```ts
 * const api = createJobsApi({ jobs, basePath: "/admin/jobs-api", authorize });
 * const ui = jobsUi({ api, basePath: "/admin/jobs" });
 * app.use(api.basePath, api.router);
 * app.use(ui.basePath, ui.router);
 * ```
 */
export function jobsUi(options: JobsUiOptions): JobsUi {
  return createJobsUi(options);
}
