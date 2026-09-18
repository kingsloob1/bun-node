/**
 * Constants of the bun-jobs management API, duplicated for the browser.
 *
 * Importing any value from `@kingsleyweb/bun-jobs` pulls its whole barrel
 * (drivers, bun-common, `node:*`) into the bundle, so the app keeps its own
 * copies. `__tests__/app/contract.test.ts` imports the real values from the
 * package and asserts these equal them, so drift fails CI.
 */

/**
 * Every job state, in lifecycle order.
 * Mirrors `JOB_STATES` — packages/bun-jobs/lib/api/schemas/common.ts:11-19.
 */
export const JOB_STATES = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead",
  "waiting-children",
] as const;

/** One job state. Mirrors `JobState` — packages/bun-jobs/lib/drivers/driver.ts:250-258. */
export type JobState = (typeof JOB_STATES)[number];

/**
 * Every action `authorize` can be asked about.
 * Mirrors `JOBS_API_ACTIONS` — packages/bun-jobs/lib/api/config.ts:49-83.
 */
export const JOBS_API_ACTIONS = [
  "meta.read",
  "docs.read",
  "queues.list",
  "queues.read",
  "queues.pause",
  "queues.resume",
  "queues.drain",
  "queues.clean",
  "queues.limits",
  "metrics.read",
  "workers.list",
  "jobs.list",
  "jobs.read",
  "jobs.logs",
  "jobs.add",
  "jobs.update",
  "jobs.retry",
  "jobs.retryAll",
  "jobs.remove",
  "jobs.promote",
  "repeatables.list",
  "repeatables.remove",
  "definitions.list",
  "runners.list",
  "runners.read",
  "runners.trigger",
  "runners.pause",
  "runners.resume",
  "runners.kill",
  "runners.reschedule",
  "runners.resetStats",
  "events.connect",
  "events.subscribe",
] as const;

/** One authorizable action. Mirrors `JobsApiAction` — packages/bun-jobs/lib/api/config.ts:86. */
export type JobsApiAction = (typeof JOBS_API_ACTIONS)[number];

/**
 * Actions that change state (removed by `readOnly`, CSRF-checked).
 * Mirrors `JOBS_API_MUTATIONS` — packages/bun-jobs/lib/api/config.ts:93-113.
 */
export const JOBS_API_MUTATIONS: ReadonlySet<JobsApiAction> =
  new Set<JobsApiAction>([
    "queues.pause",
    "queues.resume",
    "queues.drain",
    "queues.clean",
    "queues.limits",
    "jobs.add",
    "jobs.update",
    "jobs.retry",
    "jobs.retryAll",
    "jobs.remove",
    "jobs.promote",
    "repeatables.remove",
    "runners.trigger",
    "runners.pause",
    "runners.resume",
    "runners.kill",
    "runners.reschedule",
    "runners.resetStats",
  ]);

/** The API protocol version `/meta` reports. Mirrors `JOBS_API_PROTOCOL_VERSION` — packages/bun-jobs/lib/api/routes/meta.ts:23. */
export const JOBS_API_PROTOCOL_VERSION = 1 as const;

/** The WebSocket subprotocol. Mirrors `JOBS_API_WS_SUBPROTOCOL` — packages/bun-jobs/lib/api/ws/protocol.ts:18. */
export const JOBS_API_WS_SUBPROTOCOL = "bun-jobs.v1";

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
