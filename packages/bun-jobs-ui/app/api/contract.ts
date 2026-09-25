/**
 * Constants of the bun-jobs management API.
 *
 * They come from `@kingsleyweb/bun-jobs/api/contract`, the package's
 * browser-safe entry: it imports nothing but its own sibling files (no driver,
 * bun-common, `node:*` or `bun:*`), and the server imports the same values, so
 * the two cannot disagree. `__tests__/app/pkg/bundle-safety.test.ts` builds
 * the app and asserts nothing of the server reached the bundle.
 *
 * The method sets below are the app's own reading of the CSRF rules.
 */
export {
  ANALYTICS_PRESETS,
  ANALYTICS_RESOLUTIONS,
  DEFAULT_ANALYTICS_PRESET,
  DEFAULT_ANALYTICS_RESOLUTION,
  DEFAULT_REDACT_REPLACEMENT,
  DEFAULT_SECOND_RETENTION_MS,
  EXECUTION_MODES,
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
  JOB_DEFAULTS_BOUNDS,
  JOB_STATES,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
  JOBS_API_PROTOCOL_VERSION,
  JOBS_API_WS_SUBPROTOCOL,
  MAX_ADDED_BY_STATE_SPAN_MS,
  MAX_ANALYTICS_BUCKETS,
  MAX_ANALYTICS_ROWS,
  MAX_ANALYTICS_SERIES,
  MAX_ANALYTICS_SPAN_MS,
  MAX_DATE_MS,
  MIN_ANALYTICS_SPAN_MS,
  MINUTE_RETENTION_MS,
  RUN_LOG_HINT_MS,
  RUN_LOG_LEVELS,
  RUN_LOG_STREAMS,
  RUNNER_CONFIG_BOUNDS,
  RUNNER_CONFIG_KEYS,
  RUNNER_EVENT_TYPES,
  WORKER_CONFIG_BOUNDS,
  WORKER_CONFIG_KEYS,
  WORKER_STATES,
  WORKER_STOP_PERSISTENCE,
  WORKER_TARGET_KINDS,
} from "@kingsleyweb/bun-jobs/api/contract";
export type {
  AnalyticsPreset,
  AnalyticsResolution,
  JobDefaultBackoffType,
  JobDefaultKey,
  JobDefaultsApplyState,
  JobListSort,
  JobsApiAction,
  JobsApiMode,
  JobState,
  RunLogLevel,
  RunLogStream,
  RunnerConfigKey,
  WorkerConfigBody,
  WorkerConfigKey,
  WorkerDesiredState,
  WorkerState,
  WorkerStopPersistence,
  WorkerTargetKind,
} from "@kingsleyweb/bun-jobs/api/contract";

/** HTTP methods the API treats as mutations for CSRF: every one but `GET`/`HEAD`/`OPTIONS` (contract §3.2). */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Methods that must carry `Content-Type: application/json` even when bodiless (contract §3.2, `requireJson`). */
export const JSON_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
]);
