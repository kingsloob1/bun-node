/**
 * `@kingsleyweb/bun-jobs` — background work for Bun.
 *
 * Two subsystems share one driver contract and one required `namespace`:
 *
 * - the **runner** (`BunRunner`): run a JS/TS file on a schedule or on
 *   demand, in a child process, a `Worker` or in-process, with cluster-wide
 *   single-run locking, queued triggers, timeouts and kill escalation;
 * - the **queue** (`BunQueue` / `BunQueueWorker`): queue and process jobs
 *   across processes and services with priorities, delays, retries, stalled
 *   recovery, repeatable jobs and retention.
 *
 * The public surface is assembled here in grouped, alphabetised export blocks
 * as each subsystem lands: shared primitives, drivers, runner, queue, and the
 * per-service `BunJobs` context.
 */
export {};
