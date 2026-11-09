/**
 * `@Cron`, `@Every`, `pruneSchedules` and `registerRunner` (nest-jobs-decorators
 * PR-n5), under real Nest applications on a real bun-jobs driver. The two-instance
 * tests are the point: a series runs once per occurrence, however many replicas
 * declare it.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type { BunQueueWorker, BunRunner, Job } from "@kingsleyweb/bun-jobs";
import type {
  CanActivate,
  INestApplicationContext,
  LoggerService,
  Type,
} from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, createDeferred } from "@kingsleyweb/bun-common";
import { BunJobs, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Injectable, Logger, Module, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  BunJobsLifecycle,
  BunJobsModule,
  Cron,
  CurrentJob,
  Every,
  getRunnerToken,
  getWorkerToken,
  InjectRunner,
  JobSignal,
  OnRunnerEvent,
  Process,
  Processor,
} from "../lib/jobs/index";
import "reflect-metadata";

/** A runner file that finishes with one result. */
const RUNNER_FILE = `${import.meta.dir}/fixtures/jobs-decorators/runner.ts`;

/** Applications to close after each test, and anything else to undo. */
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** What a test's context is built with: unique, on the memory driver. */
function contextOptions() {
  return {
    namespace: `nest-schedule-${crypto.randomUUID().slice(0, 8)}`,
    driver: { type: "memory" as const },
  };
}

/** A context borrowed from the test, closed afterwards. */
function borrowed(): BunJobs {
  const jobs = new BunJobs({
    namespace: `nest-schedule-${crypto.randomUUID().slice(0, 8)}`,
    driver: new MemoryDriver(),
  });
  cleanups.push(() => jobs.close());
  return jobs;
}

/** A shared backend two applications can both reach. */
async function fileBackend() {
  const root = await mkdtemp(join(tmpdir(), "bun-nest-schedule-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return {
    namespace: `nest-schedule-${crypto.randomUUID().slice(0, 8)}`,
    driver: { type: "file" as const, root, pollInterval: 10 },
  };
}

/** A module class with the given metadata. */
function moduleOf(metadata: Parameters<typeof Module>[0]): Type<unknown> {
  class AppModule {}
  Module(metadata)(AppModule);
  return AppModule;
}

/** Boots an application context; a failure rejects rather than aborting. */
async function boot(
  module: Type<unknown>,
  logger: LoggerService | false = false,
): Promise<INestApplicationContext> {
  return await NestFactory.createApplicationContext(module, {
    logger,
    abortOnError: false,
  });
}

/** Boots one that closes after the test. */
async function bootForTest(
  module: Type<unknown>,
  logger: LoggerService | false = false,
): Promise<INestApplicationContext> {
  const app = await boot(module, logger);
  cleanups.push(() => app.close());
  return app;
}

/** The message of the `ConfigError` a failing boot gives. */
async function bootProblem(module: Type<unknown>): Promise<string> {
  let caught: unknown;
  let app: INestApplicationContext | undefined;
  try {
    app = await boot(module);
  } catch (error) {
    caught = error;
  }
  await app?.close();
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).message;
}

/** A logger that keeps its warnings, restored afterwards. */
function warnSink() {
  const warnings: string[] = [];
  const logger: LoggerService = {
    log: () => {},
    error: () => {},
    warn: (message: unknown) => {
      warnings.push(String(message));
    },
  };
  cleanups.push(() => Logger.overrideLogger(false));
  return { logger, warnings };
}

/** Records occurrences, and resolves once every series has reached a count. */
function occurrences(series: readonly string[], enough: number) {
  const seen = new Map<string, number[]>(series.map((key) => [key, []]));
  const done = createDeferred<void>();
  return {
    seen,
    done: done.promise,
    record(key: string, runAt: number) {
      seen.get(key)!.push(runAt);
      if ([...seen.values()].every((times) => times.length >= enough)) {
        done.resolve();
      }
    },
  };
}

/** How many occurrences ran more than once: what two replicas must never do. */
function duplicates(times: readonly number[]): number {
  return times.length - new Set(times).size;
}

