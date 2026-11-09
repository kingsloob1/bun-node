/**
 * `@Processor`, `@Process`, `@DefineJob`, `registerWorker`, `@InjectWorker`,
 * `JobsHost`, `autoStart` and request scope (nest-jobs-decorators PR-n2), under
 * a real Nest application on a real bun-jobs driver. The lifecycle matrix is in
 * `jobsLifecycle.nest.test.ts`.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type {
  BunQueue,
  BunQueueWorker,
  Job,
  ProcessorContext,
} from "@kingsleyweb/bun-jobs";
import type { INestApplicationContext, Type } from "@nestjs/common";
import type { ContextIdStrategy, HostComponentInfo } from "@nestjs/core";
import process from "node:process";
import { ConfigError, createDeferred } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueue as BunQueueClass,
  ConfigError as JobsConfigError,
  MemoryDriver,
  UnrecoverableJobError,
} from "@kingsleyweb/bun-jobs";
import { Controller, Inject, Injectable, Module, Scope } from "@nestjs/common";
import { ContextIdFactory, NestFactory, REQUEST } from "@nestjs/core";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  BunJobsLifecycle,
  BunJobsModule,
  DefineJob,
  getBunJobsToken,
  getQueueToken,
  getWorkerToken,
  InjectWorker,
  isBunJob,
  JobsHost,
  Process,
  Processor,
  QueueToken,
  WorkerRef,
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
    namespace: `nest-consumers-${crypto.randomUUID().slice(0, 8)}`,
    driver: { type: "memory" as const },
  };
}

/** A borrowed context, closed after the test. */
function borrowed(): BunJobs {
  const jobs = new BunJobs({
    namespace: `nest-consumers-${crypto.randomUUID().slice(0, 8)}`,
    driver: new MemoryDriver(),
  });
  cleanups.push(() => jobs.close());
  return jobs;
}

