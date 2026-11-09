import type { BunJobs, Job, JobOptions } from "@kingsleyweb/bun-jobs";
import type { INestApplicationContext } from "@nestjs/common";
import type { StartableWorkers } from "../lifecycle";
import { ConfigError } from "@kingsleyweb/bun-common";
import { ModuleRef } from "@nestjs/core";
import { BunJobsRegistry } from "../registry";
import { getBunJobsToken } from "../tokens";

/**
 * How long {@link runJob} and {@link drainJobs} wait by default, in ms: under the 5 s
 * `bun:test` and Jest give a test, so a test fails saying which job it was waiting on.
 */
const DEFAULT_WAIT = 4_000;

/** How often they look, in ms. */
const LOOK_EVERY = 5;

/** How many lines of a job's log {@link runJob} reads. */
const MOST_LOG_LINES = 10_000;

/** What {@link runJob} accepts: everything `add()` does, and where to run it. */
export interface RunJobOptions extends JobOptions {
  /** The context's `name`, for an application with several. */
  context?: string;
  /**
   * How long to wait for the job to settle, in ms, before rejecting with its state.
   * `timeout` is already `add()`'s, per attempt. Defaults to `4_000`.
   */
  settleWithin?: number;
}

/** How a job ended: what {@link runJob} resolves with. */
export interface RunJobOutcome<TResult = unknown> {
  /** The job's id. */
  id: string;
  /** How it ended: `dead` once its attempts ran out. */
  state: "completed" | "dead";
  /** What the handler returned. Only for `completed`. */
  result?: TResult;
  /** How many attempts were made. */
  attempts: number;
  /** The last failure. Only for `dead`. */
  error?: Error;
  /** What it wrote with `job.log()`, oldest first. */
  logs: string[];
}

/** What {@link drainJobs} accepts. */
export interface DrainJobsOptions {
  /** The queues to run. Defaults to every queue a worker here serves. */
  queues?: readonly string[];
  /** The context's `name`, for an application with several. */
  context?: string;
  /**
   * How long to wait, in ms, before rejecting with the queues still busy. A job due later
   * than this is not waited for, nor returned. Defaults to `4_000`.
   */
  settleWithin?: number;
}

/** The context and workers of an application that has booted. */
function hostOf(
  app: INestApplicationContext,
  context: string | undefined,
  caller: string,
): { jobs: BunJobs<any, any>; workers: StartableWorkers } {
  // Through `ModuleRef`, which every application has: on one from `NestFactory.create`,
  // whose `abortOnError` is on by default, `app.get` of what is missing ends the process.
  const moduleRef = app.get(ModuleRef, { strict: false });
  let workers: StartableWorkers | undefined;
  try {
    workers = moduleRef
      .get(BunJobsRegistry, { strict: false })
      .startableOf(context);
  } catch {
    // Nest's own error here says only that a class is missing.
  }
  if (workers === undefined) {
    throw new ConfigError(
      `${caller}: this application has no ${context === undefined ? "default jobs context" : `jobs context "${context}"`}. Import BunJobsTestingModule.forRoot()${context === undefined ? "" : ` with that name`}`,
    );
  }
  return {
    jobs: moduleRef.get<BunJobs<any, any>>(getBunJobsToken(context), {
      strict: false,
    }),
    workers,
  };
}

/**
 * Runs one job through the real worker and the real pipeline, guards, pipes, filters and
 * scope included, and answers how it ended: the counterpart of `adapter.fetch()` for a job.
 *
 * ```ts
 * const outcome = await runJob(app, "emails", "welcome", { to: "ada@example.com" });
 * // { id, state: "completed", result: "sent:ada@example.com", attempts: 1, logs: [] }
 * ```
 *
 * It starts that queue's worker alone if it is stopped, leaving it running, and neither
 * schedules nor runners start. Backoff is `0` unless `options.backoff` says otherwise, and
 * the job is kept once settled, whatever the queue's retention, so it can be read back. A
 * failing job is an outcome, not a rejection; the promise rejects when the job cannot be
 * added or does not settle in time.
 *
 * @typeParam TResult What the handler returns.
 * @param app The booted application or testing module.
 * @param queue The queue.
 * @param name The job's name.
 * @param data The job's data.
 * @param options `add()`'s options, `context` and `settleWithin`.
 * @returns How it ended.
 * @throws ConfigError when the application has not booted, or nothing here serves the queue.
 */