describe("across replicas", () => {
  it("two application instances run each @Cron and @Every occurrence once", async () => {
    const backend = await fileBackend();
    const run = occurrences(["cron", "every"], 3);

    @Injectable()
    class Scheduled {
      @Cron("* * * * * *")
      cron(@CurrentJob() job: Job) {
        run.record("cron", job.runAt);
      }

      @Every(200)
      every(@CurrentJob() job: Job) {
        run.record("every", job.runAt);
      }
    }

    const instance = () =>
      moduleOf({
        imports: [BunJobsModule.forRoot(backend)],
        providers: [Scheduled],
      });
    // At once, so a brand-new series is created by both in the same moment.
    const [first, second] = await Promise.all([
      boot(instance()),
      boot(instance()),
    ]);
    await run.done;
    await Promise.all([first.close(), second.close()]);

    expect(duplicates(run.seen.get("cron")!)).toBe(0);
    expect(duplicates(run.seen.get("every")!)).toBe(0);
    expect(run.seen.get("cron")!.length).toBeGreaterThanOrEqual(3);
    expect(run.seen.get("every")!.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("two replicas creating a brand-new @Every at the same moment schedule one first occurrence", async () => {
    @Injectable()
    class Scheduled {
      @Every("1 hour", { name: "hourly" })
      hourly() {}
    }

    // Several rounds, each a fresh backend: the two adds race, and a loss shows as a
    // second pending occurrence. The clock is what would tell them apart, so each
    // replica's add reads its own moment.
    for (let round = 0; round < 10; round += 1) {
      const backend = await fileBackend();
      const instance = () =>
        moduleOf({
          imports: [BunJobsModule.forRoot({ ...backend, autoStart: false })],
          providers: [Scheduled],
        });
      const apps = await Promise.all([boot(instance()), boot(instance())]);
      await Promise.all(
        apps.map(async (app, index) => {
          await Bun.sleep(index);
          await app.get(BunJobsLifecycle, { strict: false }).start();
        }),
      );
      const jobs = apps[0]!.get<BunJobs>(BunJobs);
      expect(
        (await jobs.queue<unknown, unknown>("nest-schedule").count()).delayed,
      ).toBe(1);
      await Promise.all(apps.map((app) => app.close()));
    }
  }, 30_000);

  it("negative control: with the dedupe defeated by a key per instance, the test sees duplicates", async () => {
    const backend = await fileBackend();
    const run = occurrences(["one", "two"], 2);

    const scheduledAs = (name: string) => {
      @Injectable()
      class Scheduled {
        @Cron("* * * * * *", { name })
        cron(@CurrentJob() job: Job) {
          run.record(name, job.runAt);
        }
      }
      return Scheduled;
    };
    const [first, second] = await Promise.all(
      ["one", "two"].map((name) =>
        boot(
          moduleOf({
            imports: [BunJobsModule.forRoot(backend)],
            providers: [scheduledAs(name)],
          }),
        ),
      ),
    );
    await run.done;
    await Promise.all([first!.close(), second!.close()]);

    const all = [...run.seen.get("one")!, ...run.seen.get("two")!];
    expect(duplicates(all)).toBeGreaterThan(0);
  }, 30_000);
});

describe("the series", () => {
  it("is keyed by class and method, or by name, and a restart updates it", async () => {
    const jobs = borrowed();

    @Injectable()
    class Maintenance {
      @Cron("0 3 * * *", { tz: "Europe/London", name: "nightly" })
      named() {}

      @Every("5 minutes", { attempts: 4 })
      refresh() {}
    }

    const app = () =>
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs })],
        providers: [Maintenance],
      });

    await (await boot(app())).close();
    const queue = jobs.queue<unknown, unknown>("nest-schedule");
    const before = await queue.listRepeatables();
    expect(before.map(({ key }) => key).sort()).toEqual([
      "Maintenance.refresh",
      "nightly",
    ]);
    const refresh = before.find(({ key }) => key === "Maintenance.refresh")!;
    expect(refresh.every).toBe(300_000);
    expect(refresh.opts.attempts).toBe(4);
    expect(before.find(({ key }) => key === "nightly")?.tz).toBe(
      "Europe/London",
    );

    await (await boot(app())).close();
    const after = await queue.listRepeatables();
    expect(after.map(({ key }) => key).sort()).toEqual([
      "Maintenance.refresh",
      "nightly",
    ]);
    expect((await queue.count()).delayed).toBe(2);
    expect(
      after.find(({ key }) => key === "Maintenance.refresh")?.nextRunAt,
    ).toBe(refresh.nextRunAt);
  });

  it("keeps the module's scheduleQueue, its own queue, and a @Processor's worker", async () => {
    const jobs = borrowed();
    const made = spyOn(jobs, "worker");

    @Processor("mixed")
    class Mixed {
      @Process("work")
      work() {}

      @Cron("0 3 * * *", { queue: "mixed" })
      nightly() {}

      @Every("1 hour")
      hourly() {}
    }

    await bootForTest(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({ jobs, scheduleQueue: "my-schedule" }),
        ],
        providers: [Mixed],
      }),
    );

    expect(
      (await jobs.queue<unknown, unknown>("mixed").listRepeatables()).map(
        ({ key }) => key,
      ),
    ).toEqual(["Mixed.nightly"]);
    expect(
      (await jobs.queue<unknown, unknown>("my-schedule").listRepeatables()).map(
        ({ key }) => key,
      ),
    ).toEqual(["Mixed.hourly"]);
    // One worker per queue: the processor's, and the schedule queue's.
    expect(made).toHaveBeenCalledTimes(2);
  });

  it("a disabled series stays disabled across a restart, and an operator's off survives a deploy", async () => {
    const jobs = borrowed();

    @Injectable()
    class Maintenance {
      @Every("1 hour", { name: "hourly" })
      hourly() {}
    }

    const app = () =>
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs })],
        providers: [Maintenance],
      });

    await (await boot(app())).close();
    const queue = jobs.queue<unknown, unknown>("nest-schedule");
    expect(await queue.disableRepeatable("hourly")).toBe(true);

    await (await boot(app())).close();
    const [series] = await queue.listRepeatables();
    expect(series?.disabled).toBe(true);
    expect(series?.nextRunAt).toBeNull();
    expect((await queue.count()).delayed).toBe(0);
  });

  it("{ disabled: true } declares a series without adding it", async () => {
    const jobs = borrowed();

    @Injectable()
    class Maintenance {
      @Every("1 hour", { disabled: true })
      later() {}
    }

    await bootForTest(
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs })],
        providers: [Maintenance],
      }),
    );
    expect(
      await jobs.queue<unknown, unknown>("nest-schedule").listRepeatables(),
    ).toEqual([]);
  });

  it("a finished one-shot does not fail the next boot, and runs no more", async () => {
    const jobs = borrowed();
    let runs = 0;
    const ran = createDeferred<void>();

    @Injectable()
    class OneShot {
      @Every(50, { limit: 1, name: "once" })
      once() {
        runs += 1;
        ran.resolve();
      }
    }

    const app = () =>
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs })],
        providers: [OneShot],
      });

    const first = await boot(app());
    await ran.promise;
    await Bun.sleep(150);
    await first.close();
    expect(runs).toBe(1);

    const second = await boot(app());
    await Bun.sleep(150);
    await second.close();
    expect(runs).toBe(1);
  }, 30_000);

  it("immediately runs when the series is created, not at every restart", async () => {
    const jobs = borrowed();
    let runs = 0;
    const ran = createDeferred<void>();

    @Injectable()
    class Warm {
      @Every("1 hour", { immediately: true })
      warm() {
        runs += 1;
        ran.resolve();
      }
    }

    const app = () =>
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs })],
        providers: [Warm],
      });

    const first = await boot(app());
    await ran.promise;
    await first.close();
    expect(runs).toBe(1);

    const second = await boot(app());
    await Bun.sleep(100);
    await second.close();
    expect(runs).toBe(1);
  }, 30_000);

  it("autoStart: false adds nothing until BunJobsLifecycle.start()", async () => {
    const jobs = borrowed();

    @Injectable()
    class Maintenance {
      @Every("1 hour", { name: "hourly" })
      hourly() {}
    }

    const app = await bootForTest(
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs, autoStart: false })],
        providers: [Maintenance],
      }),
    );
    const queue = jobs.queue<unknown, unknown>("nest-schedule");
    expect(await queue.listRepeatables()).toEqual([]);

    await app.get(BunJobsLifecycle, { strict: false }).start();
    expect((await queue.listRepeatables()).map(({ key }) => key)).toEqual([
      "hourly",
    ]);
  });
});

