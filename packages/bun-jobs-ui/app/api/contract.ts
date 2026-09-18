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
  JOB_STATES,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_PROTOCOL_VERSION,
  JOBS_API_WS_SUBPROTOCOL,
} from "@kingsleyweb/bun-jobs/api/contract";
export type {
  JobsApiAction,
  JobsApiMode,
  JobState,
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
