import type { RunSummonedOptions, SummonedExit } from "@kingsleyweb/bun-jobs";
import type {
  DynamicModule,
  NestApplicationOptions,
  Type,
} from "@nestjs/common";
import { ConfigError, resolveLogger } from "@kingsleyweb/bun-common";
import { runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";
import { NestFactory } from "@nestjs/core";
import { withApplicationRole } from "./applicationRole";
import { BunJobsRegistry } from "./registry";

/** What {@link runSummonedApplication} takes: `runSummoned`'s options and Nest's. */
export interface RunSummonedApplicationOptions extends RunSummonedOptions {
  /**
   * Nest's options for the application context, for its `logger`, say. `abortOnError`
   * is always off, so a failed boot rejects rather than aborting without a word.
   */
  nest?: NestApplicationOptions;
}

/**
 * `runSummoned` for a Nest module: the entry of a process a platform starts.
 *
 * ```ts
 * // worker.ts, the file the platform runs
 * await runSummonedApplication(WorkerModule, { idleFor: 30_000 });
 * ```
 *
 * It reads this process's summon from its arguments, builds the module as an application
 * context with nothing started, and runs the worker for each queue the summon names (the
 * `@Processor` classes on it, or a `registerWorker` file) through `runSummoned` until
 * idle, a deadline or a signal. The context closes in `runSummoned`'s `beforeExit`, so a
 * provider's `onModuleDestroy` has run before `process.exit`, and the hard backstop still
 * covers it: a provider that hangs does not hold the unit, or its bill, past
 * `beforeExitTimeout` (5 s) or the budget left, and that exit keeps the unit's code. A close
 * that fails is logged, and the code stays the unit's too.
 *
 * `runSummoned` owns the process's signals, so **do not call `enableShutdownHooks` here**:
 * the two would race for `SIGTERM`. Build the workers in the main thread: Bun gives a
 * `Worker` thread an empty `argv`.
 *
 * @param module The worker's module.
 * @param options `runSummoned`'s options, and `nest`. `exit` and `mode` mean what they mean
 * there. A `beforeExit` of your own runs first, with the providers still up, and the context
 * closes whether or not it succeeds.
 * @returns How it stopped, when it does not exit.
 * @throws ConfigError when this process was not summoned, or names a queue no processor
 * here consumes.
 */
export async function runSummonedApplication(
  module: Type<unknown> | DynamicModule,
  options: RunSummonedApplicationOptions = {},
): Promise<SummonedExit> {
  const summon = summonedFromArgs();
  if (summon === undefined || summon.queues === undefined) {
    throw new ConfigError(
      "runSummonedApplication: this process was not summoned. It needs --bun-jobs-summon-id= and at least one --bun-jobs-summon-queue=, which a summoner passes",
    );
  }
  const { nest, beforeExit, ...runOptions } = options;
  const app = await NestFactory.createApplicationContext(
    withApplicationRole(module, { summon }),
    { ...nest, abortOnError: false },
  );
  try {
    const workers = app
      .get(BunJobsRegistry, { strict: false })
      .summonedWorkers(summon);
    return await runSummoned(workers, {
      ...runOptions,
      beforeExit: async (exit) => {
        try {
          await beforeExit?.(exit);
        } finally {
          await app.close();
        }
      },
    });
  } catch (error) {
    // Refused before anything ran, so the hook did not. Why it was refused is what must
    // reach the caller, whatever the close does.
    try {
      await app.close();
    } catch (closeError) {
      resolveLogger(runOptions.logger).error(
        "runSummonedApplication: closing the application failed",
        { error: closeError },
      );
    }
    throw error;
  }
}
