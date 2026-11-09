import type { BunJobs } from "@kingsleyweb/bun-jobs";
import type { HealthIndicatorResult } from "@nestjs/terminus";
import { withTimeout } from "@kingsleyweb/bun-common";
import { NotSupportedError } from "@kingsleyweb/bun-jobs";
import { Inject, Injectable, Logger, Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { HealthIndicatorService, TerminusModule } from "@nestjs/terminus";
import { BunJobsRegistry } from "../registry";
import { getBunJobsToken } from "../tokens";

/** How long a check may take by default, in ms: a probe must not hang on a dead backend. */
const DEFAULT_TIMEOUT = 1_000;

/** The most queues `queues: "all"` reads in one probe. */
const MOST_QUEUES = 100;

/** How many queues are read at a time, so a probe cannot take a whole connection pool. */
const READ_AT_ONCE = 10;

/** What {@link BunJobsHealthIndicator.isHealthy} checks. */
export interface BunJobsHealthOptions {
  /**
   * The queues to read and whose workers count. Defaults to the queues this application
   * registers or has a worker on, so a probe does not read other services' on a shared
   * backend. `"all"` is every queue the backend knows, the first 100 by name, with
   * `queuesNotRead` in the result saying how many that left out.
   */
  queues?: readonly string[] | "all";
  /** Down when a queue has more than this outstanding: waiting, due or active. Off by default. */
  maxOutstanding?: number;
  /**
   * Down when a queue has demand and no live worker, in any process. Defaults to `false`.
   * A parked worker is alive. On a driver that keeps no worker records, nobody can tell, so
   * this is not down for it: `workers` reads `"unknown"`, and it is logged once.
   */
  requireWorkers?: boolean;
  /** How long the whole check may take, in ms, before it is down. Defaults to `1_000`. */
  timeout?: number;
  /** The context's `name`, for an application with several. */
  context?: string;
}

/** The figures for one queue in a result. */
interface QueueFigures {
  /** Jobs not finished, counted up to `maxOutstanding + 1`, or 10,000 without it. */
  outstanding: number;
  /** Live workers, in any process; `"unknown"` where the driver cannot say. */
  workers: number | "unknown";
}

/** What a probe found. */
interface Reading {
  /** What is wrong, for the message. */
  problems: string[];
  /** The details of a result. */
  details: {
    /** Each queue read. */
    queues: Record<string, QueueFigures>;
    /** The queues with a worker here parked on purpose, when there are any. */
    parked?: string[];
    /** How many queues `"all"` left out, when it did. */
    queuesNotRead?: number;
  };
}

/**
 * A terminus health indicator for bun-jobs.
 *
 * ```ts
 * @Get("health") @HealthCheck()
 * check() {
 *   return this.health.check([
 *     () => this.jobs.isHealthy("jobs", { queues: ["emails"], maxOutstanding: 10_000, requireWorkers: true }),
 *   ]);
 * }
 * ```
 */
@Injectable()
export class BunJobsHealthIndicator {
  /** Where a failure's cause goes, since a health response is often public. */
  private readonly logger = new Logger("BunJobsHealthIndicator");
  /** Whether a driver with no worker records has been logged, so a probe does not repeat it. */
  private warnedNoRecords = false;

  constructor(
    /** Terminus' way to answer. */
    @Inject(HealthIndicatorService)
    private readonly service: HealthIndicatorService,
    /** Where the context is found when asked. */
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Checks bun-jobs, and never rejects: anything that goes wrong is `down`.
   *
   * It is down when the backend's `ping()` answers `false`, throws, or the check outlives
   * `timeout`; when a worker here has ended while the application has not, its `run()` having
   * finished; on a backlog above `maxOutstanding`; and with `requireWorkers`, when a queue has
   * demand and no live worker.
   *
   * **A worker parked on purpose is not down**, from `BunJobsLifecycle.stop()` or remote control:
   * a platform restarting the service for it would undo the decision. It is in `parked`, in the
   * result. A worker never started, with `autoStart: false`, is not down either.
   *
   * **A probe costs** one `ping()`, and three driver reads per queue (`isQueuePaused`,
   * `listWorkers`, `countDemand`, measured on memory, SQLite, Redis, Postgres and MongoDB), for
   * ten queues at a time. They are bounded reads, never a scan. `queues: "all"` adds one listing
   * and reads at most 100.
   * `requireWorkers` adds one `listWorkers()` for a queue with demand and no worker, and only then.
   *
   * @param key What the result is keyed by.
   * @param options What to check.
   * @returns Terminus' result: `queues`' figures, and `parked` and `queuesNotRead` when they
   * apply; a `message` too when down.
   */
  async isHealthy<const Key extends string>(
    key: Key,
    options: BunJobsHealthOptions = {},
  ): Promise<HealthIndicatorResult<Key>> {
    const indicator = this.service.check(key);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    try {
      const { problems, details } = await withTimeout(
        () => this.read(options),
        timeout,
      );
      return problems.length === 0
        ? indicator.up(details)
        : indicator.down({ message: problems.join("; "), ...details });
    } catch (error) {
      this.logger.warn(
        `The jobs health check failed: ${(error as Error)?.message}`,
      );
      return indicator.down({ message: "The jobs health check failed" });
    }
  }

  /** Does the reading, and says what is wrong. */
  private async read(options: BunJobsHealthOptions): Promise<Reading> {
    const { context, maxOutstanding, requireWorkers = false } = options;
    const jobs = this.moduleRef.get<BunJobs<any, any>>(
      getBunJobsToken(context),
      { strict: false },
    );
    if (!(await jobs.driver.ping())) {
      return {
        problems: ["The backend is unreachable"],
        details: { queues: {} },
      };
    }
    const registry = this.moduleRef.get(BunJobsRegistry, { strict: false });
    const standings = registry.startableOf(context)?.workerStates() ?? [];

    let names: readonly string[];
    let queuesNotRead = 0;
    if (options.queues === "all") {
      const known = (await jobs.listQueues()).toSorted();
      names = known.slice(0, MOST_QUEUES);
      queuesNotRead = known.length - names.length;
    } else {
      names = options.queues ?? [
        ...new Set([
          ...registry.queuesOf(context),
          ...standings.map(({ queue }) => queue),
        ]),
      ];
    }

    const problems: string[] = [];
    const parked: string[] = [];
    for (const { queue, standing } of standings) {
      if (options.queues !== undefined && !names.includes(queue)) {
        continue;
      }
      if (standing === "ended") {
        problems.push(`The worker on "${queue}" has ended`);
      } else if (standing === "parked") {
        parked.push(queue);
      }
    }

    const queues: Record<string, QueueFigures> = {};
    for (let at = 0; at < names.length; at += READ_AT_ONCE) {
      const read = await Promise.all(
        names
          .slice(at, at + READ_AT_ONCE)
          .map(
            async (queue) =>
              [
                queue,
                await jobs
                  .queue(queue)
                  .getDemand(
                    maxOutstanding === undefined
                      ? {}
                      : { cap: maxOutstanding + 1 },
                  ),
              ] as const,
          ),
      );
      for (const [queue, demand] of read) {
        let workers: QueueFigures["workers"] = demand.workers;
        if (requireWorkers && demand.demand > 0 && workers === 0) {
          if (await this.keepsWorkerRecords(jobs, queue)) {
            problems.push(`"${queue}" has demand and no live worker`);
          } else {
            workers = "unknown";
          }
        }
        queues[queue] = { outstanding: demand.outstanding, workers };
        if (
          maxOutstanding !== undefined &&
          demand.outstanding > maxOutstanding
        ) {
          problems.push(
            `"${queue}" has more than ${maxOutstanding} jobs outstanding`,
          );
        }
      }
    }
    return {
      problems,
      details: {
        queues,
        ...(parked.length === 0 ? {} : { parked }),
        ...(queuesNotRead === 0 ? {} : { queuesNotRead }),
      },
    };
  }

  /** Whether a count of 0 means anything on this driver. */
  private async keepsWorkerRecords(
    jobs: BunJobs<any, any>,
    queue: string,
  ): Promise<boolean> {
    try {
      await jobs.queue(queue).listWorkers();
      return true;
    } catch (error) {
      if (!(error instanceof NotSupportedError)) {
        throw error;
      }
      if (!this.warnedNoRecords) {
        this.warnedNoRecords = true;
        this.logger.warn(
          `requireWorkers cannot tell on driver "${jobs.driver.name}", which keeps no worker records: workers read "unknown"`,
        );
      }
      return false;
    }
  }
}

/**
 * Provides {@link BunJobsHealthIndicator} and re-exports `TerminusModule`, for
 * `HealthCheckService`. `BunJobsModule` is found wherever it is.
 */
@Module({
  imports: [TerminusModule],
  providers: [BunJobsHealthIndicator],
  exports: [BunJobsHealthIndicator, TerminusModule],
})
export class BunJobsHealthModule {}
