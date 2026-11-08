/**
 * The child half of `servers.test.ts`'s two-process proof: a process of its
 * own that builds its own cache over the job's backend (Redis, Postgres,
 * MySQL, MariaDB or a SQLite file), its own
 * `cacheThrottleStore` and its own `throttle()`, prints `{"ready":true}`,
 * waits at the start barrier (its stdin closing) so that both children start
 * together, then sends its requests for one client through `router.fetch()`
 * and prints how many were allowed, refused and failed as one JSON line.
 *
 * `failMode: "closed"`: a store failure answers 503 and is counted as
 * failed, never as allowed, so a broken backend cannot pass the proof.
 */
import process from "node:process";
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import type { CacheDriver } from "../../lib/index";
import {
  createCache,
  mariadbDriver,
  mysqlDriver,
  postgresDriver,
  redisDriver,
  sqliteDriver,
} from "../../lib/index";
import { cacheThrottleStore } from "../../lib/throttle/index";

/** The job the parent passes on the command line, as JSON. */
export interface ThrottleWorkerJob {
  /** Which backend to build the cache on. */
  backend: "redis" | "postgres" | "mysql" | "mariadb" | "sqlite";
  /** The backend's URL (a SQLite file's path). */
  url: string;
  /** The driver's key prefix (Redis) or table prefix (Postgres): this run's own. */
  prefix: string;
  /** The store's namespace (`cacheThrottleStore`'s `namespace`). */
  namespace: string;
  /** The limit every child sets. */
  limit: number;
  /** How many requests this child sends. */
  requests: number;
  /** The throttle's fixed clock, epoch ms (each child may be given its own: a skewed clock). */
  now: number;
  /** The algorithm; default the sliding window. */
  algorithm?: "fixed-window" | "gcra" | "sliding-window";
  /** `cacheThrottleStore`'s `clock`; default `"process"`, so `now` places every request. */
  clock?: "process" | "store";
}

/** What the child prints when it is done. */
export interface ThrottleWorkerResult {
  /** Requests answered 200. */
  allowed: number;
  /** Requests answered 429. */
  limited: number;
  /** Anything else (a 503 from a store failure). */
  failed: number;
}

/** Prints one JSON line on stdout, flushed before it resolves. */
async function emit(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`);
}

/** Builds the job's driver. */
function driverFor(job: ThrottleWorkerJob): CacheDriver {
  switch (job.backend) {
    case "redis":
      return redisDriver({ url: job.url, prefix: job.prefix });
    case "postgres":
      return postgresDriver({ url: job.url, prefix: job.prefix });
    case "mysql":
      return mysqlDriver({ url: job.url, prefix: job.prefix });
    case "mariadb":
      return mariadbDriver({ url: job.url, prefix: job.prefix });
    case "sqlite":
      return sqliteDriver({ path: job.url });
  }
}

/** Runs the job. */
async function main(): Promise<void> {
  const job = JSON.parse(process.argv[2] ?? "{}") as ThrottleWorkerJob;
  const driver = driverFor(job);
  const cache = createCache({ driver, sweepInterval: 0 });
  try {
    await driver.connect?.();
    const store = cacheThrottleStore(cache, {
      namespace: job.namespace,
      clock: job.clock ?? "process",
    });
    const router = new BunRouter({
      throttle: {
        limit: job.limit,
        window: "1h",
        store,
        algorithm: job.algorithm,
        failMode: "closed",
        key: () => "one-client",
        now: () => job.now,
      },
    });
    router.get("/", (_req, res) => {
      res.send("ok");
    });
    router.use(((err, _req, res, _next) => {
      res.status(503).send(String(err));
    }) satisfies RouterErrorMiddlewareHandler);
    await emit({ ready: true });
    await Bun.stdin.text();
    // Ten waves of concurrent requests, yielding between them, so the two
    // children's increments genuinely interleave on the backend.
    const result: ThrottleWorkerResult = { allowed: 0, limited: 0, failed: 0 };
    const perWave = Math.ceil(job.requests / 10);
    for (let done = 0; done < job.requests; done += perWave) {
      const wave = Math.min(perWave, job.requests - done);
      const answers = await Promise.all(
        Array.from({ length: wave }, async () => await router.fetch("/")),
      );
      for (const answer of answers) {
        if (answer.status === 200) result.allowed++;
        else if (answer.status === 429) result.limited++;
        else result.failed++;
      }
      await Bun.sleep(0);
    }
    await emit(result);
  } finally {
    await cache.close();
  }
}

// A pending SQL query does not always hold Bun's event loop open
// (oven-sh/bun#27102, `crossprocess-worker.ts` says more): the timer does,
// until main() settles.
const keepAlive = setInterval(() => {}, 1 << 30);
void main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  })
  .finally(() => {
    clearInterval(keepAlive);
  });
