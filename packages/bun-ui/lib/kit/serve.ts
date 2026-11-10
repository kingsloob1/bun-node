/**
 * Serving a UI: the router every UI's server function returns, shared by
 * `jobsUi()` and `docsUi()` (the kit). It answers the HTML shell for every
 * client route under the mount, the hashed bundle under `<mount>/assets/`
 * (immutable, ETag'd, a 304 for a match), and any route a UI adds (the docs
 * viewer's document), each behind the UI's guards (its middleware, then
 * `authorize`).
 *
 * Its routes are registered **relative to the mount** (`/`, `/*`,
 * `/assets/:file`), so a UI is mounted with `app.use(ui.basePath, ui.router)`
 * and `ui.router.fetch("/")` works on its own. Errors are RFC 9457 problems
 * whose `type` is the UI's own URN prefix, so each UI's wire format stays
 * its own.
 */
import type {
  BunRequest,
  BunResponse,
  Logger,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type { UiAsset, UiAssets } from "./assets";
import type { UiUnauthorized } from "./browser/unauthorized";
import type { ShellRenderer } from "./shell";
import { BunRouter } from "@kingsleyweb/bun-common";
import { ASSET_CACHE_CONTROL } from "./browser/shared";
import { createNonce, cspHeader } from "./shell";
import { redirectsDenial, sendUnauthorizedRedirect } from "./unauthorized";

/** The path under a UI's `basePath` its bundle is served from. */
export const ASSETS_SUBPATH = "/assets";

/** Sends an RFC 9457 problem: `(req, res, status, code, title, detail)`. */
export type ProblemSender = (
  req: BunRequest,
  res: BunResponse,
  status: number,
  code: string,
  title: string,
  detail: string,
) => void;

/**
 * A {@link ProblemSender} whose `type` is `typePrefix` and the code
 * (`"urn:bun-jobs:error:"` for the jobs UI, as its API; the docs viewer's
 * `"urn:bun-api-docs-ui:error:"`). `no-store`, `nosniff`, no body for `HEAD`.
 */
export function problemSender(typePrefix: string): ProblemSender {
  return (req, res, status, code, title, detail) => {
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
        type: `${typePrefix}${code}`,
        title,
        status,
        code,
        detail,
        instance: req.path,
      }),
    );
  };
}

/** Answers 500 with the problem every UI uses for an internal failure. */
function sendInternal(
  problem: ProblemSender,
  req: BunRequest,
  res: BunResponse,
): void {
  problem(
    req,
    res,
    500,
    "INTERNAL",
    "Internal server error",
    "Internal server error",
  );
}

/** An `authorize` answer, normalised. */
export type UiDecision =
  | { allow: true }
  | {
      allow: false;
      status: 401 | 403;
      reason?: string;
    };

/**
 * Normalises an `authorize` answer, as the bun-jobs API's own `decide` does:
 * a denial is 401 only for `status: 401`, 403 for any other status, and
 * anything unrecognised denies with 403.
 */
