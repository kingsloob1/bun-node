/**
 * When workers drain on `app.close()` (nest-jobs-decorators §6.3): the plan's
 * `lifecycle.ts` spike as a test. A job in flight uses a database whose service
 * closes it in `onModuleDestroy`; `app.close()` lands while the job runs.
 *
 * The two majors differ in one case, asserted per major, never skipped: Nest 12
 * runs a module's hooks in dependency order, so a resource in the processor's
 * own module outlives its worker; Nest 11 destroys the two at once.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type { Job } from "@kingsleyweb/bun-jobs";
import type {
  INestApplicationContext,
  OnModuleDestroy,
  Provider,
} from "@nestjs/common";
import { createRequire } from "node:module";
import { createDeferred } from "@kingsleyweb/bun-common";
import { BunJobs, JobsClosedError, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Global, Injectable, Module, Scope } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "bun:test";
import {
  BunJobsModule,
  DefineJob,
  getQueueToken,
  getWorkerToken,
  JobsHost,
  Process,
  Processor,
} from "../lib/jobs/index";
import "reflect-metadata";

/** Nest's major, as this test sees it: the repo's lock, or a matrix copy's. */
const NEST_MAJOR = Number(
  (
    createRequire(import.meta.url)("@nestjs/core/package.json") as {
      version: string;
    }
  ).version.split(".")[0],
);

/** The gates a scenario's classes reach. */
function harness() {
  return {
    started: createDeferred<void>(),
    closing: createDeferred<void>(),
  };
}

/**
 * A database class of the scenario's own, which closes in `onModuleDestroy`. A
 * class made by a function reads as `Object` to `emitDecoratorMetadata`, so each
 * scenario states its processor's `design:paramtypes` by hand.
 */
function databaseFor() {
  @Injectable()
  class Db implements OnModuleDestroy {
    open = true;

    query() {
      if (!this.open) {
        throw new Error("database is closed");
      }
      return "row";
    }

    onModuleDestroy() {
      this.open = false;
    }
  }
  return Db;
}

/**
 * The body of the job: marks it running, waits for `app.close()` to begin, gives
 * the close 100 ms to do whatever it will do, then uses the database.
 */
async function jobBody(
  h: ReturnType<typeof harness>,
  db: { query: () => string },
): Promise<string> {
  h.started.resolve();
  await h.closing.promise;
  await Bun.sleep(100);
  return db.query();
}

/** Runs one job through a close; how it ended. */
async function runThroughClose(
  h: ReturnType<typeof harness>,
  module: new () => unknown,
): Promise<string> {
  const app: INestApplicationContext =
    await NestFactory.createApplicationContext(module, { logger: false });
  const queue = app.get<{ add: (n: string, d: object) => Promise<Job> }>(
    getQueueToken("work"),
    { strict: false },
  );
  const worker = app.get<{
    worker: {
      on: (event: string, listener: (...args: any[]) => void) => unknown;
    };
  }>(getWorkerToken("work"), { strict: false }).worker;
  let outcome = "pending";
  worker.on("completed", () => {
    outcome = "completed";
  });
  worker.on("failed", (_job: Job, error: Error) => {
    outcome = `failed: ${error.message}`;
  });
  await queue.add("x", {});
  await h.started.promise;
  h.closing.resolve();
  await app.close();
  return outcome;
}

/** A jobs module and the queue's registration, in the app module's imports. */
function jobsImports() {
  return [
    BunJobsModule.forRoot({
      namespace: `nest-lifecycle-${crypto.randomUUID().slice(0, 8)}`,
      driver: new MemoryDriver(),
      // The default budget is 30 s; nothing here should come near it.
      shutdown: { timeout: 10_000 },
    }),
    BunJobsModule.registerQueue({ name: "work" }),
  ];
}

