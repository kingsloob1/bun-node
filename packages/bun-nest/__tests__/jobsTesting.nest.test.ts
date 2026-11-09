/**
 * `@kingsleyweb/bun-nest/jobs/testing` (plan §9.9): `BunJobsTestingModule`, `runJob` and
 * `drainJobs`, under the real `Test.createTestingModule`, with Nest's overrides, through the
 * real worker and pipeline, and beside `adapter.fetch()`.
 */
import type { Job } from "@kingsleyweb/bun-jobs";
import type {
  CanActivate,
  INestApplicationContext,
  Type,
} from "@nestjs/common";
import type { TestingModule } from "@nestjs/testing";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { ConfigError } from "@kingsleyweb/bun-common";
import { BunQueue } from "@kingsleyweb/bun-jobs";
import {
  Controller,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunJobsLifecycle,
  BunJobsModule,
  CurrentJob,
  DefineJob,
  Every,
  getBunJobsToken,
  getQueueToken,
  InjectQueue,
  JobData,
  Process,
  Processor,
  QueueToken,
} from "../lib/jobs/index";
import {
  BunJobsTestingModule,
  drainJobs,
  runJob,
} from "../lib/jobs/testing/index";
import "reflect-metadata";

const closing: INestApplicationContext[] = [];

afterEach(async () => {
  await Promise.all(closing.splice(0).map((app) => app.close()));
});

/** Boots a testing module that closes after the test. */
async function boot(
  metadata: Parameters<typeof Test.createTestingModule>[0],
  adjust: (
    builder: ReturnType<typeof Test.createTestingModule>,
  ) => ReturnType<typeof Test.createTestingModule> = (builder) => builder,
): Promise<TestingModule> {
  const moduleRef = await adjust(Test.createTestingModule(metadata)).compile();
  moduleRef.useLogger(false);
  const app = await moduleRef.init();
  closing.push(app);
  return app;
}

/** A module's own imports, with the testing context beside it. */
const imports = (...modules: Type<unknown>[]) => [
  BunJobsTestingModule.forRoot({ logger: false }),
  ...modules,
];

@Injectable()
class Mailer {
  send(to: string): string {
    return `sent:${to}`;
  }
}

@Injectable()
class FlagGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException("the flag is off");
  }
}

@Processor("emails")
class Emails {
  constructor(@Inject(Mailer) readonly mailer: Mailer) {}

  @Process("welcome")
  async welcome(@JobData("to") to: string, @CurrentJob() job: Job) {
    await job.log(`to ${to}`);
    await job.log("done");
    return this.mailer.send(to);
  }

  @Process("broken")
  broken() {
    throw new Error("the mailbox is full");
  }

  @Process("number")
  number(@JobData("n", ParseIntPipe) n: number) {
    return n + 1;
  }

  @Process("guarded")
  @UseGuards(FlagGuard)
  guarded() {
    return "ran";
  }

  @Process("slow")
  async slow() {
    await Bun.sleep(60_000);
  }
}

@Module({
  imports: [BunJobsModule.registerQueue({ name: "emails" })],
  providers: [Mailer, Emails, FlagGuard],
})
class EmailsModule {}

