import type {
  BunRequest,
  BunRouter,
  LoggerLike,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type { JobsApi, JobsApiAuthorizeResult } from "@kingsleyweb/bun-jobs";
import type { UiConfig, UiSections, UiTheme } from "./shared/config";

/** What {@link JobsUiOptions.authorize} is told about the request being decided. */
export interface JobsUiAuthorizeContext {
  /** `true` for a bundle file under `<basePath>/assets/`, `false` for the HTML shell. */
  asset: boolean;
  /** The request's full path, e.g. `"/jobs/queues/mail"` (no query string). */
  path: string;
}

/**
 * What `authorize` answers — the same shape as the API's: `true`/`false`, or
 * `{ allow: true }` / `{ allow: false, status?: 401 | 403, reason? }`.
 * A denial is a 401 only when `status` is exactly `401`; any other `status`
 * (a `429`, a `500`, a string) is a 403, as the API does — fail closed. Rate
 * limiting belongs in `middleware`, which can answer 429 itself. Anything
 * that is not one of these shapes denies with 403.
 */
export type JobsUiAuthorizeResult = JobsApiAuthorizeResult;

/**
 * Decides whether a request may load the UI. May be async; a throw (or a
 * rejection) is a 500. A denial is 401 for `status: 401` and 403 for every
 * other status — see {@link JobsUiAuthorizeResult}.
 */
export type JobsUiAuthorize = (
  req: BunRequest,
  context: JobsUiAuthorizeContext,
) => JobsUiAuthorizeResult | Promise<JobsUiAuthorizeResult>;

/** Options shared by both ways of pointing the UI at its API. */
export interface JobsUiBaseOptions {
  /**
   * Header every mutation must carry, as the API's `csrf.header`, or `false`
   * for none (`config.csrfHeader` is then `null`). Unset: what `api` reports
   * once the API exposes it (`api.info.csrf.header`, feature-detected), else
   * none (`config.csrfHeader: null`). Until the API reports it, set it by hand
   * to match the API's `csrf.header`.
   */
  csrfHeader?: string | false;
  /**
   * Absolute path the UI is mounted at: no trailing slash, not `"/"`, segments
   * of letters, digits, `_`, `.`, `~` and `-`. Must not equal or sit under
   * the API's `basePath`. Defaults to `"/jobs"`.
   */
  basePath?: string;
  /** Page title and brand text. Defaults to `"Jobs"`. */
  title?: string;
  /**
   * Sections to enable. Each defaults to `true`; switching both off is a
   * `ConfigError`.
   */
  sections?: Partial<UiSections>;
  /**
   * Guards the shell and the bundle — **not** the data, which the API's own
   * `authorize` protects. Same result shape as the API's, and fails closed
   * the same way: a denial is 401 only for `status: 401` and 403 for any
   * other status (`429` included), an unrecognised answer is 403 and a throw
   * is 500. Omitted: everyone may load the page.
   */
  authorize?: JobsUiAuthorize;
  /**
   * Middleware run before every UI route, on the `GET`/`HEAD` requests the UI
   * answers (session loading, a rate limiter). Runs before `authorize`.
   * Defaults to none.
   */
  middleware?: readonly RouterHandler[];
  /** Initial colour scheme. Defaults to `"system"` (follows `prefers-color-scheme`). */
  theme?: UiTheme;
  /**
   * Where the bundle comes from. Unset (default): the prebuilt `dist/` when
   * present, else an in-memory `Bun.build` on the first request. `true`:
   * always build in memory. `false`: `dist/` is required — `jobsUi()` throws
   * a `ConfigError` without it.
   */
  dev?: boolean;
  /** Logger, or anything `resolveLogger` accepts. Defaults to a console logger. */
  logger?: LoggerLike;
}

/** `jobsUi()` beside a `createJobsApi` in the same process. */
export interface JobsUiApiOptions extends JobsUiBaseOptions {
  /**
   * The API this UI manages. Its `basePath`, WebSocket path/port and docs
   * paths are read from it.
   */
  api: JobsApi;
  /** Not with `api`. */
  apiUrl?: never;
}

/** `jobsUi()` for an API in another process or on another origin. */
export interface JobsUiUrlOptions extends JobsUiBaseOptions {
  /**
   * Base URL of the API, no trailing slash needed: a same-origin absolute
   * path (`"/jobs-api"`) or an `http(s)://` URL. Either way the path follows
   * `basePath`'s segment rules (checked on the string as written, so `..`, a
   * space or `%2F` is refused rather than normalised away) and may not carry
   * a query or a fragment; a URL may not carry credentials, and its path may
   * be empty (the API at the origin root). The WebSocket and docs paths are
   * then discovered by the app from `/meta` at runtime (`config.websocket`
   * and `config.docs` are `null`). A URL's origin is added to the CSP's
   * `connect-src` in `http(s)` and `ws(s)` form. A cross-origin API needs
   * CORS, CSRF and WebSocket origins configured on its side.
   */
  apiUrl: string;
  /** Not with `apiUrl`. */
  api?: never;
}

/** Options for `jobsUi()`: exactly one of `api` and `apiUrl`. */
export type JobsUiOptions = JobsUiApiOptions | JobsUiUrlOptions;

/** A mountable UI. */
export interface JobsUi {
  /**
   * Serves the shell and the bundle. Mount with `use(ui.basePath, ui.router)`,
   * on a bun-common or a bun-nest adapter.
   */
  readonly router: BunRouter;
  /** The normalised `basePath`, no trailing slash. */
  readonly basePath: string;
  /** The configuration injected into every page, frozen. */
  readonly config: Readonly<UiConfig>;
}