export function decide(result: unknown): UiDecision {
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

/** What a UI's `authorize` is told about the request (`JobsUiAuthorizeContext`, `DocsUiAuthorizeContext`). */
export interface UiAuthorizeContext {
  /** `true` for a bundle file under `<basePath>/assets/`. */
  asset: boolean;
  /** The request's full path (no query string). */
  path: string;
}

/** A UI's `authorize` option, as the kit calls it; its answer goes through {@link decide}. */
export type UiAuthorize = (
  req: BunRequest,
  context: UiAuthorizeContext,
) => unknown;

/** Inputs to {@link authorizeStep}. */
export interface AuthorizeStepOptions {
  /** The UI's `authorize` option. */
  authorize: UiAuthorize;
  /** Whether the route serves a bundle file (`context.asset`). */
  asset: boolean;
  /**
   * Whether a denial of a page navigation on this route may answer with the
   * `unauthorized` redirect: the shell's routes only, never a bundle file or
   * a document.
   */
  shell: boolean;
  /** Receives the error when `authorize` throws. */
  logger: Logger;
  /** The UI's name in log messages (`"jobs ui"`, `"api docs ui"`). */
  label: string;
  /** The resolved `unauthorized` option, or `null` when it is off. */
  unauthorized: UiUnauthorized | null;
  /** Sends the UI's problems. */
  problem: ProblemSender;
}

/**
 * The `authorize` step of a UI route. A throw (or rejection) is a 500. With
 * `unauthorized`, a denial whose status it lists answers a page navigation of
 * the shell with a 303 to the target; a bundle file, a document and anything
 * that is not a navigation keep the problem.
 */
export function authorizeStep(options: AuthorizeStepOptions): RouterHandler {
  const { authorize, asset, shell, logger, label, unauthorized, problem } =
    options;
  return async (req, res, next) => {
    const context: UiAuthorizeContext = { asset, path: req.path };
    let decision: UiDecision;
    try {
      decision = decide(await authorize(req, context));
    } catch (error) {
      logger.error(`${label} authorize threw; refusing the request`, {
        error,
        path: req.path,
      });
      sendInternal(problem, req, res);
      return;
    }
    if (decision.allow) {
      return next();
    }
    if (redirectsDenial(unauthorized, shell, decision.status, req)) {
      sendUnauthorizedRedirect(req, res, unauthorized);
      return;
    }
    if (decision.status === 401) {
      problem(
        req,
        res,
        401,
        "UNAUTHORIZED",
        "Authentication required",
        decision.reason ?? "Authentication required",
      );
    } else {
      problem(
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
 * A route a UI adds beside the shell and the bundle, e.g. the docs viewer's
 * `/document.json`. It runs behind the same guards, as neither a bundle file
 * (`context.asset` is `false`) nor the shell (a denial is never redirected).
 */
export interface UiExtraRoute {
  /** The path, relative to the mount. */
  path: string;
  /** Answers the request, once the guards let it through. */
  handler: RouterHandler;
}

/** Inputs to {@link createUiRouter}. */
export interface UiRouterOptions {
  /** The UI's name in log messages (`"jobs ui"`, `"api docs ui"`). */
  label: string;
  /** Receives a failed bundle load. */
  logger: Logger;
  /** Sends the UI's problems. */
  problem: ProblemSender;
  /** Loads the bundle (a `resolveAssetSource` result); the first request waits for it. */
  loadAssets: () => Promise<UiAssets>;
  /** Prepares the shell for the loaded bundle, once. */
  createRenderer: (assets: UiAssets) => ShellRenderer;
  /** The shell's `connect-src` sources after `'self'`, for this request. */
  connectSrc: (req: BunRequest) => readonly string[];
  /**
   * Handlers run first on every route, ahead of `middleware` (the jobs UI
   * steps aside there for a request under its API's path). Defaults to none.
   */
  before?: readonly RouterHandler[];
  /** The UI's `middleware` option, run on every route before `authorize`. */
  middleware: readonly RouterHandler[];
  /** The UI's `authorize` option; every route is open without one. */
  authorize?: UiAuthorize;
  /** The resolved `unauthorized` option, or `null` when it is off. */
  unauthorized: UiUnauthorized | null;
  /** Routes the UI adds, registered after the bundle's and before the shell's catch-all. */
  routes?: readonly UiExtraRoute[];
}

/**
 * Builds a UI's router: for `GET` and `HEAD`, `/assets/:file` (one segment;
 * `/assets` and anything deeper under it is a 404, never the shell), then the
 * UI's own routes, then `/` and `/*` (the shell). Every route runs `before`,
 * then `middleware`, then `authorize` ({@link authorizeStep}) when set. The
 * bundle is loaded on the first request that needs it; a load failure is
 * logged and answered 500.
 */
export function createUiRouter(options: UiRouterOptions): BunRouter {
  const { label, logger, problem, loadAssets, createRenderer } = options;

  // The shell is rendered from the bundle, so it waits for the first load.
  let renderer: { assets: UiAssets; render: ShellRenderer } | undefined;
  const ready = async (): Promise<{
    assets: UiAssets;
    render: ShellRenderer;
  }> => {
    if (renderer === undefined) {
      const assets = await loadAssets();
      renderer ??= { assets, render: createRenderer(assets) };
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
      logger.error(`${label} could not load its bundle`, { error });
      sendInternal(problem, req, res);
      return undefined;
    }
  };

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
    const connectSrc = options.connectSrc(req);
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
      problem(req, res, 404, "NOT_FOUND", "Not found", `No asset ${req.path}`);
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
    problem(req, res, 404, "NOT_FOUND", "Not found", `No asset ${req.path}`);
  };

  const { authorize, before = [], middleware, routes = [] } = options;
  /** The guards of one route, made per registration. */
  const guards = (asset: boolean, shell: boolean): RouterHandler[] => [
    ...before,
    ...middleware,
    ...(authorize
      ? [
          authorizeStep({
            authorize,
            asset,
            shell,
            logger,
            label,
            unauthorized: options.unauthorized,
            problem,
          }),
        ]
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
    register(`${ASSETS_SUBPATH}/:file`, ...guards(true, false), serveAsset);
    register(ASSETS_SUBPATH, ...guards(true, false), notFound);
    register(`${ASSETS_SUBPATH}/*`, ...guards(true, false), notFound);
    for (const route of routes) {
      register(route.path, ...guards(false, false), route.handler);
    }
    register("/", ...guards(false, true), serveShell);
    register("/*", ...guards(false, true), serveShell);
  }
  return router;
}
