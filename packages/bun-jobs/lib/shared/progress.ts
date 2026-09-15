/**
 * What a unit of work reports as its progress: a percentage, or a record of
 * whatever the work wants to say.
 *
 * A runner's `ctx.progress()` takes it today, and so does a job's
 * `updateProgress()`. It lives in `shared` so both can name one type. The
 * record's values are the reporter's own business, so they stay `unknown`.
 */
export type RunProgress = number | Record<string, unknown>;
