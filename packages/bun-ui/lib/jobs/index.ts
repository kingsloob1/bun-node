export {
  ASSET_CACHE_CONTROL,
  DEFAULT_BASE_PATH,
  DEFAULT_TITLE,
  jobsUi,
} from "./jobsUi";
/**
 * `@kingsleyweb/bun-ui/jobs`: a management UI and API documentation viewer
 * for the `@kingsleyweb/bun-jobs` management API. Needs
 * `@kingsleyweb/bun-jobs`, an optional peer of the package that this entry
 * (and `./lib/jobs/*`) alone requires.
 *
 * ```ts
 * const api = createJobsApi({ jobs, basePath: "/jobs-api", authorize });
 * const ui = jobsUi({ api, basePath: "/jobs" });
 * app.use(api.basePath, api.router);
 * app.use(ui.basePath, ui.router);
 * ```
 *
 * The bundle machinery (`lib/jobs/assets.ts`, the kit's `lib/kit/assets.ts`
 * bound to `dist/jobs/`) is internal: `scripts/build.ts` and the tests import
 * it directly.
 * `JobsUiBaseOptions` stays public because both option interfaces extend it,
 * so it is part of the options' declared shape.
 */
export type {
  UiUnauthorized,
  UiUnauthorizedStatus,
} from "./browser/unauthorized";
export type { JobsUiConfig, JobsUiSections, UiTheme } from "./browser/config";
export type {
  UiColorToken,
  UiThemeColors,
  UiThemeInput,
  UiThemeOptions,
} from "../kit/browser/shared";
export { JOBS_UI_CONFIG_ELEMENT_ID } from "./browser/config";
export type {
  JobsUi,
  JobsUiApiOptions,
  JobsUiUnauthorizedOptions,
  JobsUiAuthorize,
  JobsUiAuthorizeContext,
  JobsUiAuthorizeResult,
  JobsUiBaseOptions,
  JobsUiOptions,
  JobsUiUrlOptions,
} from "./types";
