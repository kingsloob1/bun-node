/**
 * `@Cron` and `@Every` in a Nest application, asserted: each occurrence runs
 * **once across two instances** of the application, an undeclared series is
 * warned about and `pruneSchedules` removes it, and a bad schedule fails the
 * boot before anything is written.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/cron.ts
 * ```
 *
 * Each decorator is a bun-jobs repeat series, added at bootstrap on the
 * `scheduleQueue` (`"nest-schedule"`). An occurrence's id comes from the series
 * and its due time, so two replicas declaring the same series run it once.
 * This boots two instances at the same moment on one **file driver** in a
 * temporary directory, the cheapest backend two applications in one process
 * can share, and counts every occurrence's `runAt`.
 *
 * - **Once per occurrence.** With the two instances, no `runAt` is seen twice.
 *   The negative control gives each instance its own series name, which
 *   defeats the dedupe, and the same count then does see duplicates: the
 *   check can fail.
 * - **`@Every`'s grid.** An `@Every(250)` occurrence falls on a multiple of
 *   250 ms from the epoch, so every replica agrees on it. The example checks
 *   that, and does **not** assume the first comes one whole interval after the
 *   boot: it comes within one.
 * - **Undeclared series.** A series left in the queue that nothing here
 *   declares is warned about, once, by name, and left; with `pruneSchedules`
 *   it is removed. One a person added under a name of their own is neither
 *   warned about nor removed.
 * - **The checks at boot.** A cron expression, a zone or an interval it cannot
 *   read is a `ConfigError` naming the class and method.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { Job } from "@kingsleyweb/bun-jobs";
import type { INestApplicationContext, LoggerService } from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import {
  BunJobsModule,
  Cron,
  CurrentJob,
  Every,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** The `@Every` interval, in milliseconds. */
const INTERVAL = 250;

/** `runAt` times seen per series key. */
type Seen = Map<string, number[]>;

/** How many occurrences ran more than once: what two replicas must never do. */
function duplicates(times: readonly number[]): number {
  return times.length - new Set(times).size;
}

/** A logger keeping its warnings. */
function warnSink() {
  const warnings: string[] = [];
  const logger: LoggerService = {
    log: () => {},
    error: () => {},
    warn: (message: unknown) => {
      warnings.push(String(message));
    },
  };
  return { logger, warnings };
}

/** Boots a module as an application context. */
function boot(
  module: new () => unknown,
  logger: LoggerService | false = false,
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, {
    logger,
    abortOnError: false,
  });
}

title("@Cron and @Every: once per occurrence, across replicas");

const root = await mkdtemp(join(tmpdir(), "bun-nest-cron-"));
const backend = (namespace: string) => ({
  namespace,
  driver: { type: "file" as const, root, pollInterval: 10 },
});