/** Boots an application context; a failure rejects rather than aborting. */
async function boot(module: Type<unknown>): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(module, {
    logger: false,
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

/** A module class with the given metadata, by name. */
function moduleNamed(name: string, metadata: Parameters<typeof Module>[0]) {
  const made = { [name]: class {} }[name]!;
  Module(metadata)(made);
  return made;
}

/** The app's queue and the handle on its worker. */
function queueOf(app: INestApplicationContext, name: string, context?: string) {
  return {
    queue: app.get<BunQueue<any, any, any>>(getQueueToken(name, context), {
      strict: false,
    }),
    ref: app.get<WorkerRef<any, any>>(getWorkerToken(name, context), {
      strict: false,
    }),
  };
}

/** How one job ended, from its worker's events. */
interface Outcome {
  state: "completed" | "dead";
  result?: unknown;
  error?: Error;
  attemptsMade: number;
}

/** Waits for jobs by id, from the moment it is called. */
function watch(worker: BunQueueWorker<any, any, any>) {
  const waiting = new Map<string, ReturnType<typeof createDeferred<Outcome>>>();
  const of = (id: string) => {
    let entry = waiting.get(id);
    if (entry === undefined) {
      entry = createDeferred<Outcome>();
      waiting.set(id, entry);
    }
    return entry;
  };
  worker.on("completed", (job: Job, result: unknown) => {
    of(job.id).resolve({
      state: "completed",
      result,
      attemptsMade: job.attemptsMade,
    });
  });
  worker.on("dead", (job: Job, error: Error) => {
    of(job.id).resolve({
      state: "dead",
      error,
      attemptsMade: job.attemptsMade,
    });
  });
  return (id: string) => of(id).promise;
}

describe("@Processor and @Process", () => {
  it("dispatches by name to the methods of one worker, with (job, ctx) and the catch-all", async () => {
    const jobs = borrowed();
    const worker = spyOn(jobs, "worker");

    @Injectable()
    class Greeter {
      greet(to: string) {
        return `hello ${to}`;
      }
    }

    @Processor("emails", { concurrency: 2 })
    class EmailService {
      constructor(readonly greeter: Greeter) {}

      /** An ordinary method: a service can be a processor too. */
      plain() {
        return "plain";
      }

      @Process("welcome")
      welcome(job: Job<{ to: string }>, ctx: ProcessorContext) {
        return {
          text: this.greeter.greet(job.data.to),
          attempt: ctx.attempt,
          signal: ctx.signal instanceof AbortSignal,
        };
      }

      @Process("digest")
      digest() {
        return "digest";
      }

      @Process()
      other(job: Job) {
        return `other:${job.name}`;
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ jobs }),
        BunJobsModule.registerQueue({ name: "emails" }),
      ],
      providers: [Greeter, EmailService],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "emails");
    const settled = watch(ref.worker);

    const [welcome, digest, other] = await Promise.all([
      queue.add("welcome", { to: "ada" }),
      queue.add("digest", {}),
      queue.add("anything", {}),
    ]);

    expect((await settled(welcome.id)).result).toEqual({
      text: "hello ada",
      attempt: 1,
      signal: true,
    });
    expect((await settled(digest.id)).result).toBe("digest");
    expect((await settled(other.id)).result).toBe("other:anything");
    expect(worker).toHaveBeenCalledTimes(1);
    expect(app.get(EmailService).plain()).toBe("plain");
  });

  it("two classes on one queue share one worker, with a merged handler map", async () => {
    const jobs = borrowed();
    const worker = spyOn(jobs, "worker");

    @Processor("q", { concurrency: 3 })
    class One {
      @Process("one")
      one() {
        return "from One";
      }
    }

    @Processor("q", { concurrency: 3 })
    class Two {
      @Process("two")
      two() {
        return "from Two";
      }
    }

    const FeatureOne = moduleNamed("FeatureOne", { providers: [One] });
    const FeatureTwo = moduleNamed("FeatureTwo", { providers: [Two] });

    @Module({
      imports: [
        BunJobsModule.forRoot({ jobs }),
        BunJobsModule.registerQueue({ name: "q" }),
        FeatureOne,
        FeatureTwo,
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "q");
    const settled = watch(ref.worker);
    const one = await queue.add("one", {});
    const two = await queue.add("two", {});

    expect((await settled(one.id)).result).toBe("from One");
    expect((await settled(two.id)).result).toBe("from Two");
    expect(worker).toHaveBeenCalledTimes(1);
    expect(ref.worker.concurrency).toBe(3);
  });

  it("a queue token class names the queue and the context", async () => {
    @QueueToken("billed", "billing")
    abstract class BilledQueue extends BunQueueClass<{ id: number }, string> {}

    @Processor(BilledQueue)
    class Billed {
      @Process()
      run(job: Job<{ id: number }>) {
        return `id:${job.data.id}`;
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ ...contextOptions(), name: "billing" }),
        BunJobsModule.registerQueue(BilledQueue),
      ],
      providers: [Billed],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "billed", "billing");
    const settled = watch(ref.worker);
    const job = await queue.add("x", { id: 7 });
    expect((await settled(job.id)).result).toBe("id:7");
    expect(app.get<BunJobs>(getBunJobsToken("billing")).namespace).toBe(
      queue.namespace,
    );
  });

  it("a provider made by useFactory or useValue is found", async () => {
    @Processor("made")
    class Made {
      constructor(readonly tag: string) {}

      @Process()
      run() {
        return this.tag;
      }
    }

    @Processor("valued")
    class Valued {
      @Process()
      run() {
        return "value";
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "made" }, { name: "valued" }),
      ],
      providers: [
        { provide: "MADE", useFactory: () => new Made("factory") },
        { provide: "VALUED", useValue: new Valued() },
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const made = queueOf(app, "made");
    const valued = queueOf(app, "valued");
    const madeSettled = watch(made.ref.worker);
    const valuedSettled = watch(valued.ref.worker);
    const one = await made.queue.add("x", {});
    const two = await valued.queue.add("x", {});
    expect((await madeSettled(one.id)).result).toBe("factory");
    expect((await valuedSettled(two.id)).result).toBe("value");
  });

  it("an alias of a processor is one processor", async () => {
    @Processor("aliased")
    class Aliased {
      @Process()
      run() {
        return "once";
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "aliased" }),
      ],
      providers: [Aliased, { provide: "ALIAS", useExisting: Aliased }],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "aliased");
    const settled = watch(ref.worker);
    const job = await queue.add("x", {});
    expect((await settled(job.id)).result).toBe("once");
  });
});

