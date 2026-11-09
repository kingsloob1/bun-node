/**
 * The event decorators (nest-jobs-decorators PR-n4): `@OnWorkerEvent`,
 * `@OnQueueEvent`, `@OnJobsEvent`, `@OnRunnerEvent` and `@InjectJobsNotifier`, under a
 * real Nest application on a real bun-jobs driver.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type {
  BunQueue,
  BunQueueWorker,
  Job,
  JobsNotifier,
} from "@kingsleyweb/bun-jobs";
import type {
  INestApplicationContext,
  LoggerService,
  Type,
} from "@nestjs/common";
import type { JobsEventOf } from "../lib/jobs/index";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigError, createDeferred } from "@kingsleyweb/bun-common";
import { BunJobs, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Controller, Injectable, Logger, Module, Scope } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  BunJobsModule,
  getQueueToken,
  getWorkerToken,
  InjectJobsNotifier,
  OnJobsEvent,
  OnQueueEvent,
  OnRunnerEvent,
  OnWorkerEvent,
  Process,
  Processor,
} from "../lib/jobs/index";
import "reflect-metadata";

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
    namespace: `nest-events-${crypto.randomUUID().slice(0, 8)}`,
    driver: { type: "memory" as const },
  };
}

/** A context borrowed from the test, closed afterwards. */
function borrowed(publishEvents = true): BunJobs {
  const jobs = new BunJobs({
    namespace: `nest-events-${crypto.randomUUID().slice(0, 8)}`,
    driver: new MemoryDriver(),
    publishEvents,
  });
  cleanups.push(() => jobs.close());
  return jobs;
}

/** Boots an application context; a failure rejects rather than aborting. */
async function boot(
  module: Type<unknown>,
  logger: LoggerService | false = false,
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(module, {
    logger,
    abortOnError: false,
  });
  cleanups.push(() => app.close());
  return app;
}

/** The message of the `ConfigError` a failing boot gives. */
async function bootProblem(module: Type<unknown>): Promise<string> {
  let caught: unknown;
  let app: INestApplicationContext | undefined;
  try {
    app = await NestFactory.createApplicationContext(module, {
      logger: false,
      abortOnError: false,
    });
  } catch (error) {
    caught = error;
  }
  await app?.close();
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).message;
}

/** The app's queue and the worker serving it. */
function queueOf(app: INestApplicationContext, name = "q") {
  return {
    queue: app.get<BunQueue<any, any, any>>(getQueueToken(name), {
      strict: false,
    }),
    worker: app.get<{ worker: BunQueueWorker<any, any, any> }>(
      getWorkerToken(name),
      { strict: false },
    ).worker,
  };
}

/** A logger that keeps its lines, restored afterwards. */
function logSink() {
  const errors: string[] = [];
  const warnings: string[] = [];
  const logger: LoggerService = {
    log: () => {},
    warn: (message: unknown) => {
      warnings.push(String(message));
    },
    error: (message: unknown) => {
      errors.push(String(message));
    },
  };
  cleanups.push(() => Logger.overrideLogger(false));
  return { logger, errors, warnings };
}

/** Resolves once the job settles on the worker. */
function settled(worker: BunQueueWorker<any, any, any>, id: string) {
  const done = createDeferred<void>();
  const finish = (job: Job) => {
    if (job.id === id) {
      done.resolve();
    }
  };
  worker.on("completed", finish);
  worker.on("dead", finish);
  return done.promise;
}

describe("@OnWorkerEvent", () => {
  it("hears the class's own worker, with the event's arguments, and classes on one queue share it", async () => {
    const heard: unknown[][] = [];

    @Processor("q")
    class One {
      @Process("one")
      one() {
        return "one's result";
      }

      @Process("bad")
      bad() {
        throw new Error("boom");
      }

      @OnWorkerEvent("completed")
      completed(job: Job, result: unknown) {
        heard.push(["One completed", job.name, result]);
      }

      @OnWorkerEvent("dead")
      dead(job: Job, error: Error) {
        heard.push(["One dead", job.name, error.message]);
      }
    }

    @Processor("q")
    class Two {
      @Process("two")
      two() {
        return "two's result";
      }

      @OnWorkerEvent("completed")
      completed(job: Job) {
        heard.push(["Two completed", job.name]);
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      providers: [One, Two],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, worker } = queueOf(app);
    const one = await queue.add("one", {});
    await settled(worker, one.id);
    const bad = await queue.add("bad", {});
    await settled(worker, bad.id);

    expect(heard).toContainEqual(["One completed", "one", "one's result"]);
    expect(heard).toContainEqual(["Two completed", "one"]);
    expect(heard).toContainEqual(["One dead", "bad", "boom"]);
  });

  it("is attached before the worker runs, so `ready` is heard", async () => {
    const ready = createDeferred<void>();

    @Processor("q")
    class Worker {
      @Process()
      run() {}

      @OnWorkerEvent("ready")
      isReady() {
        ready.resolve();
      }
    }

    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [Worker],
    })
    class AppModule {}

    await boot(AppModule);
    await ready.promise;
  });

  it("the scoped form hears only that job's name", async () => {
    const heard: string[] = [];

    @Processor("q")
    class Worker {
      @Process()
      run() {}

      @OnWorkerEvent("completed:welcome")
      welcome(job: Job) {
        heard.push(job.name);
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      providers: [Worker],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, worker } = queueOf(app);
    const other = await queue.add("digest", {});
    await settled(worker, other.id);
    const welcome = await queue.add("welcome", {});
    await settled(worker, welcome.id);
    expect(heard).toEqual(["welcome"]);
  });
});