describe("the drain, per scenario", () => {
  it("E: a service in a module the feature imports outlives the job, on both majors", async () => {
    const h = harness();
    const Db = databaseFor();

    @Processor("work")
    class Work {
      constructor(readonly db: InstanceType<typeof Db>) {}

      @Process()
      run() {
        return jobBody(h, this.db);
      }
    }
    Reflect.defineMetadata("design:paramtypes", [Db], Work);

    @Module({ providers: [Db], exports: [Db] })
    class DbModule {}

    @Module({ imports: [DbModule], providers: [Work] })
    class Feature {}

    @Module({ imports: [...jobsImports(), Feature] })
    class AppModule {}

    expect(await runThroughClose(h, AppModule)).toBe("completed");
  }, 30_000);

  it("H: a service in a @Global module outlives the job, on both majors", async () => {
    const h = harness();
    const Db = databaseFor();

    @Processor("work")
    class Work {
      constructor(readonly db: InstanceType<typeof Db>) {}

      @Process()
      run() {
        return jobBody(h, this.db);
      }
    }
    Reflect.defineMetadata("design:paramtypes", [Db], Work);

    @Global()
    @Module({ providers: [Db], exports: [Db] })
    class GlobalDb {}

    @Module({ providers: [Work] })
    class Feature {}

    @Module({ imports: [...jobsImports(), GlobalDb, Feature] })
    class AppModule {}

    expect(await runThroughClose(h, AppModule)).toBe("completed");
  }, 30_000);

  it(`F: a service in the processor's own module ${NEST_MAJOR >= 12 ? "outlives the job on Nest 12" : "is destroyed under the job on Nest 11"}`, async () => {
    const h = harness();
    const Db = databaseFor();

    @Processor("work")
    class Work {
      constructor(readonly db: InstanceType<typeof Db>) {}

      @Process()
      run() {
        return jobBody(h, this.db);
      }
    }
    Reflect.defineMetadata("design:paramtypes", [Db], Work);

    @Module({ providers: [Db, Work] })
    class Feature {}

    @Module({ imports: [...jobsImports(), Feature] })
    class AppModule {}

    expect(await runThroughClose(h, AppModule)).toBe(
      NEST_MAJOR >= 12 ? "completed" : "failed: database is closed",
    );
  }, 30_000);

  it("negative control: scenario E with only the module's fallback drain fails, as measured", async () => {
    const h = harness();
    const Db = databaseFor();

    // A JobsHost overriding `onModuleDestroy` without `super` has no drain of
    // its own, so its worker drains last, in the global jobs module.
    @Processor("work")
    class Work extends JobsHost {
      constructor(readonly db: InstanceType<typeof Db>) {
        super();
      }

      process() {
        return jobBody(h, this.db);
      }

      override async onModuleDestroy() {}
    }
    Reflect.defineMetadata("design:paramtypes", [Db], Work);

    @Module({ providers: [Db], exports: [Db] })
    class DbModule {}

    @Module({ imports: [DbModule], providers: [Work] })
    class Feature {}

    @Module({ imports: [...jobsImports(), Feature] })
    class AppModule {}

    expect(await runThroughClose(h, AppModule)).toBe(
      "failed: database is closed",
    );
  }, 30_000);

  it("JobsHost's own onModuleDestroy is the drain: scenario E completes", async () => {
    const h = harness();
    const Db = databaseFor();

    @Processor("work")
    class Work extends JobsHost {
      constructor(readonly db: InstanceType<typeof Db>) {
        super();
      }

      process() {
        return jobBody(h, this.db);
      }
    }
    Reflect.defineMetadata("design:paramtypes", [Db], Work);

    @Module({ providers: [Db], exports: [Db] })
    class DbModule {}

    @Module({ imports: [DbModule], providers: [Work] })
    class Feature {}

    @Module({ imports: [...jobsImports(), Feature] })
    class AppModule {}

    expect(await runThroughClose(h, AppModule)).toBe("completed");
  }, 30_000);

  it("a @DefineJob provider's job finishes before what it imports goes", async () => {
    const h = harness();
    const Db = databaseFor();
    let result: unknown;

    @Injectable()
    class Defined {
      constructor(readonly db: InstanceType<typeof Db>) {}

      @DefineJob("defined")
      async run() {
        result = await jobBody(h, this.db);
      }
    }
    Reflect.defineMetadata("design:paramtypes", [Db], Defined);

    @Module({ providers: [Db], exports: [Db] })
    class DbModule {}

    @Module({ imports: [DbModule], providers: [Defined] })
    class Feature {}

    const jobs = new BunJobs({
      namespace: `nest-lifecycle-${crypto.randomUUID().slice(0, 8)}`,
      driver: new MemoryDriver(),
    });
    @Module({ imports: [BunJobsModule.forRoot({ jobs }), Feature] })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    await jobs.now("defined", {});
    await h.started.promise;
    h.closing.resolve();
    await app.close();
    expect(result).toBe("row");
    await jobs.close();
  }, 30_000);
});