describe("a job nobody handles", () => {
  it("on a @Processor queue goes dead at once, saying this process does not handle it", async () => {
    @Processor("q")
    class Only {
      @Process("known")
      known() {
        return "ok";
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      providers: [Only],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "q");
    const settled = watch(ref.worker);
    const job = await queue.add("unknown", {}, { attempts: 3 });
    const outcome = await settled(job.id);

    expect(outcome.state).toBe("dead");
    expect(outcome.attemptsMade).toBe(1);
    expect(outcome.error).toBeInstanceOf(UnrecoverableJobError);
    expect(outcome.error?.message).toContain(
      'No @Process handler for job "unknown" on queue "q" in this process',
    );
  });

  it("the control: the registry keeps bun-jobs' retryable rule", async () => {
    const jobs = borrowed();

    @Injectable()
    class Defined {
      @DefineJob("known")
      known() {
        return "ok";
      }
    }

    @Module({
      imports: [BunJobsModule.forRoot({ jobs })],
      providers: [Defined],
    })
    class AppModule {}

    await boot(AppModule);
    const dead = createDeferred<{ error: Error; attemptsMade: number }>();
    const registry = await jobs.start();
    registry.on("dead", (job: Job, error: Error) => {
      dead.resolve({ error, attemptsMade: job.attemptsMade });
    });
    await jobs
      .queue<unknown, unknown>("jobs")
      .add("unknown", {}, { attempts: 2 });

    const { error, attemptsMade } = await dead.promise;
    expect(error).toBeInstanceOf(JobsConfigError);
    expect(attemptsMade).toBe(2);
  });
});

describe("the checks at bootstrap", () => {
  /** Boots processors as the only providers. */
  function appWith(...providers: Type<unknown>[]) {
    return moduleNamed("AppModule", {
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers,
    });
  }

  it("refuses two handlers for one name, across classes", async () => {
    @Processor("q")
    class A {
      @Process("x")
      x() {}
    }
    @Processor("q")
    class B {
      @Process("x")
      y() {}
    }
    const message = await bootProblem(appWith(A, B));
    expect(message).toContain('two handlers for job "x"');
    expect(message).toContain("A.x");
    expect(message).toContain("B.y");
  });

  it("refuses two catch-alls, and within one class", async () => {
    @Processor("q")
    class A {
      @Process()
      one() {}

      @Process()
      two() {}
    }
    const message = await bootProblem(appWith(A));
    expect(message).toContain("two catch-all @Process() methods");
    expect(message).toContain("A.one");
    expect(message).toContain("A.two");
  });

  it("refuses two classes on one queue with different worker options, naming the keys", async () => {
    @Processor("q", { concurrency: 2 })
    class A {
      @Process("a")
      a() {}
    }
    @Processor("q", { concurrency: 3 })
    class B {
      @Process("b")
      b() {}
    }
    const message = await bootProblem(appWith(A, B));
    expect(message).toContain("share one worker");
    expect(message).toContain("concurrency");
    expect(message).toContain("A and B");
  });

  it("a class with no worker options joins one that has them", async () => {
    @Processor("q", { concurrency: 4 })
    class A {
      @Process("a")
      a() {}
    }
    @Processor("q", { scope: Scope.DEFAULT })
    class B {
      @Process("b")
      b() {}
    }
    await boot(appWith(A, B));
  });

  it("refuses a target that cannot run a method, and allows the one that can", async () => {
    @Processor("q", { target: "worker-thread" })
    class OffThread {
      @Process()
      a() {}
    }
    const message = await bootProblem(appWith(OffThread));
    expect(message).toContain("OffThread");
    expect(message).toContain('target "worker-thread"');
    expect(message).toContain("registerWorker");

    @Processor("q", { target: "in-process" })
    class InProcess {
      @Process()
      a() {}
    }
    await boot(appWith(InProcess));
  });

  it("refuses a controller, a @Process with no @Processor, and a @Processor with no @Process, in one error", async () => {
    @Processor("q")
    @Controller()
    class AController {
      @Process()
      a() {}
    }
    @Injectable()
    class NoProcessor {
      @Process("x")
      x() {}
    }
    @Processor("empty")
    class NoProcess {
      method() {}
    }
    const message = await bootProblem(
      moduleNamed("AppModule", {
        imports: [BunJobsModule.forRoot(contextOptions())],
        controllers: [AController],
        providers: [NoProcessor, NoProcess],
      }),
    );
    expect(message).toContain("3 problems");
    expect(message).toContain("AController: a controller cannot consume jobs");
    expect(message).toContain("NoProcessor: @Process on x() needs @Processor");
    expect(message).toContain('NoProcess: @Processor("empty") has no @Process');
  });

  it("refuses a context no forRoot provides, and a limit on the catch-all", async () => {
    @Processor("q", { context: "nowhere" })
    class Elsewhere {
      @Process()
      a() {}
    }
    expect(await bootProblem(appWith(Elsewhere))).toContain(
      'names context "nowhere", which no forRoot() provides',
    );

    @Processor("q")
    class Limited {
      @Process(undefined, { concurrency: 1 })
      a() {}
    }
    expect(await bootProblem(appWith(Limited))).toContain(
      "a catch-all @Process() has no name to put limits on",
    );
  });

  it("a worker option bun-jobs refuses is a problem in the list", async () => {
    @Processor("q", { schema: { data: 42 } as never })
    class Bad {
      @Process()
      a() {}
    }
    expect(await bootProblem(appWith(Bad))).toContain('queue "q":');
  });

  it("a class that disagrees with its queue token's context fails where it is declared", () => {
    @QueueToken("t")
    abstract class TQueue extends BunQueueClass {}
    expect(() => Processor(TQueue, { context: "other" })).toThrow(ConfigError);
  });
});

describe("per-name limits", () => {
  it("are merged into what is stored, and not written again when nothing would change", async () => {
    const jobs = borrowed();
    const queue = jobs.queue<unknown, unknown>("limited");
    await queue.setLimits({
      rate: { max: 100, duration: 60_000 },
      concurrency: 20,
      names: { other: { concurrency: 9 } },
    });

    @Processor("limited")
    class Limited {
      @Process("capped", { concurrency: 2 })
      capped() {}

      @Process("rated", { rate: { max: 5, duration: "1 minute" } })
      rated() {}

      @Process("free")
      free() {}
    }

    const AppModule = moduleNamed("AppModule", {
      imports: [BunJobsModule.forRoot({ jobs })],
      providers: [Limited],
    });

    const write = spyOn(queue, "setLimits");
    const first = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(await queue.getLimits()).toEqual({
      rate: { max: 100, duration: 60_000 },
      concurrency: 20,
      names: {
        other: { concurrency: 9 },
        capped: { concurrency: 2 },
        rated: { rate: { max: 5, duration: 60_000 } },
      },
    });
    await first.close();

    // A second process starting with the same declarations writes nothing.
    const again = moduleNamed("Again", {
      imports: [BunJobsModule.forRoot({ jobs })],
      providers: [Limited],
    });
    const second = await NestFactory.createApplicationContext(again, {
      logger: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
    await second.close();
  });
});

describe("request scope", () => {
  it("gives each job a fresh instance, with REQUEST being the job", async () => {
    const seen: { instance: unknown; job: Job; request: unknown }[] = [];

    @Processor("scoped", { scope: Scope.REQUEST })
    class Scoped {
      constructor(@Inject(REQUEST) readonly request: unknown) {}

      @Process()
      run(job: Job) {
        seen.push({ instance: this, job, request: this.request });
        return job.id;
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "scoped" }),
      ],
      providers: [Scoped],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "scoped");
    const settled = watch(ref.worker);
    const added = await Promise.all([1, 2, 3].map(() => queue.add("x", {})));
    await Promise.all(added.map((job) => settled(job.id)));

    expect(new Set(seen.map(({ instance }) => instance)).size).toBe(3);
    for (const { job, request } of seen) {
      expect(request).toBe(job);
      expect(isBunJob(request)).toBe(true);
      // Nothing is written on the job, in the open or under a symbol.
      expect(Object.getOwnPropertySymbols(job)).toEqual([]);
      expect(JSON.stringify(job)).not.toContain("contextId");
    }
    expect(isBunJob({ data: {} })).toBe(false);
  });

  it("a singleton depending on a request-scoped provider is per job too", async () => {
    const instances = new Set<unknown>();

    @Injectable({ scope: Scope.REQUEST })
    class PerJob {
      constructor(@Inject(REQUEST) readonly job: Job) {}
    }

    @Processor("bubbled")
    class Bubbled {
      constructor(readonly perJob: PerJob) {}

      @Process()
      run(job: Job) {
        instances.add(this);
        return this.perJob.job === job;
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "bubbled" }),
      ],
      providers: [PerJob, Bubbled],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "bubbled");
    const settled = watch(ref.worker);
    const one = await queue.add("x", {});
    const two = await queue.add("x", {});
    expect((await settled(one.id)).result).toBe(true);
    expect((await settled(two.id)).result).toBe(true);
    expect(instances.size).toBe(2);
  });

  it("a durable strategy sees the job, and nothing is written on it", async () => {
    const attached: unknown[] = [];
    const tenants = new Map<
      string,
      ReturnType<typeof ContextIdFactory.create>
    >();
    const strategy: ContextIdStrategy = {
      attach(contextId, request) {
        attached.push(request);
        const tenant = isBunJob<{ tenant: string }>(request)
          ? request.data.tenant
          : "http";
        let durable = tenants.get(tenant);
        if (durable === undefined) {
          durable = ContextIdFactory.create();
          tenants.set(tenant, durable);
        }
        return (info: HostComponentInfo) =>
          info.isTreeDurable ? durable : contextId;
      },
    };
    ContextIdFactory.apply(strategy);
    cleanups.push(() => {
      ContextIdFactory.apply({ attach: () => undefined });
    });

    const built: unknown[] = [];

    @Injectable({ scope: Scope.REQUEST, durable: true })
    class Tenant {
      constructor() {
        built.push(this);
      }
    }

    @Processor("tenants", { scope: Scope.REQUEST })
    class ByTenant {
      constructor(readonly tenant: Tenant) {}

      @Process()
      run() {
        return built.indexOf(this.tenant);
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "tenants" }),
      ],
      providers: [Tenant, ByTenant],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "tenants");
    const settled = watch(ref.worker);
    const a1 = await queue.add("x", { tenant: "a" });
    const a2 = await queue.add("x", { tenant: "a" });
    const b1 = await queue.add("x", { tenant: "b" });
    const [first, second, third] = await Promise.all([
      settled(a1.id),
      settled(a2.id),
      settled(b1.id),
    ]);

    expect(attached.every((request) => isBunJob(request))).toBe(true);
    expect(attached.length).toBe(3);
    expect(built.length).toBe(2);
    expect(first!.result).toBe(second!.result);
    expect(third!.result).not.toBe(first!.result);
  });

  it("a transient processor is resolved per job as well", async () => {
    const instances = new Set<unknown>();

    @Processor("transient", { scope: Scope.TRANSIENT })
    class Transient {
      @Process()
      run() {
        instances.add(this);
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "transient" }),
      ],
      providers: [Transient],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "transient");
    const settled = watch(ref.worker);
    const one = await queue.add("x", {});
    const two = await queue.add("x", {});
    await Promise.all([settled(one.id), settled(two.id)]);
    expect(instances.size).toBe(2);
  });
});