export async function runJob<TResult = unknown>(
  app: INestApplicationContext,
  queue: string,
  name: string,
  data: unknown,
  options: RunJobOptions = {},
): Promise<RunJobOutcome<TResult>> {
  const { context, settleWithin = DEFAULT_WAIT, ...jobOptions } = options;
  const { jobs, workers } = hostOf(app, context, "runJob");
  const { missing } = await workers.startWorkers([queue]);
  if (missing.length > 0) {
    throw new ConfigError(
      `runJob: nothing in this application serves queue "${queue}": no @Processor, registerWorker or @DefineJob`,
      { queue },
    );
  }
  const target = jobs.queue<unknown, TResult>(queue);
  const { id } = await target.add(name, data, {
    backoff: 0,
    removeOnComplete: false,
    removeOnFail: false,
    ...jobOptions,
  });
  const by = Date.now() + settleWithin;
  for (;;) {
    const job = (await target.getJob(id)) as Job<unknown, TResult> | null;
    if (job === null) {
      throw new Error(
        `runJob: job "${name}" (${id}) on queue "${queue}" was removed before it settled`,
      );
    }
    if (job.state === "completed" || job.state === "dead") {
      const { logs } = await job.getLogs({ limit: MOST_LOG_LINES });
      return {
        id,
        state: job.state,
        attempts: job.attemptsMade,
        logs,
        ...(job.state === "completed"
          ? { result: job.returnValue as TResult }
          : {}),
        ...(job.state === "dead" && job.failedReason !== null
          ? { error: job.failedReason }
          : {}),
      };
    }
    if (Date.now() >= by) {
      throw new Error(
        `runJob: job "${name}" (${id}) on queue "${queue}" is still ${job.state} after ${settleWithin} ms. settleWithin gives it longer`,
      );
    }
    await Bun.sleep(LOOK_EVERY);
  }
}

/** A queue's settled jobs. */
async function settledOf(
  queue: ReturnType<BunJobs<any, any>["queue"]>,
): Promise<Job<unknown, unknown>[]> {
  const found: Job<unknown, unknown>[] = [];
  for (;;) {
    const page = (await queue.list(["completed", "dead"], {
      offset: found.length,
      limit: 500,
    })) as Job<unknown, unknown>[];
    found.push(...page);
    if (page.length < 500) {
      return found;
    }
  }
}

/**
 * Runs workers until every listed queue has nothing left to do, for flows and fan-out, and
 * answers the jobs that settled meanwhile, in the order they finished.
 *
 * ```ts
 * await adapter.fetch("/orders", { method: "POST", body });
 * const settled = await drainJobs(app, { queues: ["orders", "emails"] });
 * ```
 *
 * It starts those queues' workers alone, leaving them running; neither schedules nor runners
 * start. Nothing to do means nothing waiting, active, or due within `settleWithin`, so a
 * retry's backoff is waited out and a job delayed for an hour is left. A paused queue has
 * nothing to do. Jobs a queue's retention removes at once are not returned. So that a queue
 * cannot look idle while a job on another is adding to it, it takes two clean looks in a row.
 *
 * @param app The booted application or testing module.
 * @param options Which queues, `context` and `settleWithin`.
 * @returns The jobs that settled.
 * @throws ConfigError when the application has not booted, or nothing here serves a listed
 * queue.
 */
export async function drainJobs(
  app: INestApplicationContext,
  options: DrainJobsOptions = {},
): Promise<Job<unknown, unknown>[]> {
  const { context, queues, settleWithin = DEFAULT_WAIT } = options;
  const { jobs, workers } = hostOf(app, context, "drainJobs");
  // Read before anything starts, so nothing can settle unseen in between. A queue the store
  // does not know yet has nothing settled.
  const before = new Set(
    (
      await Promise.all(
        (queues ?? (await jobs.listQueues())).map(async (queue) =>
          (await settledOf(jobs.queue(queue))).map(
            (job) => `${queue}\0${job.id}`,
          ),
        ),
      )
    ).flat(),
  );
  const { started, missing } = await workers.startWorkers(queues);
  if (missing.length > 0) {
    throw new ConfigError(
      `drainJobs: nothing in this application serves ${missing.map((queue) => `queue "${queue}"`).join(", ")}: no @Processor, registerWorker or @DefineJob`,
      { missing },
    );
  }
  const targets = started.map((queue) => jobs.queue<unknown, unknown>(queue));
  const by = Date.now() + settleWithin;
  for (let clean = 0; clean < 2;) {
    const busy = (
      await Promise.all(
        targets.map(async (target) => ({
          queue: target.name,
          demand: await target.getDemand(),
        })),
      )
    ).filter(
      ({ demand }) =>
        demand.outstanding > 0 ||
        (demand.nextDueAt !== null && demand.nextDueAt <= by),
    );
    clean = busy.length === 0 ? clean + 1 : 0;
    if (busy.length > 0 && Date.now() >= by) {
      throw new Error(
        `drainJobs: still busy after ${settleWithin} ms: ${busy.map(({ queue, demand }) => `"${queue}" (${demand.outstanding} outstanding)`).join(", ")}. settleWithin gives it longer`,
      );
    }
    await Bun.sleep(LOOK_EVERY);
  }
  const settled = await Promise.all(
    targets.map(async (target) =>
      (await settledOf(target)).filter(
        (job) => !before.has(`${target.name}\0${job.id}`),
      ),
    ),
  );
  return settled
    .flat()
    .toSorted((a, b) => (a.finishedOn ?? 0) - (b.finishedOn ?? 0));
}