describe("the hook", () => {
  it("the class's own onModuleDestroy still runs, once, after its worker has closed", async () => {
    const calls: string[] = [];

    @Processor("work")
    class Work {
      @Process()
      run() {}

      onModuleDestroy() {
        calls.push("own");
      }
    }

    @Module({ imports: [...jobsImports()], providers: [Work] })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const worker = app.get<{ worker: { isRunning: boolean } }>(
      getWorkerToken("work"),
      { strict: false },
    ).worker;
    const instance = app.get(Work);
    // Non-enumerable, so nothing that walks the instance trips on it.
    expect(Object.keys(instance)).not.toContain("onModuleDestroy");
    expect(worker.isRunning).toBe(true);
    await app.close();
    expect(calls).toEqual(["own"]);
    expect(worker.isRunning).toBe(false);
  });

  it("two classes on one queue: the first to be destroyed closes the worker, and both hooks run", async () => {
    const calls: string[] = [];

    @Processor("work")
    class One {
      @Process("one")
      one() {}

      onModuleDestroy() {
        calls.push("one");
      }
    }

    @Processor("work")
    class Two {
      @Process("two")
      two() {}

      onModuleDestroy() {
        calls.push("two");
      }
    }

    @Module({ providers: [One] })
    class FeatureOne {}
    @Module({ providers: [Two] })
    class FeatureTwo {}

    @Module({ imports: [...jobsImports(), FeatureOne, FeatureTwo] })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    await app.close();
    expect(calls.sort()).toEqual(["one", "two"]);
  });

  it("a request-scoped processor's job finishes through the fallback drain", async () => {
    const h = harness();
    let finished = false;

    @Processor("work", { scope: Scope.REQUEST })
    class Scoped {
      @Process()
      async run() {
        h.started.resolve();
        await h.closing.promise;
        await Bun.sleep(100);
        finished = true;
      }
    }

    // Borrowed, so no context close comes after to hide a missing drain.
    const jobs = new BunJobs({
      namespace: `nest-lifecycle-${crypto.randomUUID().slice(0, 8)}`,
      driver: new MemoryDriver(),
    });

    @Module({
      imports: [
        BunJobsModule.forRoot({ jobs }),
        BunJobsModule.registerQueue({ name: "work" }),
      ],
      providers: [Scoped],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const queue = app.get<{ add: (n: string, d: object) => Promise<Job> }>(
      getQueueToken("work"),
      { strict: false },
    );
    const worker = app.get<{ worker: { isRunning: boolean } }>(
      getWorkerToken("work"),
      { strict: false },
    ).worker;
    await queue.add("x", {});
    await h.started.promise;
    h.closing.resolve();
    await app.close();
    expect(finished).toBe(true);
    expect(worker.isRunning).toBe(false);
    await jobs.close();
  }, 30_000);
});

describe("the budget, and the context afterwards", () => {
  /** Boots a processor whose job waits for its signal. */
  async function waiting(shutdown: { timeout?: number; force?: boolean }) {
    const started = createDeferred<void>();
    let aborted = false;

    @Processor("work")
    class Work {
      @Process()
      async run(_job: Job, ctx: { signal: AbortSignal }) {
        started.resolve();
        await new Promise((resolve) => {
          ctx.signal.addEventListener("abort", resolve);
        });
        aborted = true;
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({
          namespace: `nest-lifecycle-${crypto.randomUUID().slice(0, 8)}`,
          driver: new MemoryDriver(),
          shutdown,
        }),
        BunJobsModule.registerQueue({ name: "work" }),
      ],
      providers: [Work],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    await app
      .get<{ add: (n: string, d: object) => Promise<Job> }>(
        getQueueToken("work"),
        { strict: false },
      )
      .add("x", {});
    await started.promise;
    return { app, wasAborted: () => aborted };
  }

  it("shutdown.timeout aborts a job still running when it lapses", async () => {
    const { app, wasAborted } = await waiting({ timeout: 50 });
    await app.close();
    expect(wasAborted()).toBe(true);
  }, 30_000);

  it("shutdown.force aborts at once", async () => {
    const { app, wasAborted } = await waiting({ force: true });
    await app.close();
    expect(wasAborted()).toBe(true);
  }, 30_000);

  it("a built context refuses a late queue or worker once closed", async () => {
    @Module({ imports: [...jobsImports()] })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const jobs = app.get<BunJobs>(BunJobs);
    await app.close();
    expect(() => jobs.queue("late")).toThrow(JobsClosedError);
    expect(() => jobs.worker("late", () => {})).toThrow(JobsClosedError);
  });

  it("a borrowed context stays open, with the module's workers closed", async () => {
    const jobs = new BunJobs({
      namespace: `nest-lifecycle-${crypto.randomUUID().slice(0, 8)}`,
      driver: new MemoryDriver(),
    });

    @Processor("work")
    class Work {
      @Process()
      run() {}
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ jobs }),
        BunJobsModule.registerQueue({ name: "work" }),
      ],
      providers: [Work] as Provider[],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const worker = app.get<{ worker: { isRunning: boolean } }>(
      getWorkerToken("work"),
      { strict: false },
    ).worker;
    expect(worker.isRunning).toBe(true);
    await app.close();

    expect(worker.isRunning).toBe(false);
    await jobs.queue("work").add("still-open", {});
    expect((await jobs.queue("work").count()).waiting).toBe(1);
    await jobs.close();
  });
});
