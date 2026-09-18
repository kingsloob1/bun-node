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
 */
export type { UiConfig, UiSections, UiTheme } from "../shared/config";
export { UI_CONFIG_ELEMENT_ID } from "../shared/config";
export {
  buildAssets,
  type BuildAssetsOptions,
  loadDistAssets,
  type UiAsset,
  type UiAssets,
  type UiManifest,
  type UiManifestFile,
  writeAssets,
} from "./assets";
export {
  ASSET_CACHE_CONTROL,
  DEFAULT_BASE_PATH,
  DEFAULT_TITLE,
  jobsUi,
} from "./jobsUi";
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
