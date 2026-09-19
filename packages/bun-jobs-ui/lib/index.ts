export {
  ASSET_CACHE_CONTROL,
  DEFAULT_BASE_PATH,
  DEFAULT_TITLE,
  jobsUi,
} from "./jobsUi";
/**
 * `@kingsleyweb/bun-jobs-ui`: a management UI and API documentation viewer
 * for the `@kingsleyweb/bun-jobs` management API.
 *
 * ```ts
 * const api = createJobsApi({ jobs, basePath: "/jobs-api", authorize });
 * const ui = jobsUi({ api, basePath: "/jobs" });
 * app.use(api.basePath, api.router);
 * app.use(ui.basePath, ui.router);
 * ```
 *
 * The bundle machinery (`lib/assets.ts`: building, writing and loading
 * `dist/`) is internal: `scripts/build.ts` and the tests import it directly.
 * `JobsUiBaseOptions` stays public because both option interfaces extend it,
 * so it is part of the options' declared shape.
 */
export type { UiConfig, UiSections, UiTheme } from "./shared/config";
export { UI_CONFIG_ELEMENT_ID } from "./shared/config";
export type {
  JobsUi,
  JobsUiApiOptions,
  JobsUiAuthorize,
  JobsUiAuthorizeContext,
  JobsUiAuthorizeResult,
  JobsUiBaseOptions,
  JobsUiOptions,
  JobsUiUrlOptions,
} from "./types";