describe("a listener's errors", () => {
  it("are logged with the class and method, whether thrown or rejected, and affect no job", async () => {
    const { logger, errors } = logSink();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => process.off("unhandledRejection", onUnhandled));
    const rejected = createDeferred<void>();
    let ran = false;

    @Processor("q")
    class Worker {
      @Process()
      run() {
        return "done";
      }

      @OnWorkerEvent("completed")
      thrown() {
        throw new Error("thrown in a listener");
      }

      @OnWorkerEvent("completed")
      async rejects() {
        await Bun.sleep(0);
        queueMicrotask(() => rejected.resolve());
        throw new Error("rejected in a listener");
      }

      @OnWorkerEvent("completed")
      stillRuns() {
        ran = true;
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      providers: [Worker],
    })
    class AppModule {}

    const app = await boot(AppModule, logger);
    const { queue, worker } = queueOf(app);
    const job = await queue.add("x", {});
    await settled(worker, job.id);
    await rejected.promise;
    await Bun.sleep(5);

    expect(errors.join("\n")).toContain(
      "Worker.thrown: an event listener failed: thrown in a listener",
    );
    expect(errors.join("\n")).toContain(
      "Worker.rejects: an event listener failed: rejected in a listener",
    );
    expect(ran).toBe(true);
    expect(unhandled).toEqual([]);
    expect((await queue.getJob(job.id))?.state).toBe("completed");
  });
});