describe("an occurrence", () => {
  it("runs through the pipeline, with parameter decorators, and a denial ends it at once", async () => {
    const jobs = borrowed();
    const asked = createDeferred<boolean>();
    let ran = false;

    @Injectable()
    class Deny implements CanActivate {
      canActivate() {
        asked.resolve(true);
        return false;
      }
    }

    @Injectable()
    class Maintenance {
      @Every(50, { name: "guarded", attempts: 3 })
      @UseGuards(Deny)
      guarded(@JobSignal() signal: AbortSignal) {
        ran = signal instanceof AbortSignal;
      }
    }

    const dead = createDeferred<number>();
    const app = await bootForTest(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({ jobs }),
          BunJobsModule.registerQueue({ name: "nest-schedule" }),
        ],
        providers: [Maintenance],
      }),
    );
    app
      .get<{ worker: BunQueueWorker<any, any, any> }>(
        getWorkerToken("nest-schedule"),
        { strict: false },
      )
      .worker.on("dead", (job: Job) => {
        dead.resolve(job.attemptsMade);
      });
    expect(await asked.promise).toBe(true);
    expect(await dead.promise).toBe(1);
    expect(ran).toBe(false);
  }, 30_000);

  it("the same method reads its parameters when a guard allows it", async () => {
    const seen = createDeferred<[string, boolean]>();

    @Injectable()
    class Maintenance {
      @Every(50, { name: "read" })
      read(@CurrentJob() job: Job, @JobSignal() signal: AbortSignal) {
        seen.resolve([job.name, signal instanceof AbortSignal]);
      }
    }

    await bootForTest(
      moduleOf({
        imports: [BunJobsModule.forRoot(contextOptions())],
        providers: [Maintenance],
      }),
    );
    expect(await seen.promise).toEqual(["read", true]);
  }, 30_000);

  it("of a series nobody declares any more goes dead here, saying so", async () => {
    const jobs = borrowed();
    const dead = createDeferred<Error>();

    @Injectable()
    class Maintenance {
      @Every("1 hour", { name: "kept" })
      kept() {}
    }

    const queue = jobs.queue<unknown, unknown>("nest-schedule");
    await queue.add("removed", {}, { repeat: { key: "removed", every: 50 } });

    await bootForTest(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({ jobs }),
          BunJobsModule.registerQueue({ name: "nest-schedule" }),
        ],
        providers: [Maintenance],
      }),
    ).then((app) => {
      app
        .get<{ worker: BunQueueWorker<any, any, any> }>(
          getWorkerToken("nest-schedule"),
          { strict: false },
        )
        .worker.on("dead", (_job: Job, error: Error) => {
          dead.resolve(error);
        });
    });
    expect((await dead.promise).message).toContain(
      'No @Process, @Cron or @Every handler for job or series "removed"',
    );
  }, 30_000);
});