describe("JobsHost", () => {
  it("process() is the catch-all, beside named methods, and worker is the queue's", async () => {
    let seen: BunQueueWorker<any, any, any> | undefined;

    @Processor("hosted")
    class Hosted extends JobsHost<{ n: number }, string> {
      process(job: Job<{ n: number }, string>) {
        seen = this.worker as BunQueueWorker<any, any, any>;
        return `n:${job.data.n}`;
      }

      @Process("named")
      named() {
        return "named";
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "hosted" }),
      ],
      providers: [Hosted],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "hosted");
    const settled = watch(ref.worker);
    const one = await queue.add("any", { n: 1 });
    const two = await queue.add("named", { n: 2 });
    expect((await settled(one.id)).result).toBe("n:1");
    expect((await settled(two.id)).result).toBe("named");
    expect(seen).toBe(ref.worker);
  });

  it("worker throws before bootstrap", async () => {
    let error: unknown;

    @Processor("hosted")
    class Hosted extends JobsHost {
      onModuleInit() {
        try {
          return this.worker;
        } catch (caught) {
          error = caught;
        }
      }

      process() {}
    }

    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [Hosted],
    })
    class AppModule {}

    await boot(AppModule);
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("Hosted.worker: no worker yet");
  });

  it("a host with no @Processor is refused", async () => {
    class Bare extends JobsHost {
      process() {}
    }

    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [Bare],
    })
    class AppModule {}

    expect(await bootProblem(AppModule)).toContain(
      "Bare: a JobsHost needs @Processor",
    );
  });
});

