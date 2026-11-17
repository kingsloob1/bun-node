/**
 * `securityUi()` (ui.md §1, PR-U1): a {@link BunRouter} serving bun-security's
 * management UI on bun-ui's kit — the HTML shell (a nonce CSP, SRI, the
 * injected {@link SecurityUiConfig}) for every client route under
 * `basePath`, and the hashed bundle under `<basePath>/assets/`. Mounted
 * beside `createSecurityApi()`'s router, never under it.
 *
 * ```ts
 * const api = createSecurityApi({ ... });
 * const ui = securityUi({ api, basePath: "/security" });
 * admin.use(api.basePath, api.router);
 * admin.use(ui.basePath, ui.router);
 * ```
 */
import type { RouterHandler } from "@kingsleyweb/bun-common";
import type { ConfigFail } from "../kit/options";
import type { ResolvedApiTarget } from "../kit/apiTarget";
import type { SecurityUiConfig } from "./browser/config";
import type { SecurityUi, SecurityUiOptions } from "./types";
import { ConfigError, resolveLogger } from "@kingsleyweb/bun-common";
import { DEFAULT_SECURITY_CSRF_HEADER } from "@kingsleyweb/bun-security/control/contract";
import { isWithinPath, resolveApiTarget } from "../kit/apiTarget";
import {
  freezeConfig,
  normalizeMountPath,
  requireOptionsObject,
  resolveCommonOptions,
  resolveLayout,
} from "../kit/options";
import { connectSources } from "../kit/connect";
import { ASSETS_SUBPATH, createUiRouter, problemSender } from "../kit/serve";
import { resolveThemeInput, themedAssets } from "../kit/theme";
import { resolveUnauthorized } from "../kit/unauthorized";
import { DEFAULT_DIST_DIR, DEFAULT_ENTRY, resolveAssetSource } from "./assets";
import { createShellRenderer } from "./shell";

/** The UI's default mount path. */
export const DEFAULT_BASE_PATH = "/security";

/** The default page title. */
export const DEFAULT_TITLE = "Security";

/** Every option error is bun-common's `ConfigError`, as bun-security throws. */
const fail: ConfigFail = (message, context) =>
  new ConfigError(message, context);

/** Its problems' `type` is the API's: `urn:bun-security:problem:<code>`. */
const sendProblem = problemSender("urn:bun-security:problem:");

/** Where the bundle comes from; tests point these at a fixture. */
export interface SecurityUiInternals {
  /** The dist directory read when present. */
  distDir?: string;
  /** The entry built in memory without a dist. */
  entry?: string;
}

/** Creates the UI with an explicit bundle source; {@link securityUi} is this with the package's own. */
export function createSecurityUi(
  options: SecurityUiOptions,
  internals: SecurityUiInternals = {},
): SecurityUi {
  requireOptionsObject(options, "securityUi()", fail);
  const hasApi = options.api !== undefined;
  const hasUrl = options.apiUrl !== undefined;
  if (hasApi === hasUrl) {
    throw fail(
      hasApi
        ? "securityUi() takes api or apiUrl, not both"
        : "securityUi() needs api (a createSecurityApi result) or apiUrl",
      {},
    );
  }
  const api = options.api;
  if (
    api !== undefined &&
    (typeof api !== "object" ||
      api === null ||
      typeof api.basePath !== "string")
  ) {
    throw fail("api must be the result of createSecurityApi()", {});
  }
  if (
    options.breakGlass !== undefined &&
    typeof options.breakGlass !== "boolean"
  ) {
    throw fail("breakGlass must be a boolean", {
      breakGlass: options.breakGlass,
    });
  }
  const basePath = normalizeMountPath(
    options.basePath ?? DEFAULT_BASE_PATH,
    "basePath",
    "UI",
    fail,
  );
  const target: ResolvedApiTarget = api
    ? { apiBase: api.basePath, apiPath: api.basePath, apiOrigin: undefined }
    : resolveApiTarget(options.apiUrl, fail);
  if (target.apiPath !== undefined && isWithinPath(basePath, target.apiPath)) {
    throw fail(
      `basePath ${basePath} may not equal or sit under the API's basePath ${target.apiPath}`,
      { basePath, apiBasePath: target.apiPath },
    );
  }
  const { title, middleware } = resolveCommonOptions(
    options,
    DEFAULT_TITLE,
    fail,
  );
  const csrfHeader = options.csrfHeader ?? DEFAULT_SECURITY_CSRF_HEADER;
  if (
    typeof csrfHeader !== "string" ||
    !/^[a-z0-9-]{1,100}$/i.test(csrfHeader)
  ) {
    throw fail("csrfHeader must be a header name", { csrfHeader });
  }
  const theme = resolveThemeInput(options.theme, fail);
  const config = freezeConfig<SecurityUiConfig>({
    version: 1,
    title,
    basePath,
    assetsPath: `${basePath}${ASSETS_SUBPATH}`,
    apiBase: target.apiBase,
    csrfHeader: csrfHeader.toLowerCase(),
    breakGlass: api ? api.breakGlass === true : options.breakGlass === true,
    docs: {
      openapi: `${target.apiBase}/openapi.json`,
      asyncapi: `${target.apiBase}/asyncapi.json`,
    },
    live: { path: `${target.apiBase}/live` },
    theme: theme.mode,
    layout: resolveLayout(options.layout, fail),
    unauthorized: resolveUnauthorized(options.unauthorized, basePath, fail),
  });

  const logger = resolveLogger(options.logger).child({
    component: "security-ui",
  });
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
  const apiPath = target.apiPath;
  const leaveApiAlone: RouterHandler = (req, _res, next) =>
    apiPath !== undefined && isWithinPath(req.path, apiPath)
      ? next("route")
      : next();
  const router = createUiRouter({
    label: "security ui",
    logger,
    problem: sendProblem,
    loadAssets,
    createRenderer: (assets) => createShellRenderer(config, assets),
    connectSrc: (req) =>
      connectSources({
        host: req.get("host") ?? req.host,
        secure: req.secure,
        apiOrigin: target.apiOrigin,
        // Live updates are server-sent events: no socket to allow.
        sockets: false,
      }),
    before: [leaveApiAlone],
    middleware,
    authorize: options.authorize,
    unauthorized: config.unauthorized,
  });
  return Object.freeze({ router, basePath, config });
}

/**
 * The security management UI: validates the options (a `ConfigError` for
 * anything unusable), resolves the app's configuration, builds the router.
 */
export function securityUi(options: SecurityUiOptions): SecurityUi {
  return createSecurityUi(options);
}