try {
  /* ---------------------------------------------------------------- */
  step("Two instances, one backend: each occurrence runs once");

  const seen: Seen = new Map([
    ["every", []],
    ["cron", []],
  ]);

  @Injectable()
  class Scheduled {
    /** A cron with a seconds field, so the example need not wait a minute. */
    @Cron("* * * * * *", { name: "cron" })
    cron(@CurrentJob() job: Job) {
      seen.get("cron")!.push(job.runAt);
    }

    @Every(INTERVAL, { name: "every" })
    every(@CurrentJob() job: Job) {
      seen.get("every")!.push(job.runAt);
    }
  }

  const namespace = `examples-nest-cron-${crypto.randomUUID().slice(0, 8)}`;
  const instance = () => {
    @Module({
      imports: [BunJobsModule.forRoot(backend(namespace))],
      providers: [Scheduled],
    })
    class AppModule {}
    return AppModule;
  };
  const bootedAt = Date.now();
  // At once, so a brand-new series is created by both in the same moment.
  const apps = await Promise.all([boot(instance()), boot(instance())]);
  await waitFor(
    "four @Every and two @Cron occurrences",
    () => seen.get("every")!.length >= 4 && seen.get("cron")!.length >= 2,
  );
  await Promise.all(apps.map((app) => app.close()));

  show(
    "@Every runAt - boot (ms)",
    seen.get("every")!.map((at) => at - bootedAt),
  );
  checkEqual(
    "no @Every occurrence ran twice",
    duplicates(seen.get("every")!),
    0,
  );
  checkEqual("no @Cron occurrence ran twice", duplicates(seen.get("cron")!), 0);
  check(
    "every @Every occurrence is on the epoch grid: a multiple of the interval",
    seen.get("every")!.every((at) => at % INTERVAL === 0),
    seen.get("every"),
  );
  check(
    "the first came within one interval (and the boot) of the start, not after one whole",
    seen.get("every")![0]! - bootedAt <= INTERVAL + 1_000,
    seen.get("every")![0]! - bootedAt,
  );

  /* ---------------------------------------------------------------- */
  step("Negative control: a series name per instance defeats the dedupe");

  const controlSeen: number[] = [];
  const scheduledAs = (name: string) => {
    @Injectable()
    class Named {
      @Every(INTERVAL, { name })
      every(@CurrentJob() job: Job) {
        controlSeen.push(job.runAt);
      }
    }
    return Named;
  };
  const controlNamespace = `${namespace}-control`;
  const controlApps = await Promise.all(
    ["one", "two"].map((name) => {
      @Module({
        imports: [BunJobsModule.forRoot(backend(controlNamespace))],
        providers: [scheduledAs(name)],
      })
      class AppModule {}
      return boot(AppModule);
    }),
  );
  await waitFor("four occurrences", () => controlSeen.length >= 4);
  await Promise.all(controlApps.map((app) => app.close()));
  check(
    "two series on one grid run the same moment twice: the count can see duplicates",
    duplicates(controlSeen) > 0,
    controlSeen,
  );

  /* ---------------------------------------------------------------- */
  step("Undeclared series: warned about, and pruned only when asked");

  @Injectable()
  class Maintenance {
    @Every("1 hour", { name: "kept" })
    kept() {}
  }

  /** A context holding one series no decorator declares, and one a person added. */
  const withLeftovers = async () => {
    const leftovers = new BunJobs({
      namespace: `${namespace}-left-${crypto.randomUUID().slice(0, 8)}`,
      driver: { type: "memory" },
    });
    const queue = leftovers.queue<unknown, unknown>("nest-schedule");
    await queue.add("gone", {}, { repeat: { key: "gone", every: 3_600_000 } });
    await queue.add(
      "by-hand",
      {},
      { repeat: { key: "someone-elses", every: 3_600_000 } },
    );
    return { leftovers, queue };
  };
  const keysOf = async (queue: ReturnType<BunJobs["queue"]>) =>
    (await queue.listRepeatables()).map(({ key }) => key).sort();

  for (const prune of [false, true]) {
    const { leftovers, queue } = await withLeftovers();
    const { logger, warnings } = warnSink();
    @Module({
      imports: [
        BunJobsModule.forRoot({ jobs: leftovers, pruneSchedules: prune }),
      ],
      providers: [Maintenance],
    })
    class AppModule {}
    const app = await boot(AppModule, logger);
    const line = warnings.filter((text) =>
      text.includes("No @Cron or @Every in this process declares"),
    );
    if (prune) {
      checkEqual(
        "pruneSchedules: only the undeclared series is removed",
        await keysOf(queue),
        ["kept", "someone-elses"],
      );
      checkEqual("and nothing is warned about", line.length, 0);
    } else {
      checkEqual("by default all three stay", await keysOf(queue), [
        "gone",
        "kept",
        "someone-elses",
      ]);
      check(
        "and one warning names `gone`, and not the series a person added",
        line.length === 1 &&
          line[0]!.includes("gone") &&
          !line[0]!.includes("someone-elses"),
        line,
      );
    }
    await app.close();
    await leftovers.close();
  }

  /* ---------------------------------------------------------------- */
  step("A schedule nothing can read fails the boot, naming the method");

  @Injectable()
  class Bad {
    @Cron("not a cron")
    badCron() {}

    @Cron("0 3 * * *", { tz: "Not/AZone" })
    badZone() {}

    @Every("whenever it feels right")
    badInterval() {}
  }

  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: `${namespace}-bad`,
        driver: { type: "memory" },
      }),
    ],
    providers: [Bad],
  })
  class BadModule {}

  const error = await checkRejects("boot", () => boot(BadModule), {
    name: "ConfigError",
    message: /Bad\.badCron: @Cron cannot read "not a cron"/,
  });
  check(
    "one error names all three methods",
    ["Bad.badCron", "Bad.badZone", "Bad.badInterval"].every((method) =>
      error?.message.includes(method),
    ),
    error?.message,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

summary();
