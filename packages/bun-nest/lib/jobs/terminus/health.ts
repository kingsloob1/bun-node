import type { BunJobs, QueueDemand } from "@kingsleyweb/bun-jobs";
import type { HealthIndicatorResult } from "@nestjs/terminus";
import { withTimeout } from "@kingsleyweb/bun-common";
import { Inject, Injectable, Logger, Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { HealthIndicatorService, TerminusModule } from "@nestjs/terminus";
import { BunJobsRegistry } from "../registry";
import { getBunJobsToken } from "../tokens";

/** How long a check may take by default, in ms: a probe must not hang on a dead backend. */
const DEFAULT_TIMEOUT = 1_000;

/** What {@link BunJobsHealthIndicator.isHealthy} checks. */
export interface BunJobsHealthOptions {
  /**
   * The queues to read and whose workers count. Defaults to every queue the backend knows,
   * one read each, so name them where there are many.
   */
  queues?: readonly string[];
  /** Down when a queue has more than this outstanding: waiting, due or active. Off by default. */
  maxOutstanding?: number;
  /**
   * Down when a queue has demand and no live worker, in any process. Defaults to `false`.
   * On a driver that keeps no worker records, the count is always 0, so leave this off.
   */
  requireWorkers?: boolean;
  /** How long the whole check may take, in ms, before it is down. Defaults to `1_000`. */
  timeout?: number;
  /** The context's `name`, for an application with several. */
  context?: string;
}

/** The figures for one queue in a result. */
interface QueueFigures {
  /** Jobs not finished. */
  outstanding: number;
  /** Live workers, in any process. */
  workers: number;
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
   * `timeout`; when a worker this application started is `stopped` or `stopping` while the
   * application is not closing; on a backlog above `maxOutstanding`; and with `requireWorkers`,
   * when a queue has demand and no live worker. A worker the application never started, with
   * `autoStart: false`, is not `stopped`, and a paused queue has no demand.
   *
   * @param key What the result is keyed by.
   * @param options What to check.
   * @returns Terminus' result: `queues`' figures when up; a `message` when down.
   */
  async isHealthy<const Key extends string>(
    key: Key,
    options: BunJobsHealthOptions = {},
  ): Promise<HealthIndicatorResult<Key>> {
    const indicator = this.service.check(key);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    try {
      const { problems, queues } = await withTimeout(
        () => this.read(options),
        timeout,
      );
      return problems.length === 0
        ? indicator.up({ queues })
        : indicator.down({ message: problems.join("; "), queues });
    } catch (error) {
      this.logger.warn(
        `The jobs health check failed: ${(error as Error)?.message}`,
      );
      return indicator.down({ message: "The jobs health check failed" });
    }
  }

  /** Does the reading, and says what is wrong. */
  private async read(options: BunJobsHealthOptions): Promise<{
    problems: string[];
    queues: Record<string, QueueFigures>;
  }> {
    const { context, maxOutstanding, requireWorkers = false } = options;
    const jobs = this.moduleRef.get<BunJobs<any, any>>(
      getBunJobsToken(context),
      { strict: false },
    );
    if (!(await jobs.driver.ping())) {
      return { problems: ["The backend is unreachable"], queues: {} };
    }
    const problems: string[] = [];
    const states = this.moduleRef
      .get(BunJobsRegistry, { strict: false })
      .startableOf(context)
      ?.workerStates();
    for (const { queue, state } of states ?? []) {
      if (
        (state === "stopped" || state === "stopping") &&
        (options.queues === undefined || options.queues.includes(queue))
      ) {
        problems.push(`The worker on "${queue}" is ${state}`);
      }
    }
    const names = options.queues ?? (await jobs.listQueues());
    const demands = await Promise.all(
      names.map(async (queue): Promise<[string, QueueDemand]> => [
        queue,
        await jobs
          .queue(queue)
          .getDemand(
            maxOutstanding === undefined ? {} : { cap: maxOutstanding + 1 },
          ),
      ]),
    );
    const queues: Record<string, QueueFigures> = {};
    for (const [queue, demand] of demands) {
      queues[queue] = {
        outstanding: demand.outstanding,
        workers: demand.workers,
      };
      if (maxOutstanding !== undefined && demand.outstanding > maxOutstanding) {
        problems.push(
          `"${queue}" has more than ${maxOutstanding} jobs outstanding`,
        );
      }
      if (requireWorkers && demand.demand > 0 && demand.workers === 0) {
        problems.push(`"${queue}" has demand and no live worker`);
      }
    }
    return { problems, queues };
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
