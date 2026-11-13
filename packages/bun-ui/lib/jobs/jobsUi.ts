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
import type { RouterHandler } from "@kingsleyweb/bun-common";
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import type { ConfigFail } from "../kit/options";
import type { JobsUiConfig, JobsUiSections } from "./browser/config";
import type { JobsUi, JobsUiOptions } from "./types";
import { resolveLogger } from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-jobs";
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
import { connectSources, createShellRenderer } from "./shell";

/** The UI's default mount path. */
export const DEFAULT_BASE_PATH = "/jobs";

/** The default page title. */
export const DEFAULT_TITLE = "Jobs";

export { ASSET_CACHE_CONTROL, ASSETS_SUBPATH };

/** Every option error is bun-jobs' `ConfigError`, the class `jobsUi()` users already catch. */
const fail: ConfigFail = (message, context) =>
  new ConfigError(message, context);

/** Its problems' `type` is the API's: `urn:bun-jobs:error:<code>` (contract §2.1). */
const sendProblem = problemSender("urn:bun-jobs:error:");

// The option's defaults, kept here for `./lib/jobsUi` importers; the
// option itself is the kit's (`lib/kit/unauthorized`), shared with docsUi().
export {
  DEFAULT_RETURN_PARAM,
  DEFAULT_UNAUTHORIZED_STATUSES,
} from "../kit/browser/unauthorized";

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
  return normalizeMountPath(value, what, "UI", fail);
}

/** Whether `path` is `base` or lies under it, segment-wise. */
function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** Where the API is, as the browser will reach it. */
interface ResolvedApiTarget {
  /** `JobsUiConfig.apiBase`. */
  apiBase: string;
  /** The API's same-origin path, when known: requests under it are left to the API. */
  apiPath: string | undefined;
  /** The API's origin when it is a URL (`"https://api.example"`), else `undefined`. */
  apiOrigin: string | undefined;
}

/**
 * The raw parts of an `http(s)://` URL as written, before `new URL()`
 * normalises them: the authority and the path (up to any `?` or `#`).
 * `undefined` when the string does not start with an `http(s)://` authority.
 */
