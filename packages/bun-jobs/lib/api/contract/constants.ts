/**
 * The management API's constants: action names, protocol versions, the
 * socket's subprotocol and close codes, job states and event names — and the
 * two pure functions a client needs to name a job channel, `encodeJobId` and
 * `decodeJobId`.
 *
 * **Browser-safe by construction.** This file imports nothing at all, so a
 * client (a React management UI, a CLI) can bundle it without pulling in a
 * driver, bun-common or any `node:*` / `bun:*` module. The server modules
 * import these values from here rather than declaring their own, so there is
 * exactly one definition of each. `__tests__/api/api-contract.test.ts` holds
 * the import graph to that promise.
 */

/** The API protocol version, reported by `/meta` and the socket's `hello`. */
export const JOBS_API_PROTOCOL_VERSION = 1 as const;

/** Every action `authorize` can be asked about. The list is the source of truth for specs and pruning. */
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
  "jobs.fail",
  "repeatables.list",
  "repeatables.remove",
  "repeatables.disable",
  "repeatables.enable",
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

/** One authorizable action. */
export type JobsApiAction = (typeof JOBS_API_ACTIONS)[number];

/**
 * Actions that change state; all are removed by `readOnly: true`.
 *
 * `queues.limits` is only ever the `PUT`: reading limits is `queues.read`.
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
    "jobs.fail",
    "repeatables.remove",
    "repeatables.disable",
    "repeatables.enable",
    "runners.trigger",
    "runners.pause",
    "runners.resume",
    "runners.kill",
    "runners.reschedule",
    "runners.resetStats",
  ]);

/**
 * Actions excluded when `actions` is not given, because they write
 * caller-supplied payloads. Passing `actions` replaces the default entirely:
 * it is an allow-list, so naming only these disables every other action.
 */
export const JOBS_API_OPT_IN_ACTIONS: ReadonlySet<JobsApiAction> =
  new Set<JobsApiAction>(["jobs.add", "jobs.update"]);

/** Which half of the package the API exposes: routes, channels and spec entries alike. */
export type JobsApiMode = "jobs" | "runner" | "both";

/** The WebSocket subprotocol. A client offering subprotocols must offer this one. */
export const JOBS_API_WS_SUBPROTOCOL = "bun-jobs.v1";

/** Close codes the server uses. */
export const JOBS_API_WS_CLOSE = {
  /** A normal close. */
  NORMAL: 1000,
  /** The API is closing (`api.close()`). */
  GOING_AWAY: 1001,
  /** The client sent a binary frame. */
  UNSUPPORTED_DATA: 1003,
  /** The client broke a policy: rate limit breached twice within 10 s. */
  POLICY: 1008,
  /** The client sent a frame over `maxMessageBytes`. */
  TOO_BIG: 1009,
  /** The client could not keep up for `slowConsumerTimeoutMs`. */
  SLOW_CONSUMER: 4008,
  /** Reserved: the session is no longer authorized. Not sent in protocol 1. */
  UNAUTHORIZED: 4401,
} as const;

/**
 * Most channels one `subscribe` or `unsubscribe` frame may name: well above
 * the default of 50 subscriptions a connection may hold, and small enough that
 * one frame's parsing stays cheap.
 */
export const JOBS_API_WS_MAX_CHANNELS_PER_FRAME = 256;

/** Every job state, in lifecycle order. */
export const JOB_STATES = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "dead",
  "waiting-children",
] as const;

/** Where a job is in its lifecycle. */
export type JobState = (typeof JOB_STATES)[number];

/** Optional job fields a client asks for with `include=`. */
export const JOB_INCLUDES = [
  "data",
  "returnValue",
  "stacktrace",
  "opts",
] as const;

/** One optional job field. */
export type JobInclude = (typeof JOB_INCLUDES)[number];

/** Every queue event name, in the order the server declares them. */
export const QUEUE_EVENT_TYPES = [
  "added",
  "duplicate",
  "waiting",
  "delayed",
  "active",
  "progress",
  "completed",
  "failed",
  "retrying",
  "dead",
  "stalled",
  "removed",
  "promoted",
  "paused",
  "resumed",
  "drained",
  "cleaned",
  "retried",
  "debounced",
  "throttled",
  "repeatScheduled",
] as const;

/** Every runner event name, in the order the server declares them. */
export const RUNNER_EVENT_TYPES = [
  "control",
  "started",
  "succeeded",
  "failed",
  "queued",
  "skipped",
  "timeout",
  "killed",
] as const;

