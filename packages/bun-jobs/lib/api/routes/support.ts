import { MAX_NAME_LENGTH, NAME_PARAM_PATTERN } from "../contract/constants";
import { ApiError } from "../errors";
import { s } from "../schema/builder";
import { JobIdRefSchema } from "../schemas/jobs";
import { RunnerIdSchema } from "../schemas/runners";
import { parseSegment } from "../sources";

/**
 * Pieces shared by the queue, job and runner routes: path parameters, the
 * checks that must run before `authorize`, and bounded fan-out.
 */

/**
 * A queue name as a path parameter. Validated as a key segment before
 * `authorize` — by the route, so a bad one is 400 `INVALID_NAME` rather than
 * a validation error — and documented with that same rule as its pattern.
 */
export const QueueNameSchema = s.documented(
  s.string({
    minLength: 1,
    maxLength: MAX_NAME_LENGTH,
    description:
      'A queue name: letters, digits, "_", "." and "-", and not "." or "..". Anything else is 400 INVALID_NAME.',
  }),
  { pattern: NAME_PARAM_PATTERN },
);

/** `:queue`. */
export const QueueParams = s.query(s.object({ queue: QueueNameSchema }));

/** `:queue/:id`. */
export const JobParams = s.query(
  s.object({ queue: QueueNameSchema, id: JobIdRefSchema }),
);

/** `:queue/:key`. */
export const RepeatableParams = s.query(
  s.object({
    queue: QueueNameSchema,
    key: s.string({ minLength: 1, maxLength: 1024 }),
  }),
);

/** `:runner`. */
export const RunnerParams = s.query(s.object({ runner: RunnerIdSchema }));

/**
 * A worker's incarnation id or stable key as a path parameter. Both are key
 * segments, like a queue name, and the route checks them as such before
 * `authorize` runs, so a bad one is 400 `INVALID_NAME` rather than a
 * validation error.
 */
export const WorkerNameSchema = s.documented(
  s.string({
    minLength: 1,
    maxLength: MAX_NAME_LENGTH,
    description:
      'A worker id or stable key: letters, digits, "_", "." and "-", and not "." or "..". Anything else is 400 INVALID_NAME.',
  }),
  { pattern: NAME_PARAM_PATTERN },
);

/** `:queue/:worker` — a queue, and one incarnation of a worker on it. */
export const WorkerParams = s.query(
  s.object({ queue: QueueNameSchema, worker: WorkerNameSchema }),
);

/** `:queue/:key` — a queue, and one stable worker key on it. */
export const WorkerConfigParams = s.query(
  s.object({ queue: QueueNameSchema, key: WorkerNameSchema }),
);

/**
 * The authorize target for a worker's lifecycle route: the queue, checked as
 * {@link queueTarget} checks it, and the incarnation the path names.
 */
export function workerTarget(
  queue: string,
  worker: string,
): { queue: string; worker: string } {
  return { ...queueTarget(queue), worker: parseSegment(worker, "worker") };
}

/**
 * The authorize target for a worker configuration route: the queue, and the
 * **stable key** — which reaches every replica carrying it, and is therefore
 * the blast radius a host is deciding about.
 */
export function workerKeyTarget(
  queue: string,
  key: string,
): { queue: string; workerKey: string } {
  return {
    ...queueTarget(queue),
    workerKey: parseSegment(key, "worker key"),
  };
}

/**
 * The authorize target for a queue route. The name is checked as a key segment
 * here — before `authorize` — so `authorize` only ever sees a valid name, and
 * a bad one is 400 `INVALID_NAME`.
 */
export function queueTarget(queue: string): { queue: string } {
  return { queue: parseSegment(queue, "queue") };
}

/** The authorize target for a runner route, checked the same way. */
export function runnerTarget(runner: string): { runner: string } {
  return { runner: parseSegment(runner, "runner") };
}

/**
 * The ids of a bulk request, refused over `max` with 400 `BULK_LIMIT` — before
 * `authorize` is handed the list — and de-duplicated in order.
 */
export function bulkIds(ids: readonly string[], max: number): string[] {
  if (ids.length > max) {
    throw new ApiError(
      "BULK_LIMIT",
      400,
      `At most ${max} ids may be sent at once`,
      { context: { max } },
    );
  }
  return [...new Set(ids)];
}

/** How many backend calls a fan-out makes at once. */
export const FAN_OUT = 16;

/** Maps items through `fn` at most `concurrency` at a time, keeping their order. */
export async function mapBounded<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = FAN_OUT,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  for (let start = 0; start < items.length; start += concurrency) {
    await Promise.all(
      items.slice(start, start + concurrency).map(async (item, offset) => {
        results[start + offset] = await fn(item, start + offset);
      }),
    );
  }
  return results;
}

/** The 404 for a job that does not exist. */
export function jobNotFound(queue: string, id: string): ApiError {
  return new ApiError("JOB_NOT_FOUND", 404, `Job "${id}" was not found`, {
    context: { queue, id },
  });
}

/** The 409 for a job in a state that refuses an operation. */
export function stateConflict(
  operation: string,
  state: string,
  code: "JOB_STATE_CONFLICT" | "JOB_ACTIVE" = "JOB_STATE_CONFLICT",
): ApiError {
  return new ApiError(
    code,
    409,
    `The job cannot be ${operation} while it is ${state}`,
    { context: { state } },
  );
}

/** A time from a request: epoch milliseconds, or an RFC 3339 date-time. */
export function toEpoch(value: number | string): number {
  return typeof value === "number" ? value : Date.parse(value);
}

/** How soon a change reaches a runner registered in another process. */
export const REMOTE_LATENCY_NOTE =
  'For a runner registered in another process the change is stored at once and adopted at the owner\'s next sync — every 30s by default — or as soon as it is published when the owner listens for `control` events, which `remoteControl: "auto"` (the default) does on Redis and memory and `remoteControl: true` does everywhere, in about 25–50ms on a polling backend. A trigger for such a runner is queued for an owner to drain.';
