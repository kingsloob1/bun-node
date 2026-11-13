/**
 * The `"self-hosted"` docs viewer (AD (f) F2): the pages and assets of
 * `@kingsleyweb/bun-ui`'s docs viewer (`/docs`), served from this origin — nothing from a
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
export const SELF_HOSTED_PACKAGE = "@kingsleyweb/bun-ui";

/** The subpath of the peer this module loads: the docs viewer's server half for a host. */
const HOSTED_SUBPATH = `${SELF_HOSTED_PACKAGE}/docs/hosted`;

/**
 * A colour of the self-hosted viewer, by name: bun-ui's `UiColorToken`,
 * mirrored here because bun-ui is an optional peer (bun-ui's type tests fail
 * when the two differ).
 */
export type SelfHostedColorToken =
  | "bg"
  | "surface"
  | "surface2"
  | "border"
  | "borderStrong"
  | "text"
  | "textMuted"
  | "accent"
  | "accentContrast"
  | "focus"
  | "danger"
  | "dangerContrast"
  | "warningBg"
  | "warningText"
  | "infoBg"
  | "infoText"
  | "successBg"
  | "successText"
  | "dangerBg"
  | "dangerText"
  | "neutralBg"
  | "neutralText"
  | "stateWaiting"
  | "stateDelayed"
  | "stateActive"
  | "stateCompleted"
  | "stateFailed"
  | "stateDead"
  | "stateWaitingChildren";

/**
 * A custom colour theme for the self-hosted viewer: bun-ui's
 * `UiThemeOptions`, mirrored. Each scheme's colours are `#rgb` or
 * `#rrggbb`; bun-ui checks them (it needs 3.2.0 or later).
 */
export interface SelfHostedTheme {
  /** The scheme the page starts in. Default: `"system"`. */
  mode?: "system" | "light" | "dark";
  /** Colours for the light scheme. Default: the built-in ones. */
  light?: Partial<Record<SelfHostedColorToken, string>>;
  /** Colours for the dark scheme. Default: the built-in ones. */
  dark?: Partial<Record<SelfHostedColorToken, string>>;
}

/** A viewer page's own options (the `{ name, ...options }` pass-through). */
export interface SelfHostedViewerOptions {
  /**
   * The colour theme: a scheme, `"system"` (default), `"light"` or
   * `"dark"`, or a {@link SelfHostedTheme} that also sets colours (served
   * as `<mount>/assets/theme-<hash>.css`; a pair below WCAG AA contrast is
   * a warning on the docs router's logger, at the first page request).
   */
  theme?: "system" | "light" | "dark" | SelfHostedTheme;
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
  /** The page's bundle: the shared one, with its theme's stylesheet when it has one. */
  load: () => Promise<HostedAssets>;
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

/** A checked theme (the peer's `ResolvedUiTheme`, mirrored). */
interface HostedTheme {
  /** The scheme the page starts in. */
  readonly mode: "system" | "light" | "dark";
  /** The colour overrides, when it sets any. */
  readonly colors: object | undefined;
}

/** The slice of the peer's `lib/hosted` this module uses. */
interface HostedModule {
  /** Checks a theme (bun-ui 3.2.0 and later; absent before). */
  resolveThemeInput?: (
    value: unknown,
    fail: (message: string, context: Record<string, unknown>) => Error,
    what?: string,
  ) => HostedTheme;
  /** A loader that adds a theme's stylesheet to the bundle (with `resolveThemeInput`). */
  themedAssets?: (
    theme: HostedTheme,
    loadAssets: () => Promise<HostedAssets>,
    warn: (message: string) => void,
  ) => () => Promise<HostedAssets>;
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

/**
 * The `theme` pass-through, checked: a scheme here; a theme object by the
 * peer, which owns the token names (bun-ui 3.2.0 or later).
 */
function resolveViewerTheme(
  mod: HostedModule,
  value: unknown,
  what: string,
): HostedTheme {
  const theme = value ?? "system";
  if (theme === "system" || theme === "light" || theme === "dark") {
    return { mode: theme, colors: undefined };
  }
  if (typeof theme !== "object" || theme === null) {
    throw new ConfigError(
      `${what}: theme must be "system", "light", "dark" or { mode?, light?, dark? }`,
      { theme: value },
    );
  }
  if (mod.resolveThemeInput === undefined || mod.themedAssets === undefined) {
    throw new ConfigError(
      `${what}: a theme object needs ${SELF_HOSTED_PACKAGE} 3.2.0 or later`,
      { package: SELF_HOSTED_PACKAGE },
    );
  }
  return mod.resolveThemeInput(
    theme,
    (message, context) => new ConfigError(`${what}: ${message}`, context),
  );
}

/** The pass-through options, checked (a bad one is a ConfigError at construction). */
function resolveOptions(
  options: SelfHostedViewerOptions,
  what: string,
  theme: HostedTheme,
): Pick<HostedConfig, "csrfHeader" | "extensions" | "theme"> {
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
  return { theme: theme.mode, extensions, csrfHeader };
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
  const loadAssets = mod.resolveHostedAssets(noopLogger);
  /** The bundle, shared by every route; a failure answers 500, logged nowhere (the peer logs the build notice). */
  let bundle: Promise<HostedAssets> | undefined;
  const ready = (): Promise<HostedAssets> => (bundle ??= loadAssets());

  // A theme's contrast warnings, logged on the router's logger at the first
  // page request: by then a host has had the chance to `setLogger` it.
  const warnings: string[] = [];
  const flushWarnings = () => {
    for (const message of warnings.splice(0)) router.logger.warn(message);
  };

  // The pass-through options are validated here, at construction, with the
  // peer's load: a bad one never waits for a request. A theme with colours
  // gives its page a bundle of its own: the shared one plus its stylesheet.
  const resolve = (
    document: SelfHostedDocument | undefined,
    what: string,
  ): ResolvedDocument | undefined => {
    if (document === undefined) return undefined;
    const theme = resolveViewerTheme(mod, document.options.theme, what);
    const load =
      theme.colors === undefined || mod.themedAssets === undefined
        ? ready
        : mod.themedAssets(theme, ready, (message) => {
            warnings.push(`${what}: ${message}`);
          });
    return {
      ...document,
      resolved: resolveOptions(document.options, what, theme),
      load,
    };
  };
  const resolved = {
    openapi: resolve(registration.openapi, "the openapi viewer"),
    asyncapi: resolve(registration.asyncapi, "the asyncapi viewer"),
  };

  /** A renderer per mount path and page (the config is fixed for both). */
  const renderers = new Map<string, (nonce: string) => string>();

  /** Serves one page's shell. `basePath` is the page's client-route root. */
  const servePage =
    (
      page: ResolvedDocument,
      kind: "openapi" | "asyncapi",
    ): ((req: BunRequest, res: BunResponse) => Promise<void>) =>
    async (req, res) => {
      flushWarnings();
      let assets: HostedAssets;
      try {
        assets = await page.load();
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
    // Every page's bundle: the shared files, and each themed page's stylesheet.
    let bundles: HostedAssets[];
    try {
      bundles = await Promise.all(
        [resolved.openapi, resolved.asyncapi].flatMap((page) =>
          page === undefined ? [] : [page.load()],
        ),
      );
    } catch {
      res.status(500);
      void res.end();
      return;
    }
    const name = (req.params as Record<string, string | undefined>).file;
    const file =
      name === undefined
        ? undefined
        : bundles
            .map((assets) => assets.files.get(name))
            .find((found) => found !== undefined);
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
