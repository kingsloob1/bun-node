import type {
  BunRequest,
  BunRouter,
  LoggerLike,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type { DocsUiConfig, DocsUiTheme } from "./shared/config";

/** What {@link DocsUiOptions.authorize} is told about the request being decided. */
export interface DocsUiAuthorizeContext {
  /** `true` for a bundle file under `<basePath>/assets/`, `false` for the HTML shell or the document a thunk serves. */
  asset: boolean;
  /** The request's full path, e.g. `"/docs/http/listQueues"` (no query string). */
  path: string;
}

/**
 * What `authorize` answers — the same shape as bun-jobs' API and UI take:
 * `true`/`false`, or `{ allow: true }` / `{ allow: false, status?: 401 | 403,
 * reason? }`. A denial is a 401 only when `status` is exactly `401`; any other
 * `status` (a `429`, a `500`, a string) is a 403 — fail closed. Rate limiting
 * belongs in `middleware`, which can answer 429 itself. Anything that is not
 * one of these shapes denies with 403.
 */
export type DocsUiAuthorizeResult =
  boolean | { allow: boolean; status?: 401 | 403; reason?: string };

/**
 * Decides whether a request may load the viewer. May be async; a throw (or a
 * rejection) is a 500. A denial is 401 for `status: 401` and 403 for every
 * other status — see {@link DocsUiAuthorizeResult}.
 */
export type DocsUiAuthorize = (
  req: BunRequest,
  context: DocsUiAuthorizeContext,
) => DocsUiAuthorizeResult | Promise<DocsUiAuthorizeResult>;

/**
 * The one document the viewer shows, produced on demand. A thunk is served by
 * the router at `<basePath>/document.json`, so the viewer always fetches
 * same-origin and the strict CSP needs no exception for it.
 */
export type DocsUiDocumentThunk = () =>
  Record<string, unknown> | Promise<Record<string, unknown>>;

/** Options for {@link docsUi}. */
export interface DocsUiOptions {
  /**
   * The document to show: where the viewer fetches it — a same-origin
   * absolute path (`"/jobs-api/openapi.json"`) or an `http(s)://` URL — or a
   * thunk producing it, which the router serves at `<basePath>/document.json`.
   *
   * A URL follows the path rules of `basePath` (checked on the string as
   * written, so `..`, a space or `%2F` is refused rather than normalised
   * away) and may not carry credentials; a URL's origin is added to the CSP's
   * `connect-src`. Whether it is an OpenAPI 3.1 or an AsyncAPI 3.0 document is
   * read from the document itself (`openapi` / `asyncapi`).
   */
  document: string | DocsUiDocumentThunk;
  /**
   * Absolute path the viewer is mounted at: no trailing slash, not `"/"`,
   * segments of letters, digits, `_`, `.`, `~` and `-`. Defaults to `"/docs"`.
   */
  basePath?: string;
  /** Page title. Defaults to `"API docs"`. */
  title?: string;
  /**
   * The specification extensions the viewers read, as their prefixes, first
   * hit winning: a `<prefix>-<name>` extension on an operation, channel or
   * scheme is read from the first prefix carrying it, and one under any other
   * prefix is ignored. Defaults to `["x-bun-common", "x-bun-jobs"]`.
   */
  extensions?: readonly string[];
  /**
   * Header the try-it panel sends on every mutation (any non-empty value), as
   * the documented API's CSRF rule, or `false` for none. Unset: none.
   */
  csrfHeader?: string | false;
  /**
   * Guards the shell, the bundle and a thunk's document. Same result shape as
   * the bun-jobs API's, and fails closed the same way: a denial is 401 only
   * for `status: 401` and 403 for any other status (`429` included), an
   * unrecognised answer is 403 and a throw is 500. Omitted: everyone may load
   * the page.
   */
  authorize?: DocsUiAuthorize;
  /**
   * Middleware run before every route, on the `GET`/`HEAD` requests the
   * viewer answers (session loading, a rate limiter). Runs before
   * `authorize`. Defaults to none.
   */
  middleware?: readonly RouterHandler[];
  /** Initial colour scheme. Defaults to `"system"` (follows `prefers-color-scheme`). */
  theme?: DocsUiTheme;
  /**
   * Where the bundle comes from. Unset (default): the prebuilt `dist/` when
   * present, else an in-memory `Bun.build` on the first request. `true`:
   * always build in memory. `false`: `dist/` is required — `docsUi()` throws
   * a `ConfigError` without it.
   */
  dev?: boolean;
  /** Logger, or anything `resolveLogger` accepts. Defaults to a console logger. */
  logger?: LoggerLike;
}

/** A mountable API-docs viewer. */
export interface DocsUi {
  /**
   * Serves the shell, the bundle and a thunk's document. Mount with
   * `use(ui.basePath, ui.router)`, on a bun-common or a bun-nest adapter.
   */
  readonly router: BunRouter;
  /** The normalised `basePath`, no trailing slash. */
  readonly basePath: string;
  /** The configuration injected into every page, frozen. */
  readonly config: Readonly<DocsUiConfig>;
}