describe("autoStart and BunJobsLifecycle", () => {
  it("autoStart: false claims nothing until start(), and stop() parks", async () => {
    const handled: string[] = [];

    @Processor("manual")
    class Manual {
      @Process()
      run(job: Job) {
        handled.push(job.name);
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ ...contextOptions(), autoStart: false }),
        BunJobsModule.registerQueue({ name: "manual" }),
      ],
      providers: [Manual],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "manual");
    // Discovery ran: the worker exists, and has not started.
    expect(ref.worker.isRunning).toBe(false);
    const settled = watch(ref.worker);
    const first = await queue.add("first", {});
    await Bun.sleep(50);
    expect(handled).toEqual([]);

    const lifecycle = app.get(BunJobsLifecycle, { strict: false });
    await lifecycle.start();
    await settled(first.id);
    expect(handled).toEqual(["first"]);

    await lifecycle.stop();
    expect(ref.worker.isStopped()).toBe(true);
    const second = await queue.add("second", {});
    await Bun.sleep(50);
    expect(handled).toEqual(["first"]);

    await lifecycle.start();
    await settled(second.id);
    expect(handled).toEqual(["first", "second"]);
  });

  it("start() before bootstrap is a ConfigError", async () => {
    let error: unknown;

    @Injectable()
    class TooEarly {
      constructor(readonly lifecycle: BunJobsLifecycle) {}

      async onModuleInit() {
        await this.lifecycle.start().catch((caught: unknown) => {
          error = caught;
        });
      }
    }

    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [TooEarly],
    })
    class AppModule {}

    await boot(AppModule);
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("after app.init()");
  });

  it("a named context can be started on its own", async () => {
    const handled: string[] = [];

    @Processor("q")
    class Shop {
      @Process()
      run() {
        handled.push("shop");
      }
    }
    @Processor("q", { context: "billing" })
    class Billing {
      @Process()
      run() {
        handled.push("billing");
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ ...contextOptions(), autoStart: false }),
        BunJobsModule.forRoot({
          ...contextOptions(),
          name: "billing",
          autoStart: false,
        }),
        BunJobsModule.registerQueue(
          { name: "q" },
          { name: "q", context: "billing" },
        ),
      ],
      providers: [Shop, Billing],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const shop = queueOf(app, "q");
    const billing = queueOf(app, "q", "billing");
    await shop.queue.add("x", {});
    const settled = watch(billing.ref.worker);
    const job = await billing.queue.add("x", {});

    await app.get(BunJobsLifecycle, { strict: false }).start("billing");
    await settled(job.id);
    expect(handled).toEqual(["billing"]);
    expect(shop.ref.worker.isRunning).toBe(false);
  });
});