/** The name of any queue event. */
export type QueueEventName = (typeof QUEUE_EVENT_TYPES)[number];

/** The name of any runner event. */
export type RunnerEventName = (typeof RUNNER_EVENT_TYPES)[number];

/**
 * Every distinct event name, queue events first: `failed` is both a queue and
 * a runner event, and appears once. What a `subscribe` frame's `events`
 * filter accepts.
 */
export const EVENT_TYPES = [
  ...QUEUE_EVENT_TYPES,
  "control",
  "started",
  "succeeded",
  "queued",
  "skipped",
  "timeout",
  "killed",
] as const satisfies readonly (QueueEventName | RunnerEventName)[];

/** Any event name a subscription can filter on. */
export type EventName = (typeof EVENT_TYPES)[number];

/** The pattern a queue name or runner id must match, besides not being `"."` or `".."`. */
export const NAME_SEGMENT_PATTERN = "^[\\w.-]+$";

/**
 * The same rule as one JSON Schema pattern, `"."` and `".."` excluded: what the
 * routes enforce on a `:queue` or `:runner` path segment (400 `INVALID_NAME`).
 */
export const NAME_PARAM_PATTERN = "^(?!\\.\\.?$)[\\w.-]+$";

/** Longest a queue name or runner id may be, in characters. */
export const MAX_NAME_LENGTH = 200;

/**
 * Longest id a caller may choose for a new job (`opts.jobId`), in
 * characters: the cap bun-jobs' own `assertJobId` applies
 * (`MAX_JOB_ID_LENGTH` in `lib/queue/options.ts`, restated here because the
 * contract must not import the queue; a test pins the two together). MySQL and
 * MariaDB store ids as `VARCHAR(191)`, and one cap everywhere keeps an id that
 * works on one driver from failing on another. `assertJobId` stays the
 * authority: it counts UTF-16 units and refuses control characters, a leading
 * `.` and a lone surrogate, answered 400 `INVALID_ARGUMENT`.
 */
export const MAX_JOB_ID_LENGTH = 191;

/**
 * Longest id that may *address* an existing job — in a path, a bulk body or a
 * lookup. Wider than {@link MAX_JOB_ID_LENGTH} on purpose: a backend may hold
 * jobs whose ids predate that cap, and they must stay reachable.
 */
export const MAX_JOB_REF_LENGTH = 1024;

/* ------------------------------------------------------------------ *
 * Channel names
 * ------------------------------------------------------------------ */

/**
 * Escapes a job id for a channel name: `encodeURIComponent`, except that a
 * lone UTF-16 surrogate — which `encodeURIComponent` refuses with a `URIError`
 * — becomes `%uXXXX` (upper-case hex). A well-formed id is therefore escaped
 * exactly as before, and {@link decodeJobId} reverses either form. The two
 * cannot be confused: `encodeURIComponent` escapes every `%` as `%25`.
 *
 * A client names a job's channel as `queue/<queue>/job/${encodeJobId(id)}`.
 * Pure, with no imports, so it is safe in a browser.
 */
export function encodeJobId(jobId: string): string {
  if (jobId.isWellFormed()) {
    return encodeURIComponent(jobId);
  }
  let out = "";
  let run = 0;
  for (let index = 0; index < jobId.length; index++) {
    const unit = jobId.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) {
      continue;
    }
    const next = jobId.charCodeAt(index + 1);
    if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      index++;
      continue;
    }
    out += `${encodeURIComponent(jobId.slice(run, index))}%u${unit.toString(16).toUpperCase()}`;
    run = index + 1;
  }
  return out + encodeURIComponent(jobId.slice(run));
}

/**
 * Reverses {@link encodeJobId}: the job id a job channel's last segment
 * names. Throws `URIError` on a malformed escape, and on a `%uXXXX` escape of
 * anything but a surrogate.
 */
export function decodeJobId(encoded: string): string {
  return encoded
    .split(/(%u[\dA-Fa-f]{4})/)
    .map((part, index) => {
      if (index % 2 === 0) {
        return decodeURIComponent(part);
      }
      const unit = Number.parseInt(part.slice(2), 16);
      // Only a surrogate needs this form; anything else has a standard one.
      if (unit < 0xd800 || unit > 0xdfff) {
        throw new URIError(`"${part}" is not a surrogate escape`);
      }
      return String.fromCharCode(unit);
    })
    .join("");
}
