/** `securityUi()`'s options and result. */
import type {
  BunRequest,
  BunRouter,
  LoggerLike,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import type { SecurityApi } from "@kingsleyweb/bun-security/control";
import type { UiChrome } from "../kit/browser/mount";
import type { UiLayoutOptions, UiThemeInput } from "../kit/browser/shared";
import type { UnauthorizedOptions } from "../kit/browser/unauthorized";
import type { UiAuthorizeContext } from "../kit/serve";
import type { SecurityUiConfig } from "./browser/config";

/** What `authorize` is told about the request. */
export type SecurityUiAuthorizeContext = UiAuthorizeContext;

/**
 * Guards the shell and the bundle (not the data, which the API's own
 * authentication guards): `true`, `false`, or `{ allowed, status }`, as
 * the kit decides it.
 */
export type SecurityUiAuthorize = (
  req: BunRequest,
  context: SecurityUiAuthorizeContext,
) => unknown;

/** The options every form of `securityUi()` takes. */
export interface SecurityUiBaseOptions {
  /** Absolute path the UI is mounted at; not under the API's. Default `"/security"`. */
  basePath?: string;
  /** Page title and brand text. Default `"Security"`. */
  title?: string;
  /**
   * The header every mutation carries, as the API's `csrf.header`. Default
   * the API's default, `x-bun-security-csrf`; `/meta` reports the real one
   * once signed in.
   */
  csrfHeader?: string;
  /** Guards the shell and the bundle. Omitted: everyone may load the page. */
  authorize?: SecurityUiAuthorize;
  /** Sends the browser to a sign-in page on an authorization failure (the kit's option). */
  unauthorized?: UnauthorizedOptions;
  /** Middleware before every UI route (session loading, a rate limiter). */
  middleware?: readonly RouterHandler[];
  /** The colour theme (the kit's option). Default `"system"`. */
  theme?: UiThemeInput;
  /** Where the content sits on a wide screen (the kit's option). */
  layout?: UiLayoutOptions;
  /**
   * How much of its own frame the UI draws (the kit's option, embedding.md
   * §2): `"full"` (the default) its header and side nav; `"tabs"` a compact
   * bar of its sections and working controls above the screen; `"none"` the
   * screen alone, for a page whose own menu is the nav. A host that mounts
   * the UI in its own page passes it to the mount function instead.
   */
  chrome?: UiChrome;
  /** Where the bundle comes from: unset, `dist/` when present else built in memory; `true` always build; `false` require `dist/`. */
  dev?: boolean;
  /** Logger, or anything `resolveLogger` accepts. */
  logger?: LoggerLike;
}

/** `securityUi()` over a `createSecurityApi()` in the same process. */
export interface SecurityUiApiOptions extends SecurityUiBaseOptions {
  /** The API this UI manages: its `basePath` and break-glass setting are read from it. */
  api: SecurityApi;
  /** Not with `api`. */
  apiUrl?: never;
  /** Not with `api`: read from it. */
  breakGlass?: never;
}

/** `securityUi()` over an API elsewhere. */
export interface SecurityUiUrlOptions extends SecurityUiBaseOptions {
  /** Where the API is: a same-origin absolute path or an `http(s)` URL. */
  apiUrl: string;
  /** Not with `apiUrl`. */
  api?: never;
  /** Whether that API's break-glass account is configured (the sign-in form is offered only then). Default `false`. */
  breakGlass?: boolean;
}

/** `securityUi()`'s options. */
export type SecurityUiOptions = SecurityUiApiOptions | SecurityUiUrlOptions;

/** What `securityUi()` returns. */
export interface SecurityUi {
  /** Serves the shell and the assets: mount it with `app.use(ui.basePath, ui.router)`. */
  readonly router: BunRouter;
  /** Where to mount it. */
  readonly basePath: string;
  /** The configuration the app is given. */
  readonly config: SecurityUiConfig;
}