describe("@InjectWorker", () => {
  it("injects a handle on the worker, by class or by name, which throws until bootstrap", async () => {
    let early: unknown;

    @Processor("q", { concurrency: 2 })
    class Consumer {
      @Process()
      run() {}
    }

    @Injectable()
    class Ops {
      constructor(
        @InjectWorker(Consumer) readonly byClass: WorkerRef,
        @InjectWorker("q") readonly byName: WorkerRef,
      ) {}

      onModuleInit() {
        try {
          return this.byClass.worker;
        } catch (error) {
          early = error;
        }
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      providers: [Consumer, Ops],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const ops = app.get(Ops);
    expect(early).toBeInstanceOf(ConfigError);
    expect(String(early)).toContain(
      "workers are built at onApplicationBootstrap",
    );
    expect(ops.byClass.worker.queueName).toBe("q");
    expect(ops.byName.worker).toBe(ops.byClass.worker);
    expect(ops.byClass.worker.concurrency).toBe(2);
  });

  it("refuses a class with no @Processor, and reaches a named context", async () => {
    class Plain {}
    expect(() => InjectWorker(Plain)).toThrow("Plain has no @Processor");

    @Processor("q", { context: "billing" })
    class Billing {
      @Process()
      run() {}
    }

    @Injectable()
    class Ops {
      constructor(@InjectWorker(Billing) readonly ref: WorkerRef) {}
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({ ...contextOptions(), name: "billing" }),
        BunJobsModule.registerQueue({ name: "q", context: "billing" }),
      ],
      providers: [Billing, Ops],
    })
    class AppModule {}

    const app = await boot(AppModule);
    expect(app.get(Ops).ref.worker.queueName).toBe("q");
  });
});