describe("@OnQueueEvent", () => {
  it("hears a queue's emitter from any provider, in its scoped form too", async () => {
    const heard: string[] = [];

    @Injectable()
    class Audit {
      @OnQueueEvent("q", "added")
      added(job: Job) {
        heard.push(`added ${job.name}`);
      }

      @OnQueueEvent("q", "added:welcome")
      welcome(job: Job) {
        heard.push(`welcome ${job.name}`);
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      providers: [Audit],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const queue = app.get<BunQueue<any, any, any>>(getQueueToken("q"), {
      strict: false,
    });
    await queue.add("digest", {});
    await queue.add("welcome", {});
    expect(heard).toEqual(["added digest", "added welcome", "welcome welcome"]);
  });

  it("a queue registered with subscribe hears another process's published events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-nest-events-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const namespace = `nest-events-${crypto.randomUUID().slice(0, 8)}`;
    const driver = { type: "file" as const, root: dir };
    const heard = createDeferred<string>();

    @Injectable()
    class Audit {
      @OnQueueEvent("emails", "added")
      added(job: Job) {
        heard.resolve(job.id);
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ namespace, driver }),
        BunJobsModule.registerQueue({
          name: "emails",
          options: { subscribe: true },
        }),
      ],
      providers: [Audit],
    })
    class AppModule {}

    await boot(AppModule);
    const child = Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/fixtures/jobs-decorators/publisher.ts`,
        dir,
        namespace,
        "publish",
        "from-elsewhere",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    expect(await child.exited).toBe(0);
    expect(await heard.promise).toBe("from-elsewhere");
  }, 30_000);
});

describe("@OnJobsEvent", () => {
  it("hears another process's published events, and only those, on the file driver", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-nest-events-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const namespace = `nest-events-${crypto.randomUUID().slice(0, 8)}`;
    const heard: string[] = [];
    const published = createDeferred<void>();
    const { logger, warnings } = logSink();

    @Injectable()
    class Audit {
      @OnJobsEvent({ kind: "queue", type: "added", target: "emails" })
      added(event: JobsEventOf<"queue", "added">) {
        heard.push(event.payload.id);
        if (event.payload.id === "published") {
          published.resolve();
        }
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({
          namespace,
          driver: { type: "file", root: dir },
        }),
      ],
      providers: [Audit],
    })
    class AppModule {}

    await boot(AppModule, logger);

    // This process publishes nothing itself, and the module says so, once.
    expect(
      warnings.filter((line) => line.includes("publishEvents is off")).length,
    ).toBe(1);

    const run = async (publish: string, id: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          `${import.meta.dir}/fixtures/jobs-decorators/publisher.ts`,
          dir,
          namespace,
          publish,
          id,
        ],
        { stdout: "inherit", stderr: "inherit" },
      );
      expect(await child.exited).toBe(0);
    };
    // The negative control: nothing is heard that was never published. The second
    // job's event arrives after the first's would have.
    await run("silent", "silent");
    await run("publish", "published");
    await published.promise;
    expect(heard).toEqual(["published"]);
  }, 30_000);

  it("opens a notifier only when one exists, following the union of what they name", async () => {
    const without = borrowed();
    const noNotifier = spyOn(without, "notifier");

    @Module({ imports: [BunJobsModule.forRoot({ jobs: without })] })
    class Plain {}
    await boot(Plain);
    expect(noNotifier).not.toHaveBeenCalled();

    const jobs = borrowed();
    const notifier = spyOn(jobs, "notifier");

    @Injectable()
    class Audit {
      @OnJobsEvent({ kind: "queue", target: "emails" })
      emails() {}

      @OnJobsEvent({ kind: "queue", target: "images", type: "added" })
      images() {}

      @OnJobsEvent({ kind: "worker", target: "emails", type: "state" })
      workers() {}
    }

    @Module({
      imports: [BunJobsModule.forRoot({ jobs })],
      providers: [Audit],
    })
    class AppModule {}

    await boot(AppModule);
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith({
      queues: ["emails", "images"],
      runners: [],
      workers: ["emails"],
    });
  });

  it("a bare @OnJobsEvent follows every queue and runner, and no worker", async () => {
    const jobs = borrowed();
    const notifier = spyOn(jobs, "notifier");

    @Injectable()
    class Audit {
      @OnJobsEvent()
      everything() {}
    }

    @Module({
      imports: [BunJobsModule.forRoot({ jobs })],
      providers: [Audit],
    })
    class AppModule {}

    await boot(AppModule);
    expect(notifier).toHaveBeenCalledWith({
      queues: "all",
      runners: "all",
      workers: [],
    });
  });

  it("filters by kind, type and target, and hears this process's own worker", async () => {
    const heard: string[] = [];
    const jobs = borrowed();

    @Injectable()
    class Audit {
      @OnJobsEvent({ kind: "queue", type: "completed", target: "q" })
      completed(event: JobsEventOf<"queue", "completed">) {
        heard.push(`completed ${event.target}`);
      }

      @OnJobsEvent({ kind: "queue", type: "completed", target: "other" })
      other() {
        heard.push("other");
      }

      @OnJobsEvent({ kind: "queue", type: "added", target: "q" })
      added() {
        heard.push("added");
      }
    }

    @Processor("q")
    class Worker {
      @Process()
      run() {}
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ jobs }),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      providers: [Audit, Worker],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue } = queueOf(app);
    const done = createDeferred<void>();
    const notifier = await jobs.notifier({ queues: ["q"], runners: [] });
    notifier.on("event", (event) => {
      if (event.type === "completed") {
        done.resolve();
      }
    });
    await queue.add("x", {});
    await done.promise;
    await Bun.sleep(5);
    expect(heard).toContain("added");
    expect(heard).toContain("completed q");
    expect(heard).not.toContain("other");
  });

  it("names no reminder for a borrowed context, and closes its notifier on app.close()", async () => {
    const { logger, warnings } = logSink();
    const jobs = borrowed(false);
    let opened: JobsNotifier | undefined;
    const notifier = jobs.notifier.bind(jobs);
    spyOn(jobs, "notifier").mockImplementation(async (options) => {
      opened = await notifier(options);
      return opened;
    });

    @Injectable()
    class Audit {
      @OnJobsEvent({ kind: "queue", target: "q" })
      any() {}
    }

    @Module({
      imports: [BunJobsModule.forRoot({ jobs })],
      providers: [Audit],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger,
      abortOnError: false,
    });
    expect(warnings.some((line) => line.includes("publishEvents"))).toBe(false);
    const close = spyOn(opened as JobsNotifier, "close");
    await app.close();
    expect(close).toHaveBeenCalled();
    // The context is the application's, and stays open.
    expect(() => jobs.queue("still-open")).not.toThrow();
  });
});

describe("@OnRunnerEvent", () => {
  it("hears a runner that exists by bootstrap, and a missing one fails the boot", async () => {
    @Injectable()
    class Missing {
      @OnRunnerEvent("nope", "failed")
      failed() {}
    }

    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [Missing],
    })
    class NoRunner {}
    expect(await bootProblem(NoRunner)).toContain(
      'Missing.failed: @OnRunnerEvent names runner "nope", which does not exist by bootstrap',
    );

    const heard = createDeferred<string>();

    @Injectable()
    class Listens {
      @OnRunnerEvent("cleanup", "finished")
      finished(_run: unknown, result: unknown) {
        heard.resolve(String(result));
      }
    }

    const jobs = borrowed();
    const runner = jobs.runner({
      id: "cleanup",
      file: `${import.meta.dir}/fixtures/jobs-decorators/runner.ts`,
      executionMode: "in-process",
    });

    @Module({
      imports: [BunJobsModule.forRoot({ jobs })],
      providers: [Listens],
    })
    class AppModule {}

    await boot(AppModule);
    await runner.trigger();
    expect(await heard.promise).toBe("swept");
  }, 30_000);
});

describe("@InjectJobsNotifier", () => {
  it("injects an open notifier when a class asks for one, and hears from it", async () => {
    const jobs = borrowed();

    @Injectable()
    class Stream {
      constructor(@InjectJobsNotifier() readonly notifier: JobsNotifier) {}
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ jobs }),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      providers: [Stream],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    const { notifier } = app.get(Stream);
    const heard = createDeferred<string>();
    notifier.on("event", (event) => {
      if (event.kind === "queue" && event.type === "added") {
        heard.resolve(event.payload.id);
      }
    });
    const job = await app
      .get<BunQueue<any, any, any>>(getQueueToken("q"), { strict: false })
      .add("x", {});
    expect(await heard.promise).toBe(job.id);

    const close = spyOn(notifier, "close");
    await app.close();
    expect(close).toHaveBeenCalled();
    expect(() => jobs.queue("still-open")).not.toThrow();
  });

  it("opens nothing when nothing asks for it, and a property injection counts", async () => {
    const jobs = borrowed();
    const notifier = spyOn(jobs, "notifier");

    @Module({ imports: [BunJobsModule.forRoot({ jobs })] })
    class Plain {}
    await boot(Plain);
    expect(notifier).not.toHaveBeenCalled();

    const other = borrowed();
    const opened = spyOn(other, "notifier");

    @Injectable()
    class ByProperty {
      @InjectJobsNotifier()
      readonly notifier!: JobsNotifier;
    }

    @Module({
      imports: [BunJobsModule.forRoot({ jobs: other })],
      providers: [ByProperty],
    })
    class AppModule {}

    const app = await boot(AppModule);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(app.get(ByProperty).notifier.namespace).toBe(other.namespace);
  });
});

describe("the checks at bootstrap", () => {
  it("refuses a listener on a request-scoped class, naming the class and the method", async () => {
    @Processor("q", { scope: Scope.REQUEST })
    class Scoped {
      @Process()
      run() {}

      @OnWorkerEvent("completed")
      completed() {}
    }

    @Injectable({ scope: Scope.REQUEST })
    class ScopedAudit {
      @OnQueueEvent("q", "added")
      added() {}
    }

    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [Scoped, ScopedAudit],
    })
    class AppModule {}

    const message = await bootProblem(AppModule);
    expect(message).toContain(
      "Scoped.completed: an event listener needs one instance",
    );
    expect(message).toContain(
      "ScopedAudit.added: an event listener needs one instance",
    );
  });

  it("refuses @OnWorkerEvent with no @Processor, on a controller, and for a context nobody provides", async () => {
    @Injectable()
    class NoProcessor {
      @OnWorkerEvent("completed")
      completed() {}
    }

    @Controller()
    class Listening {
      @OnQueueEvent("q", "added")
      added() {}
    }

    @Injectable()
    class Elsewhere {
      @OnQueueEvent("q", "added", { context: "nowhere" })
      added() {}
    }

    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      controllers: [Listening],
      providers: [NoProcessor, Elsewhere],
    })
    class AppModule {}

    const message = await bootProblem(AppModule);
    expect(message).toContain("NoProcessor.completed: @OnWorkerEvent listens");
    expect(message).toContain(
      "Listening: a controller cannot consume jobs or listen",
    );
    expect(message).toContain(
      'Elsewhere.added: its event decorator names context "nowhere"',
    );
  });

  it("a method can carry several, and a named context hears its own", async () => {
    const heard: string[] = [];

    @Injectable()
    class Audit {
      @OnQueueEvent("q", "added")
      @OnQueueEvent("q", "added", { context: "billing" })
      added(job: Job) {
        heard.push(job.name);
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.forRoot({ ...contextOptions(), name: "billing" }),
        BunJobsModule.registerQueue(
          { name: "q" },
          { name: "q", context: "billing" },
        ),
      ],
      providers: [Audit],
    })
    class AppModule {}

    const app = await boot(AppModule);
    await app
      .get<BunQueue<any, any, any>>(getQueueToken("q"), { strict: false })
      .add("default", {});
    await app
      .get<BunQueue<any, any, any>>(getQueueToken("q", "billing"), {
        strict: false,
      })
      .add("billed", {});
    expect(heard).toEqual(["default", "billed"]);
  });
});