describe("undeclared series", () => {
  /** A context holding one series no decorator declares, and one a person added. */
  async function withLeftovers() {
    const jobs = borrowed();
    const queue = jobs.queue<unknown, unknown>("nest-schedule");
    await queue.add("gone", {}, { repeat: { key: "gone", every: 3_600_000 } });
    await queue.add(
      "by-hand",
      {},
      { repeat: { key: "someone-elses", every: 3_600_000 } },
    );
    return { jobs, queue };
  }

  @Injectable()
  class Maintenance {
    @Every("1 hour", { name: "kept" })
    kept() {}
  }

  it("are warned about, once, naming them, and left where they are", async () => {
    const { jobs, queue } = await withLeftovers();
    const { logger, warnings } = warnSink();

    await bootForTest(
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs })],
        providers: [Maintenance],
      }),
      logger,
    );

    const lines = warnings.filter((line) =>
      line.includes("No @Cron or @Every in this process declares"),
    );
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("gone");
    // A series this module's decorators could not have added is not called undeclared.
    expect(lines[0]).not.toContain("someone-elses");
    expect(
      (await queue.listRepeatables()).map(({ key }) => key).sort(),
    ).toEqual(["gone", "kept", "someone-elses"]);
  });

  it("are removed with pruneSchedules, and only those", async () => {
    const { jobs, queue } = await withLeftovers();
    const { logger, warnings } = warnSink();

    await bootForTest(
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs, pruneSchedules: true })],
        providers: [Maintenance],
      }),
      logger,
    );

    expect(
      (await queue.listRepeatables()).map(({ key }) => key).sort(),
    ).toEqual(["kept", "someone-elses"]);
    expect(warnings.some((line) => line.includes("declares"))).toBe(false);
  });

  it("a process that schedules nothing does not look, and another service's series are safe", async () => {
    const { jobs, queue } = await withLeftovers();
    const { logger, warnings } = warnSink();
    const list = spyOn(queue, "listRepeatables");

    await bootForTest(
      moduleOf({ imports: [BunJobsModule.forRoot({ jobs })] }),
      logger,
    );

    expect(list).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("pruneSchedules with nothing declared empties the module's own queue, as asked", async () => {
    const { jobs, queue } = await withLeftovers();

    await bootForTest(
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs, pruneSchedules: true })],
      }),
    );

    expect((await queue.listRepeatables()).map(({ key }) => key)).toEqual([
      "someone-elses",
    ]);
  });
});