describe("registerWorker", () => {
  const FILE = `${import.meta.dir}/fixtures/jobs-decorators/processor.ts`;

  it("runs a processor file as a worker the module owns", async () => {
    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "files" }),
        BunJobsModule.registerWorker({ queue: "files", processor: FILE }),
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const { queue, ref } = queueOf(app, "files");
    const settled = watch(ref.worker);
    const job = await queue.add("resize", {});
    const outcome = await settled(job.id);
    expect(outcome.result).toMatchObject({
      name: "resize",
      mainThread: true,
      pid: process.pid,
    });
  }, 30_000);

  it("takes a target, and closes with the application", async () => {
    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "files" }),
        BunJobsModule.registerWorker({
          queue: "files",
          processor: FILE,
          options: { target: "worker-thread" },
        }),
      ],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const { queue, ref } = queueOf(app, "files");
    const settled = watch(ref.worker);
    const job = await queue.add("resize", {});
    const outcome = await settled(job.id);
    expect(outcome.result).toMatchObject({ name: "resize", mainThread: false });
    const worker = ref.worker;
    expect(worker.isRunning).toBe(true);
    await app.close();
    expect(worker.isRunning).toBe(false);
  }, 30_000);

  it("refuses a file and a @Processor on one queue, and two files", async () => {
    @Processor("files")
    class Consumer {
      @Process()
      run() {}
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerWorker({ queue: "files", processor: FILE }),
      ],
      providers: [Consumer],
    })
    class Both {}
    expect(await bootProblem(Both)).toContain(
      'queue "files": registerWorker and a @Processor would each claim',
    );

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerWorker({ queue: "files", processor: FILE }),
        BunJobsModule.registerWorker({ queue: "files", processor: FILE }),
      ],
    })
    class TwoFiles {}
    expect(await bootProblem(TwoFiles)).toContain(
      'queue "files": two registerWorker() calls',
    );
  });
});

describe("@DefineJob", () => {
  it("defines the job on the registry, so jobs.now() checks the name and applies the defaults", async () => {
    @Injectable()
    class Tag {
      readonly tag = "tagged";
    }

    @Injectable()
    class Reports {
      constructor(readonly tag: Tag) {}

      @DefineJob("send-report", { attempts: 5 })
      sendReport(job: Job<{ month: string }>) {
        return `${this.tag.tag}:${job.data.month}`;
      }
    }

    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [Tag, Reports],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const jobs = app.get<BunJobs>(BunJobs);
    const registry = await jobs.start();
    const settled = watch(registry as BunQueueWorker<any, any, any>);
    const job = await jobs.now("send-report", { month: "may" });

    expect(job.opts.attempts).toBe(5);
    expect((await settled(job.id)).result).toBe("tagged:may");
  });

  it("refuses a name defined twice, and one method both ways", async () => {
    @Injectable()
    class A {
      @DefineJob("x")
      x() {}
    }
    @Injectable()
    class B {
      @DefineJob("x")
      y() {}
    }
    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [A, B],
    })
    class Twice {}
    expect(await bootProblem(Twice)).toContain(
      'job "x" is defined twice, by A.x and B.y',
    );

    @Processor("q")
    class Both {
      @Process("x")
      @DefineJob("x")
      x() {}
    }
    @Module({
      imports: [BunJobsModule.forRoot(contextOptions())],
      providers: [Both],
    })
    class OneMethod {}
    expect(await bootProblem(OneMethod)).toContain(
      "@Process and @DefineJob on one method",
    );
  });

  it("autoStart: false leaves the registry worker until start(), with registryWorker's options", async () => {
    const handled: string[] = [];

    @Injectable()
    class Reports {
      @DefineJob("report", { context: "reports" })
      report() {
        handled.push("report");
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({
          ...contextOptions(),
          name: "reports",
          autoStart: false,
          registryWorker: { concurrency: 3 },
        }),
      ],
      providers: [Reports],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const jobs = app.get<BunJobs>(getBunJobsToken("reports"));
    const start = spyOn(jobs, "start");
    const job = await jobs.now("report", {});
    await Bun.sleep(30);
    expect(handled).toEqual([]);
    expect(start).not.toHaveBeenCalled();

    await app.get(BunJobsLifecycle, { strict: false }).start();
    expect(start).toHaveBeenCalledWith({ concurrency: 3 });
    const registry = await jobs.start();
    expect(registry.concurrency).toBe(3);
    expect(job.name).toBe("report");
  });
});