describe("runJob", () => {
  it("runs a job through the real worker and DI, with its result, attempts and log", async () => {
    const app = await boot({ imports: imports(EmailsModule) });

    const outcome = await runJob<string>(app, "emails", "welcome", {
      to: "ada@example.com",
    });

    expect(outcome).toMatchObject({
      state: "completed",
      result: "sent:ada@example.com",
      attempts: 1,
      logs: ["to ada@example.com", "done"],
    });
    expect(outcome.error).toBeUndefined();
    const stored = await app
      .get<BunQueue>(getQueueToken("emails"), { strict: false })
      .getJob(outcome.id);
    expect(stored?.state).toBe("completed");
  });

  it("a job out of attempts is a dead outcome, with backoff collapsed", async () => {
    const app = await boot({ imports: imports(EmailsModule) });
    const startedAt = Date.now();

    const outcome = await runJob(app, "emails", "broken", {}, { attempts: 3 });

    expect(outcome).toMatchObject({ state: "dead", attempts: 3, logs: [] });
    expect(outcome.error?.message).toBe("the mailbox is full");
    expect(outcome.result).toBeUndefined();
    // The default backoff starts at 1 s, so two retries would take that at least.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("options.backoff is honoured", async () => {
    const app = await boot({ imports: imports(EmailsModule) });
    const startedAt = Date.now();

    await runJob(app, "emails", "broken", {}, { attempts: 2, backoff: 300 });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);
  });

  it("keeps the job to read back, unless the caller asks for its removal", async () => {
    const app = await boot({ imports: imports(EmailsModule) });
    const queue = app.get<BunQueue>(getQueueToken("emails"), { strict: false });

    await queue.setJobDefaults({ removeOnComplete: true });

    const kept = await runJob(app, "emails", "welcome", { to: "a" });
    expect((await queue.getJob(kept.id))?.state).toBe("completed");

    await expect(
      runJob(app, "emails", "welcome", { to: "a" }, { removeOnComplete: true }),
    ).rejects.toThrow(/was removed before it settled/);
  });

  it("goes through the pipeline: a pipe refuses, and a guard does", async () => {
    const app = await boot({ imports: imports(EmailsModule) });

    expect(await runJob(app, "emails", "number", { n: "41" })).toMatchObject({
      state: "completed",
      result: 42,
    });
    const refused = await runJob(app, "emails", "number", { n: "x" });
    expect(refused.state).toBe("dead");
    expect(refused.error?.message).toContain("numeric string");
    const guarded = await runJob(app, "emails", "guarded", {});
    expect(guarded.state).toBe("dead");
    expect(guarded.error?.message).toBe("the flag is off");
  });

  it("refuses a queue nothing serves, naming it, and adds nothing", async () => {
    const app = await boot({ imports: imports(EmailsModule) });

    const refusal = await runJob(app, "nope", "x", {}).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ConfigError);
    expect((refusal as Error).message).toContain('"nope"');
    const jobs = app.get(getBunJobsToken(), { strict: false });
    expect(await jobs.queue("nope").count("waiting")).toBe(0);
  });

  it("rejects with the job's state when it does not settle", async () => {
    const app = await boot({ imports: imports(EmailsModule) });

    await expect(
      runJob(app, "emails", "slow", {}, { settleWithin: 100 }),
    ).rejects.toThrow(/"slow".*"emails" is still active after 100 ms/);
  });

  it("before init, says so; with no context, says so", async () => {
    const compiled = await Test.createTestingModule({
      imports: imports(EmailsModule),
    }).compile();
    closing.push(compiled);
    await expect(runJob(compiled, "emails", "welcome", {})).rejects.toThrow(
      /moduleRef\.init\(\)/,
    );

    const bare = await boot({ providers: [Mailer] });
    await expect(runJob(bare, "emails", "welcome", {})).rejects.toThrow(
      /Import BunJobsTestingModule\.forRoot\(\)/,
    );
    const app = await boot({ imports: imports(EmailsModule) });
    await expect(
      runJob(app, "emails", "welcome", {}, { context: "other" }),
    ).rejects.toThrow(/jobs context "other"/);
  });

  it("with no context, on an application with abortOnError on, rejects and leaves the process", async () => {
    // A child, since what this guards against is the process ending.
    const child = Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/fixtures/jobs-testing/no-context.fixture.ts`,
      ],
      { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(await child.exited, out + err).toBe(0);
    expect(out.trim().split("\n")).toEqual([
      "runJob ConfigError: runJob: this application has no default jobs context. Import BunJobsTestingModule.forRoot()",
      "drainJobs ConfigError: drainJobs: this application has no default jobs context. Import BunJobsTestingModule.forRoot()",
      "still running",
    ]);
  }, 30_000);

  it("starts that queue's worker alone, and no schedule", async () => {
    const seen: string[] = [];

    @Processor("one")
    class One {
      @Process()
      run() {
        seen.push("one");
      }
    }

    @Processor("two")
    class Two {
      @Process()
      run() {
        seen.push("two");
      }
    }

    @Injectable()
    class Scheduled {
      @Every(20)
      tick() {
        seen.push("tick");
      }
    }

    const app = await boot({
      imports: imports(),
      providers: [One, Two, Scheduled],
    });
    const jobs = app.get(getBunJobsToken(), { strict: false });
    await jobs.queue("two").add("waits", {});

    await runJob(app, "one", "x", {});
    await Bun.sleep(100);

    expect(seen).toEqual(["one"]);
    expect(await jobs.queue("two").count("waiting")).toBe(1);
    expect((await jobs.listQueues()).toSorted()).toEqual(["one", "two"]);

    // A drain of everything is not kept busy by the schedule, or started by it.
    const drained = await drainJobs(app);
    expect(drained.map((job) => job.name)).toEqual(["waits"]);
    expect(seen).toEqual(["one", "two"]);
    expect(await jobs.queue("nest-schedule").count("delayed")).toBe(0);

    // The control: the schedule does run, once everything is started.
    await app.get(BunJobsLifecycle, { strict: false }).start();
    const by = Date.now() + 3_000;
    while (!seen.includes("tick") && Date.now() < by) {
      await Bun.sleep(10);
    }
    expect(seen).toContain("tick");
  });

  it("runs a @DefineJob on the context's registry queue", async () => {
    @Injectable()
    class Defined {
      @DefineJob("double")
      double(@JobData("n") n: number) {
        return n * 2;
      }
    }

    const app = await boot({ imports: imports(), providers: [Defined] });

    expect(await runJob(app, "jobs", "double", { n: 21 })).toMatchObject({
      state: "completed",
      result: 42,
    });
  });
});

describe("Nest's overrides", () => {
  it("overrideProvider on a queue token gives a producer its fake", async () => {
    @Injectable()
    class Shop {
      constructor(@InjectQueue("emails") readonly queue: BunQueue) {}
    }

    const added: unknown[] = [];
    const fake = { add: (...args: unknown[]) => added.push(args) };
    const app = await boot(
      {
        imports: [
          ...imports(EmailsModule),
          BunJobsModule.registerQueue({ name: "emails" }),
        ],
        providers: [Shop],
      },
      (builder) =>
        builder.overrideProvider(getQueueToken("emails")).useValue(fake),
    );

    expect(app.get(Shop).queue as unknown).toBe(fake);
  });

  it("overrideProvider on a typed token", async () => {
    @QueueToken("typed")
    abstract class TypedQueue extends BunQueue<{ id: number }, string> {}

    @Injectable()
    class Shop {
      constructor(@Inject(TypedQueue) readonly queue: unknown) {}
    }

    const fake = { fake: true };
    const app = await boot(
      {
        imports: [
          BunJobsTestingModule.forRoot({ logger: false }),
          BunJobsModule.registerQueue(TypedQueue),
        ],
        providers: [Shop],
      },
      (builder) => builder.overrideProvider(TypedQueue).useValue(fake),
    );

    expect(app.get(Shop).queue).toBe(fake);
  });

  it("overrideProvider reaches what a handler injects", async () => {
    const app = await boot({ imports: imports(EmailsModule) }, (builder) =>
      builder
        .overrideProvider(Mailer)
        .useValue({ send: (to: string) => `faked:${to}` }),
    );

    expect((await runJob(app, "emails", "welcome", { to: "a" })).result).toBe(
      "faked:a",
    );
  });

  it("overrideGuard reaches the job pipeline", async () => {
    const app = await boot({ imports: imports(EmailsModule) }, (builder) =>
      builder.overrideGuard(FlagGuard).useValue({ canActivate: () => true }),
    );

    expect(await runJob(app, "emails", "guarded", {})).toMatchObject({
      state: "completed",
      result: "ran",
    });
  });
});

describe("drainJobs", () => {
  const log: string[] = [];

  @Processor("orders")
  class Orders {
    constructor(@InjectQueue("receipts") readonly receipts: BunQueue) {}

    @Process()
    async run(@JobData("id") id: number) {
      log.push(`order ${id}`);
      await this.receipts.add("receipt", { id });
    }
  }

  @Processor("receipts")
  class Receipts {
    @Process()
    async run(@JobData("id") id: number, @JobData("ms") ms?: number) {
      await Bun.sleep(ms ?? 10);
      log.push(`receipt ${id}`);
      if (id < 0) {
        throw new Error("no receipt");
      }
    }
  }

  @Module({
    imports: [
      BunJobsModule.registerQueue({ name: "orders" }),
      BunJobsModule.registerQueue({ name: "receipts" }),
    ],
    providers: [Orders, Receipts],
  })
  class ShopModule {}

  const queueOf = (app: INestApplicationContext, name: string): BunQueue =>
    app.get<BunQueue>(getQueueToken(name), { strict: false });

  it("runs a fan-out to the end, and answers the jobs that settled", async () => {
    log.length = 0;
    const app = await boot({ imports: imports(ShopModule) });
    await queueOf(app, "orders").add("order", { id: 1 });
    await queueOf(app, "orders").add("order", { id: 2 });

    const settled = await drainJobs(app);

    expect(log.toSorted()).toEqual([
      "order 1",
      "order 2",
      "receipt 1",
      "receipt 2",
    ]);
    expect(settled.map((job) => job.state)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(settled.map((job) => job.name).toSorted()).toEqual([
      "order",
      "order",
      "receipt",
      "receipt",
    ]);
    for (const [index, job] of settled.entries()) {
      expect(job.finishedOn).toBeGreaterThanOrEqual(
        settled[index - 1]?.finishedOn ?? 0,
      );
    }
  });

  it("a second drain answers only what settled since", async () => {
    const app = await boot({ imports: imports(ShopModule) });
    await queueOf(app, "orders").add("order", { id: 1 });
    expect(await drainJobs(app)).toHaveLength(2);

    await queueOf(app, "orders").add("order", { id: 2 });
    expect(await drainJobs(app)).toHaveLength(2);
    expect(await drainJobs(app)).toHaveLength(0);
  });

  it("waits for a job in flight", async () => {
    log.length = 0;
    const app = await boot({ imports: imports(ShopModule) });
    await queueOf(app, "receipts").add("receipt", { id: 1, ms: 200 });

    const settled = await drainJobs(app, { queues: ["receipts"] });

    expect(log).toEqual(["receipt 1"]);
    expect(settled.map((job) => job.state)).toEqual(["completed"]);
  });

  it("a job added just after its queue looked idle is still drained", async () => {
    const app = await boot({ imports: imports(ShopModule) });
    const jobs = app.get(getBunJobsToken(), { strict: false });
    const queue = jobs.queue("receipts");
    const read = queue.getDemand.bind(queue);
    let first = true;
    // What a handler on another queue can do between this queue's look and that one's.
    queue.getDemand = async (options: Parameters<BunQueue["getDemand"]>[0]) => {
      const demand = await read(options);
      if (first) {
        first = false;
        await queue.add("late", { id: 1 });
      }
      return demand;
    };

    const settled = await drainJobs(app, { queues: ["receipts"] });

    expect(settled.map((job) => job.name)).toEqual(["late"]);
  });

  it("a job a runJob settled is not answered again", async () => {
    const app = await boot({ imports: imports(ShopModule) });

    const { id } = await runJob(app, "receipts", "receipt", { id: 9 });
    const settled = await drainJobs(app);

    expect(settled.map((job) => job.id)).not.toContain(id);
  });

  it("runs the listed queues alone", async () => {
    log.length = 0;
    const app = await boot({ imports: imports(ShopModule) });
    await queueOf(app, "orders").add("order", { id: 1 });
    await queueOf(app, "receipts").add("receipt", { id: 7 });

    const settled = await drainJobs(app, { queues: ["orders"] });

    expect(log).toEqual(["order 1"]);
    expect(settled.map((job) => job.name)).toEqual(["order"]);
    expect(await queueOf(app, "receipts").count("waiting")).toBe(2);
  });

  it("waits out a retry's backoff, and answers a dead job", async () => {
    log.length = 0;
    const app = await boot({ imports: imports(ShopModule) });
    await queueOf(app, "receipts").add(
      "receipt",
      { id: -1 },
      { attempts: 2, backoff: 100 },
    );

    const [settled] = await drainJobs(app, { queues: ["receipts"] });

    expect(log).toEqual(["receipt -1", "receipt -1"]);
    expect(settled?.state).toBe("dead");
  });

  it("leaves a job due later than it would wait", async () => {
    const app = await boot({ imports: imports(ShopModule) });
    await queueOf(app, "receipts").add("later", { id: 1 }, { delay: 60_000 });

    expect(await drainJobs(app, { queues: ["receipts"] })).toEqual([]);
    expect(await queueOf(app, "receipts").count("delayed")).toBe(1);
  });

  it("refuses a queue nothing serves, and rejects naming a queue still busy", async () => {
    const app = await boot({ imports: imports(ShopModule, EmailsModule) });
    const refusal = await drainJobs(app, { queues: ["nope"] }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ConfigError);
    expect((refusal as Error).message).toContain('"nope"');

    await queueOf(app, "emails").add("slow", {});
    await expect(
      drainJobs(app, { queues: ["emails"], settleWithin: 100 }),
    ).rejects.toThrow(/still busy after 100 ms: "emails" \(1 outstanding\)/);
  });
});

describe("BunJobsTestingModule", () => {
  it("gives each call a namespace of its own, so two apps at once do not meet", async () => {
    const ran: string[] = [];

    @Processor("shared")
    class Shared {
      @Process()
      run(@JobData("who") who: string) {
        ran.push(who);
        return who;
      }
    }

    const [one, two] = await Promise.all([
      boot({ imports: imports(), providers: [Shared] }),
      boot({ imports: imports(), providers: [Shared] }),
    ]);
    const namespaces = [one, two].map(
      (app) => app.get(getBunJobsToken(), { strict: false }).namespace,
    );
    expect(namespaces[0]).toStartWith("test-");
    expect(namespaces[1]).not.toBe(namespaces[0]);

    const outcomes = await Promise.all([
      runJob(one, "shared", "x", { who: "one" }),
      runJob(two, "shared", "x", { who: "two" }),
    ]);

    expect(outcomes.map((outcome) => outcome.result)).toEqual(["one", "two"]);
    expect(ran.toSorted()).toEqual(["one", "two"]);
    const counts = await Promise.all(
      [one, two].map((app) =>
        app
          .get(getBunJobsToken(), { strict: false })
          .queue("shared")
          .count("completed"),
      ),
    );
    expect(counts).toEqual([1, 1]);
  });

  it("its options win over the defaults, a name included", async () => {
    @Processor("named", { context: "other" })
    class Named {
      @Process()
      run() {
        return "ran";
      }
    }

    const app = await boot({
      imports: [
        BunJobsTestingModule.forRoot({
          name: "other",
          namespace: "mine",
          logger: false,
        }),
      ],
      providers: [Named],
    });

    expect(app.get(getBunJobsToken("other"), { strict: false }).namespace).toBe(
      "mine",
    );
    expect(
      (await runJob(app, "named", "x", {}, { context: "other" })).result,
    ).toBe("ran");
  });

  it("nothing starts at bootstrap", async () => {
    const app = await boot({ imports: imports(EmailsModule) });
    const queue = app.get<BunQueue>(getQueueToken("emails"), { strict: false });
    await queue.add("welcome", { to: "a" });
    await Bun.sleep(100);

    expect(await queue.count("waiting")).toBe(1);
  });
});

describe("in parallel test files", () => {
  it("two files on one queue name do not meet", async () => {
    const dir = `${import.meta.dir}/fixtures/jobs-testing`;
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--parallel=2",
        `${dir}/one.fixture.ts`,
        `${dir}/two.fixture.ts`,
      ],
      { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = out + err;

    expect(await child.exited, output).toBe(0);
    expect(output).toMatch(/\b2 pass/);
    expect(output).toMatch(/\b0 fail/);
  }, 30_000);
});

/**
 * The testing entry stays out of a production import graph, the way bun-jobs'
 * `provider/testing` does.
 */
describe("the ./jobs entry", () => {
  /** Every file under `lib/` a file reaches by relative imports. */
  function reachedFrom(entry: string, seen = new Set<string>()): Set<string> {
    seen.add(entry);
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    for (const { path } of transpiler.scanImports(
      readFileSync(entry, "utf8"),
    )) {
      if (!path.startsWith(".")) {
        continue;
      }
      const target = Bun.resolveSync(path, dirname(entry));
      if (!seen.has(target)) {
        reachedFrom(target, seen);
      }
    }
    return seen;
  }

  const lib = `${import.meta.dir}/../lib/jobs`;

  it("does not reach ./jobs/testing, and the walk can see it", () => {
    const fromJobs = [...reachedFrom(`${lib}/index.ts`)];
    expect(fromJobs.length).toBeGreaterThan(10);
    expect(fromJobs.filter((file) => file.includes("/testing/"))).toEqual([]);
    // The negative control: the walk does find the testing files from their own entry.
    expect(
      [...reachedFrom(`${lib}/testing/index.ts`)].some((file) =>
        file.endsWith("/testing/run.ts"),
      ),
    ).toBe(true);
  });
});

describe("beside adapter.fetch()", () => {
  it("enqueues through a controller with a peer address and no port, then drains", async () => {
    @Controller("signups")
    class Signups {
      constructor(@InjectQueue("emails") readonly queue: BunQueue) {}

      @Post()
      async create(@Req() req: { ip?: string }) {
        const { id } = await this.queue.add("welcome", { to: req.ip });
        return { id };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ...imports(EmailsModule),
        BunJobsModule.registerQueue({ name: "emails" }),
      ],
      controllers: [Signups],
    }).compile();
    const adapter = new BunHttpAdapter();
    const app = moduleRef.createNestApplication(adapter);
    await app.init();
    closing.push(app);

    const response = await adapter.fetch("/signups", {
      method: "POST",
      remoteAddress: "10.0.0.4",
    });
    expect(response.status).toBe(201);

    const settled = await drainJobs(app, { queues: ["emails"] });
    expect(settled.map((job) => job.returnValue)).toEqual(["sent:10.0.0.4"]);
  });
});