const RAW_HTTP_URL = /^https?:\/\/([^/?#]*)([^?#]*)/i;

/** Refuses a query or fragment in `apiUrl` with a message naming which. */
function refuseQueryOrFragment(apiUrl: string): void {
  const query = apiUrl.indexOf("?");
  const hash = apiUrl.indexOf("#");
  if (query !== -1 && (hash === -1 || query < hash)) {
    throw new ConfigError("apiUrl may not carry a query", { apiUrl });
  }
  if (hash !== -1) {
    throw new ConfigError("apiUrl may not carry a fragment", { apiUrl });
  }
}

/**
 * Resolves `apiUrl`: a same-origin absolute path or an `http(s)` URL.
 *
 * The URL form's path obeys the path form's segment rules. They are checked
 * on the **raw** string, because `new URL()` has already resolved `..`,
 * percent-encoded a space and turned `\` into `/` — `http://h/a/../b` would
 * otherwise quietly become `http://h/b`. The raw path is validated with
 * {@link normalizeBasePath}, then compared with the parsed `pathname`: any
 * difference means the parser rewrote something the rules did not see, and
 * is refused too. An empty or `"/"` path is the API at the origin root.
 */
function resolveApiUrl(apiUrl: unknown): ResolvedApiTarget {
  if (typeof apiUrl !== "string" || apiUrl === "") {
    throw new ConfigError("apiUrl must be an absolute path or an http(s) URL", {
      apiUrl,
    });
  }
  if (apiUrl.startsWith("/") && !apiUrl.startsWith("//")) {
    refuseQueryOrFragment(apiUrl);
    const path = normalizeBasePath(apiUrl, "apiUrl");
    return { apiBase: path, apiPath: path, apiOrigin: undefined };
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
  const raw = RAW_HTTP_URL.exec(apiUrl);
  if (raw === null) {
    throw new ConfigError("apiUrl must be an absolute path or an http(s) URL", {
      apiUrl,
    });
  }
  refuseQueryOrFragment(apiUrl);
  const [, authority = "", rawPath = ""] = raw;
  if (authority.includes("@") || url.username !== "" || url.password !== "") {
    throw new ConfigError("apiUrl may not carry credentials", { apiUrl });
  }
  const path = /^\/*$/.test(rawPath)
    ? ""
    : normalizeBasePath(rawPath, "apiUrl");
  if (url.pathname.replace(/\/+$/, "") !== path) {
    throw new ConfigError(
      `apiUrl may only contain "/"-separated segments of letters, digits, "_", ".", "~" and "-"`,
      { apiUrl },
    );
  }
  return {
    apiBase: `${url.origin}${path}`,
    apiPath: undefined,
    apiOrigin: url.origin,
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
  return typeof info === "object" && info !== null ? info : undefined;
}

/** The CSRF header the API reports (`api.info.csrf.header`), when it reports one. */
function csrfHeaderFromApi(api: JobsApi): string | undefined {
  const header = infoOf(api)?.csrf?.header;
  return typeof header === "string" && header !== "" ? header : undefined;
}

/** The docs paths: `api.info.docs` when present, else from the API's routes. */
function docsFromApi(api: JobsApi): JobsUiConfig["docs"] {
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
function websocketFromApi(api: JobsApi): JobsUiConfig["websocket"] {
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
function resolveSections(value: JobsUiOptions["sections"]): JobsUiSections {
  if (value !== undefined && (typeof value !== "object" || value === null)) {
    throw new ConfigError("sections must be an object", { value });
  }
  const sections: JobsUiSections = { manage: true, docs: true };
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

/**
 * Creates the UI with an explicit bundle source. {@link jobsUi} is this with
 * the package's own `dist/` and `app/main.tsx`; tests point it at a fixture.
 */
export function createJobsUi(
  options: JobsUiOptions,
  internals: JobsUiInternals = {},
): JobsUi {
  requireOptionsObject(options, "jobsUi()", fail);
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
    ? { apiBase: api.basePath, apiPath: api.basePath, apiOrigin: undefined }
    : resolveApiUrl(options.apiUrl);
  if (target.apiPath !== undefined && isWithin(basePath, target.apiPath)) {
    throw new ConfigError(
      `basePath ${basePath} may not equal or sit under the API's basePath ${target.apiPath}: the API answers every request under its basePath with a JSON 404`,
      { basePath, apiBasePath: target.apiPath },
    );
  }
  const { title, middleware } = resolveCommonOptions(
    options,
    DEFAULT_TITLE,
    fail,
  );

  // The starting scheme goes to the browser; colours become a stylesheet.
  const theme = resolveThemeInput(options.theme, fail);
  const config = freezeConfig<JobsUiConfig>({
    version: 1,
    title,
    basePath,
    assetsPath: `${basePath}${ASSETS_SUBPATH}`,
    apiBase: target.apiBase,
    csrfHeader: resolveCsrfHeader(
      options.csrfHeader,
      () => (api && csrfHeaderFromApi(api)) ?? null,
      fail,
    ),
    websocket: api ? websocketFromApi(api) : null,
    docs: api ? docsFromApi(api) : null,
    sections: resolveSections(options.sections),
    theme: theme.mode,
    unauthorized: resolveUnauthorized(options.unauthorized, basePath, fail),
  });

  const logger = resolveLogger(options.logger).child({ component: "jobs-ui" });
  const loadAssets = themedAssets(
    theme,
    resolveAssetSource({
      dev: options.dev,
      distDir: internals.distDir ?? DEFAULT_DIST_DIR,
      entry: internals.entry ?? DEFAULT_ENTRY,
      logger,
      fail,
    }),
    (message) => {
      logger.warn(message);
    },
  );

  const apiOrigin = target.apiOrigin;
  const websocketPort = config.websocket?.port ?? null;

  // A request under the API's own path is the API's, even when the API is
  // mounted under this UI's basePath and after it.
  const apiPath = target.apiPath;
  const leaveApiAlone: RouterHandler = (req, _res, next) =>
    apiPath !== undefined && isWithin(req.path, apiPath)
      ? next("route")
      : next();

  const router = createUiRouter({
    label: "jobs ui",
    logger,
    problem: sendProblem,
    loadAssets,
    createRenderer: (assets) => createShellRenderer(config, assets),
    // The Host header first: it is the origin the browser loaded the page
    // from. `connectSources` drops it unless it is a plain `host[:port]`.
    connectSrc: (req) =>
      connectSources({
        host: req.get("host") ?? req.host,
        secure: req.secure,
        apiOrigin,
        websocketPort,
      }),
    before: [leaveApiAlone],
    middleware,
    authorize: options.authorize,
    unauthorized: config.unauthorized,
  });

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