describe("the checks at bootstrap", () => {
  it("refuse a bad cron, an unknown zone and an interval nothing can read, naming the method, before writing anything", async () => {
    const jobs = borrowed();

    @Injectable()
    class Bad {
      @Cron("not a cron")
      badCron() {}

      @Cron("0 3 * * *", { tz: "Not/AZone" })
      badZone() {}

      @Every("whenever it feels right")
      badInterval() {}
    }

    const message = await bootProblem(
      moduleOf({
        imports: [BunJobsModule.forRoot({ jobs })],
        providers: [Bad],
      }),
    );
    expect(message).toContain('Bad.badCron: @Cron cannot read "not a cron"');
    expect(message).toContain("Bad.badZone");
    expect(message).toContain("Bad.badInterval");
    expect(
      await jobs.queue<unknown, unknown>("nest-schedule").listRepeatables(),
    ).toEqual([]);
  });

  it("refuse two series with one key, a schedule beside @Process, and a context nobody provides", async () => {
    @Injectable()
    class Twice {
      @Cron("0 3 * * *", { name: "same" })
      one() {}

      @Every("1 hour", { name: "same" })
      two() {}
    }

    @Processor("q")
    class Both {
      @Process("x")
      @Every("1 hour")
      x() {}
    }

    @Injectable()
    class Elsewhere {
      @Every("1 hour", { context: "nowhere" })
      x() {}
    }

    const message = await bootProblem(
      moduleOf({
        imports: [BunJobsModule.forRoot(contextOptions())],
        providers: [Twice, Both, Elsewhere],
      }),
    );
    expect(message).toContain('two handlers for series "same"');
    expect(message).toContain("Both.x: a schedule and @Process");
    expect(message).toContain(
      'Elsewhere.x: its schedule names context "nowhere"',
    );
  });
});

describe("registerRunner", () => {
  it("registers, starts and stops a runner, injectable by id and heard by @OnRunnerEvent", async () => {
    const jobs = borrowed();
    const finished = createDeferred<unknown>();

    @Injectable()
    class Ops {
      constructor(@InjectRunner("cleanup") readonly runner: BunRunner) {}

      @OnRunnerEvent("cleanup", "finished")
      done(_run: unknown, result: unknown) {
        finished.resolve(result);
      }
    }

    const app = await boot(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({ jobs }),
          BunJobsModule.registerRunner({
            id: "cleanup",
            file: RUNNER_FILE,
            executionMode: "in-process",
          }),
        ],
        providers: [Ops],
      }),
    );
    const { runner } = app.get(Ops);
    expect(jobs.runners.get("cleanup")).toBe(runner);
    expect(
      app.get<BunRunner>(getRunnerToken("cleanup"), { strict: false }),
    ).toBe(runner);
    const stop = spyOn(runner, "stop");

    await runner.trigger();
    expect(await finished.promise).toBe("swept");

    await app.close();
    expect(stop).toHaveBeenCalled();
    // The context is the application's, and stays open.
    expect(() => jobs.queue("still-open")).not.toThrow();
  }, 30_000);

  it("autoStart: false leaves it stopped until BunJobsLifecycle.start(), and stop() stops it", async () => {
    const jobs = borrowed();

    const app = await bootForTest(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({ jobs, autoStart: false }),
          BunJobsModule.registerRunner({
            id: "cleanup",
            file: RUNNER_FILE,
            executionMode: "in-process",
            schedule: "0 3 * * *",
          }),
        ],
      }),
    );
    const runner = jobs.runners.get("cleanup")!;
    const start = spyOn(runner, "start");
    const stop = spyOn(runner, "stop");
    expect(start).not.toHaveBeenCalled();

    const lifecycle = app.get(BunJobsLifecycle, { strict: false });
    await lifecycle.start();
    expect(start).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("a runner with no context it can see says so, and a named context keeps its own", async () => {
    expect(
      await bootProblem(
        moduleOf({
          imports: [
            BunJobsModule.registerRunner({
              id: "cleanup",
              file: RUNNER_FILE,
            }),
          ],
        }),
      ),
    ).toContain('runner "cleanup" is registered, but this module cannot see');

    @Injectable()
    class Ops {
      constructor(
        @InjectRunner("cleanup", "billing") readonly runner: BunRunner,
      ) {}
    }

    const app = await bootForTest(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({ ...contextOptions(), name: "billing" }),
          BunJobsModule.registerRunner({
            id: "cleanup",
            file: RUNNER_FILE,
            executionMode: "in-process",
            context: "billing",
          }),
        ],
        providers: [Ops],
      }),
    );
    expect(app.get(Ops).runner.id).toBe("cleanup");
  });
});
