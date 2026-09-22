import type { DriverConfig, JobsDriver } from "../../../lib/index";
import type {
  Backend,
  JobPayload,
  QueueContender,
  QueueHandle,
  QueueSetupContext,
} from "../../lib/types";
import { BunQueue, BunQueueWorker, createDriver } from "../../../lib/index";
import { padding } from "../../lib/harness";

/**
 * `@kingsleyweb/bun-jobs` — the library this repository ships, on each of the
 * backends it supports.
 *
 * Configured the way the competing entries are: one attempt, no retry, the
 * result discarded on completion. Worker maintenance stays on, because that is
 * what a caller gets by default and turning it off would flatter the figure.
 */

/** Builds the driver config for one backend. */
function driverConfig(backend: Backend, url: string): DriverConfig {
  switch (backend) {
    case "memory":
      return { type: "memory" };
    case "file":
      return { type: "file", root: url };
    case "sqlite":
      return { type: "sql", url, adapter: "sqlite" };
    case "postgres":
      return { type: "sql", url, adapter: "postgres" };
    case "mysql":
      return { type: "sql", url, adapter: "mysql" };
    case "mariadb":
      return { type: "sql", url, adapter: "mariadb" };
    case "redis":
      return { type: "redis", url };
    case "mongodb":
      return { type: "mongodb", url };
  }
}

/**
 * The memory driver keeps its jobs in the instance, so a producer and a
 * consumer only see the same queue when they hold the same driver. One
 * per process is therefore what "the memory backend" means, and a second
 * consumer in the contention scenario shares it exactly as it would in a real
 * single-process deployment.
 */
let memoryDriver: JobsDriver | undefined;

/**
 * Removes what earlier runs left in the namespace.
 *
 * `ctx.name` is unique per run, so a run cannot read another's jobs — but the
 * rows stay, and on a shared table that is not free: the SQL driver keeps the
 * planner's statistics fresh with `ANALYZE`, whose cost is proportional to
 * every row in the table, not just this run's. Left alone, `bun_jobs_jobs`
 * reached 112,300 rows and 78MB
 * across one session, which made every later Postgres figure worse than the
 * one before it and none of them comparable.
 *
 * Safe with several consumers in one run: each is given the same `ctx.name`,
 * and this only ever touches queues that are not it.
 */
async function sweepPreviousRuns(
  driver: JobsDriver,
  namespace: string,
  keep: string,
): Promise<void> {
  try {
    const queues = await driver.listQueues(namespace);

    for (const queue of queues) {
      if (queue !== keep) {
        await driver.drainQueue({ ns: namespace, queue }, true);
      }
    }
  } catch {
    // Best effort: a backend that cannot list its queues simply keeps them,
    // which is what happened before this existed.
  }
}

/** Builds a contender for one backend. */
function contender(backend: Backend, label: string): QueueContender {
  return {
    id: `bun-jobs-${backend}`,
    label,
    backend,
    ours: true,
    nativeBulk: true,
    note:
      backend === "memory"
        ? "in-process only; producer and consumer share one driver, as they must"
        : undefined,
    async setup(ctx: QueueSetupContext): Promise<QueueHandle> {
      const namespace = "bench";
      const pad = padding(ctx.payloadBytes);

      // Every other backend gets a driver per handle, so each consumer holds
      // its own connections — the same shape a separate process would have.
      const shared = backend === "memory";
      const driver = shared
        ? (memoryDriver ??= createDriver(driverConfig(backend, ctx.url)))
        : createDriver(driverConfig(backend, ctx.url));

      const queue = new BunQueue<JobPayload>(ctx.name, {
        namespace,
        driver,
        defaultJobOptions: { attempts: 1, removeOnComplete: true },
      });
      queue.on("error", ctx.onError);

      await sweepPreviousRuns(driver, namespace, ctx.name);

      let worker: BunQueueWorker<JobPayload> | undefined;

      return {
        async add(payload) {
          await queue.add("bench", pad ? { ...payload, pad } : payload);
        },

        async addBulk(payloads) {
          await queue.addBulk(
            payloads.map((payload) => ({
              name: "bench" as const,
              data: pad ? { ...payload, pad } : payload,
            })),
          );
        },

        async startWorker(concurrency) {
          worker = new BunQueueWorker<JobPayload>(
            ctx.name,
            (job) => {
              ctx.onReceive(job.data);
            },
            { namespace, driver, concurrency, autorun: false },
          );
          worker.on("error", ctx.onError);
          // Emitted once the completion write has landed — the worker records
          // completions off the critical path, so this trails the handler.
          worker.on("completed", (job) => ctx.onCompleted(job.data));
          worker.on("lockLost", (job) => {
            ctx.onError(new Error(`lost the lock on job ${job.id}`));
          });
          void worker.run();
          await Bun.sleep(20);
        },

        async stopWorker() {
          await worker?.close({ timeout: 5000 });
          worker = undefined;
        },

        async reset() {
          await queue.drain({ delayed: true });
          for (const state of ["completed", "dead", "failed"] as const) {
            await queue.clean(state, { olderThan: 0 });
          }
        },

        async close() {
          await worker?.close({ force: true }).catch(() => {});
          await queue.close().catch(() => {});
          if (!shared) await driver.close().catch(() => {});
        },
      };
    },
  };
}

/** Every backend `bun-jobs` can be benchmarked on. */
export const bunJobsContenders: QueueContender[] = [
  contender("memory", "bun-jobs (memory)"),
  contender("file", "bun-jobs (file)"),
  contender("sqlite", "bun-jobs (sqlite)"),
  contender("redis", "bun-jobs (redis)"),
  contender("postgres", "bun-jobs (postgres)"),
  contender("mysql", "bun-jobs (mysql)"),
  contender("mariadb", "bun-jobs (mariadb)"),
  contender("mongodb", "bun-jobs (mongodb)"),
];
