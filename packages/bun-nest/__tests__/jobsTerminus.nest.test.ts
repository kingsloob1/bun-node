/**
 * `@kingsleyweb/bun-nest/jobs/terminus` (plan §9.8), through real terminus and a controller,
 * over the adapter with no socket. A health check's two answers are 200 and 503, so each case
 * reads both the indicator's result and what the endpoint says.
 */
import type { BunJobs, BunQueue } from "@kingsleyweb/bun-jobs";
import type { DynamicModule, INestApplication, Type } from "@nestjs/common";
import { MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Controller, Get, Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { HealthCheck, HealthCheckService } from "@nestjs/terminus";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunJobsLifecycle,
  BunJobsModule,
  DefineJob,
  getBunJobsToken,
  JobData,
  Process,
  Processor,
} from "../lib/jobs/index";
import { BunJobsRegistry } from "../lib/jobs/registry";
import {
  BunJobsHealthIndicator,
  BunJobsHealthModule,
} from "../lib/jobs/terminus/index";
import "reflect-metadata";

const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

@Processor("emails")
class Emails {
  @Process()
  run() {
    return "sent";
  }
}

/** What the endpoint passes to the indicator, set by each case. */
let checked: Parameters<BunJobsHealthIndicator["isHealthy"]>[1] = {};

@Controller("health")
class Health {
  constructor(
    @Inject(HealthCheckService) readonly health: HealthCheckService,
    @Inject(BunJobsHealthIndicator) readonly jobs: BunJobsHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.jobs.isHealthy("jobs", checked)]);
  }
}

interface Booted {
  app: INestApplication;
  adapter: BunHttpAdapter;
  jobs: BunJobs;
  queue: BunQueue;
  indicator: BunJobsHealthIndicator;
  /** What `/health` answers. */
  endpoint: () => Promise<{
    status: number;
    body: {
      status: string;
      info: Record<string, unknown>;
      error: Record<string, { message?: string }>;
    };
  }>;
}

/** An application with a worker on "emails", and `/health`. */
async function boot(
  options: {
    driver?: MemoryDriver;
    autoStart?: boolean;
    providers?: Type<unknown>[];
    imports?: DynamicModule[];
  } = {},
): Promise<Booted> {
  checked = {};

  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: `health-${crypto.randomUUID()}`,
        driver: options.driver ?? new MemoryDriver(),
        logger: false,
        autoStart: options.autoStart ?? true,
        shutdown: { timeout: 500 },
      }),
      BunJobsHealthModule,
      ...(options.imports ?? []),
    ],
    providers: options.providers ?? [Emails],
    controllers: [Health],
  })
  class AppModule {}

  const adapter = new BunHttpAdapter(30000);
  const app = (await NestFactory.create(AppModule, adapter, {
    logger: false,
  })) as INestApplication;
  cleanups.push(() => app.close());
  await app.init();
  const jobs = app.get<BunJobs>(getBunJobsToken(), { strict: false });
  return {
    app,
    adapter,
    jobs,
    queue: jobs.queue("emails"),
    indicator: app.get(BunJobsHealthIndicator, { strict: false }),
    endpoint: async () => {
      const response = await adapter.fetch("/health");
      return {
        status: response.status,
        body: (await response.json()) as never,
      };
    },
  };
}

/** A memory driver whose `ping` does as told. */
class PingingDriver extends MemoryDriver {
  /** What `ping` does. */
  answer: () => Promise<boolean> = async () => await Promise.resolve(true);

  override async ping(): Promise<boolean> {
    return await this.answer();
  }
}

/** Waits for a condition. */
async function until(condition: () => Promise<boolean>): Promise<void> {
  const by = Date.now() + 3_000;
  while (!(await condition()) && Date.now() < by) {
    await Bun.sleep(10);
  }
  expect(await condition()).toBe(true);
}

describe("isHealthy", () => {
  it("up: 200, with the queue's figures", async () => {
    const booted = await boot();
    checked = {
      queues: ["emails"],
      maxOutstanding: 10,
      requireWorkers: true,
    };

    const { status, body } = await booted.endpoint();

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.info.jobs).toMatchObject({
      status: "up",
      queues: { emails: { outstanding: 0 } },
    });
  });

  it("the indicator answers terminus' result, keyed as asked", async () => {
    const booted = await boot();

    const result = await booted.indicator.isHealthy("mine", {
      queues: ["emails"],
    });

    expect(result.mine?.status).toBe("up");
  });

  it("down when ping answers false: 503", async () => {
    const driver = new PingingDriver();
    const booted = await boot({ driver });
    driver.answer = async () => await Promise.resolve(false);

    const { status, body } = await booted.endpoint();

    expect(status).toBe(503);
    expect(body.status).toBe("error");
    expect(body.error.jobs).toMatchObject({
      status: "down",
      message: "The backend is unreachable",
    });
  });

  it("down when ping throws, telling the caller nothing of why", async () => {
    const driver = new PingingDriver();
    const booted = await boot({ driver });
    driver.answer = async () => {
      await Promise.resolve();
      throw new Error("connect ECONNREFUSED 10.0.0.9:6379");
    };

    const { status, body } = await booted.endpoint();

    expect(status).toBe(503);
    expect(body.error.jobs?.message).toBe("The jobs health check failed");
    expect(JSON.stringify(body)).not.toContain("10.0.0.9");
  });

  it("a failure anywhere in the read tells the caller nothing, and logs it", async () => {
    const driver = new PingingDriver();
    const booted = await boot({ driver, autoStart: false });
    Object.defineProperty(driver, "countDemand", {
      value: async () => {
        await Promise.resolve();
        throw new Error(
          "connect ECONNREFUSED postgres://user:hunter2@db.internal:5432",
        );
      },
    });

    const { status, body } = await booted.endpoint();

    expect(status).toBe(503);
    expect(body.error.jobs?.message).toBe("The jobs health check failed");
    const said = JSON.stringify(body);
    expect(said).not.toContain("db.internal");
    expect(said).not.toContain("hunter2");
  });

  for (const [name, driver] of [
    ["redis", { type: "redis", url: "redis://secret:hunter2@127.0.0.1:1/15" }],
    [
      "postgres",
      {
        type: "sql",
        url: "postgres://user:hunter2@127.0.0.1:1/db",
        adapter: "postgres",
      },
    ],
  ] as const) {
    it(`a real ${name} driver that cannot connect is down, with no host or password in the response`, async () => {
      checked = {};

      @Module({
        imports: [
          BunJobsModule.forRoot({
            namespace: "health-unreachable",
            driver,
            logger: false,
            autoStart: false,
          }),
          BunJobsHealthModule,
        ],
        controllers: [Health],
      })
      class AppModule {}

      const adapter = new BunHttpAdapter(30000);
      const app = (await NestFactory.create(AppModule, adapter, {
        logger: false,
      })) as INestApplication;
      cleanups.push(() => app.close());
      await app.init();

      const response = await adapter.fetch("/health");
      const said = await response.text();

      expect(response.status).toBe(503);
      expect(said).not.toContain("127.0.0.1");
      expect(said).not.toContain("hunter2");
    }, 15_000);
  }

  it("requireWorkers on a driver that keeps no worker records reads as unknown, and is not down", async () => {
    const driver = new MemoryDriver();
    for (const method of [
      "registerWorker",
      "removeWorker",
      "listWorkers",
      "listQueueState",
    ] as const) {
      Object.defineProperty(driver, method, { value: undefined });
    }
    const booted = await boot({ driver, autoStart: false });
    await booted.queue.add("a", {});
    checked = { queues: ["emails"], requireWorkers: true };

    const { status, body } = await booted.endpoint();

    expect(status).toBe(200);
    expect(body.info.jobs).toMatchObject({
      status: "up",
      queues: { emails: { workers: "unknown" } },
    });
  });

  it("down within its timeout on a hung ping", async () => {
    const driver = new PingingDriver();
    const booted = await boot({ driver });
    driver.answer = async () => await new Promise<boolean>(() => {});
    checked = { timeout: 100 };
    const startedAt = Date.now();

    const { status, body } = await booted.endpoint();

    expect(status).toBe(503);
    expect(body.error.jobs?.message).toBe("The jobs health check failed");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  it("the default timeout is a second", async () => {
    const driver = new PingingDriver();
    const booted = await boot({ driver });
    driver.answer = async () => await new Promise<boolean>(() => {});
    const startedAt = Date.now();

    const result = await booted.indicator.isHealthy("jobs");

    expect(result.jobs?.status).toBe("down");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("down on a backlog above maxOutstanding, and up at it", async () => {
    const booted = await boot({ autoStart: false });
    await booted.queue.add("a", {});
    await booted.queue.add("b", {});

    checked = { queues: ["emails"], maxOutstanding: 2 };
    expect((await booted.endpoint()).status).toBe(200);

    checked = { queues: ["emails"], maxOutstanding: 1 };
    const { status, body } = await booted.endpoint();
    expect(status).toBe(503);
    expect(body.error.jobs?.message).toBe(
      '"emails" has more than 1 jobs outstanding',
    );
  });

  it("reads this application's queues by default, not another service's on the backend", async () => {
    const booted = await boot({ autoStart: false });
    await booted.jobs.queue("another-service").add("a", {});
    await booted.jobs.queue("another-service").add("b", {});
    checked = { maxOutstanding: 1 };

    const { status, body } = await booted.endpoint();

    expect(status).toBe(200);
    expect(Object.keys((body.info.jobs as { queues: object }).queues)).toEqual([
      "emails",
    ]);
  });

  it('queues: "all" reads every queue the backend knows, as an explicit choice', async () => {
    const booted = await boot({ autoStart: false });
    await booted.jobs.queue("another-service").add("a", {});
    await booted.jobs.queue("another-service").add("b", {});
    checked = { queues: "all", maxOutstanding: 1 };

    const { status, body } = await booted.endpoint();

    expect(status).toBe(503);
    expect(body.error.jobs?.message).toContain('"another-service"');
  });

  it('queues: "all" reads at most 100, and says how many it left out', async () => {
    const booted = await boot({ autoStart: false });
    for (let index = 0; index < 103; index++) {
      await booted.jobs
        .queue(`q${String(index).padStart(3, "0")}`)
        .add("a", {});
    }

    const result = await booted.indicator.isHealthy("jobs", {
      queues: "all",
      timeout: 5_000,
    });

    const jobs = result.jobs as unknown as {
      queues: object;
      queuesNotRead: number;
    };
    expect(Object.keys(jobs.queues)).toHaveLength(100);
    // 103, and "emails" is not among them until a job is added to it.
    expect(jobs.queuesNotRead).toBeGreaterThanOrEqual(3);
  });

  it("what a probe costs: one ping and one demand per queue, with no listing", async () => {
    const driver = new PingingDriver();
    const booted = await boot({
      driver,
      autoStart: false,
      imports: [
        BunJobsModule.registerQueue({ name: "a" }),
        BunJobsModule.registerQueue({ name: "b" }),
      ],
    });
    await booted.jobs.queue("another-service").add("x", {});
    const calls: Record<string, number> = {};
    for (const method of ["ping", "listQueues", "countDemand"] as const) {
      const original = (
        driver[method] as (...args: never[]) => Promise<unknown>
      ).bind(driver);
      Object.defineProperty(driver, method, {
        value: async (...args: never[]) => {
          calls[method] = (calls[method] ?? 0) + 1;
          return await original(...args);
        },
      });
    }

    const result = await booted.indicator.isHealthy("jobs");

    expect(
      Object.keys(
        (result.jobs as unknown as { queues: object }).queues,
      ).toSorted(),
    ).toEqual(["a", "b", "emails"]);
    expect(calls).toEqual({ ping: 1, countDemand: 3 });
  });

  it("many listed queues are read ten at a time", async () => {
    const driver = new PingingDriver();
    const booted = await boot({ driver, autoStart: false });
    let reading = 0;
    let most = 0;
    const original = driver.countDemand.bind(driver);
    Object.defineProperty(driver, "countDemand", {
      value: async (...args: Parameters<MemoryDriver["countDemand"]>) => {
        reading++;
        most = Math.max(most, reading);
        await Bun.sleep(5);
        const answer = await original(...args);
        reading--;
        return answer;
      },
    });
    const queues = Array.from({ length: 35 }, (_, index) => `q${index}`);

    const result = await booted.indicator.isHealthy("jobs", { queues });

    expect(result.jobs?.status).toBe("up");
    expect(most).toBe(10);
  });

  it("requireWorkers: down with demand and no worker; up with no demand, or a worker", async () => {
    const booted = await boot({ autoStart: false });
    checked = { queues: ["emails"], requireWorkers: true };

    expect((await booted.endpoint()).status).toBe(200);

    await booted.queue.add("a", {});
    const { status, body } = await booted.endpoint();
    expect(status).toBe(503);
    expect(body.error.jobs?.message).toBe(
      '"emails" has demand and no live worker',
    );

    await booted.app.get(BunJobsLifecycle, { strict: false }).start();
    await until(async () => (await booted.queue.getDemand()).outstanding === 0);
    await booted.queue.add("b", {});
    await until(async () => (await booted.endpoint()).status === 200);
  });

  it("without requireWorkers, demand and no worker is not down", async () => {
    const booted = await boot({ autoStart: false });
    await booted.queue.add("a", {});
    checked = { queues: ["emails"] };

    expect((await booted.endpoint()).status).toBe(200);
  });

  it("a worker this application never started does not count", async () => {
    const booted = await boot({ autoStart: false });
    checked = { queues: ["emails"] };

    expect((await booted.endpoint()).status).toBe(200);
  });

  it("a worker parked on purpose is up, and shown as parked; a resume clears it", async () => {
    const booted = await boot();
    const lifecycle = booted.app.get(BunJobsLifecycle, { strict: false });
    await until(async () => (await booted.endpoint()).status === 200);

    await lifecycle.stop();
    const parked = await booted.endpoint();
    expect(parked.status).toBe(200);
    expect(parked.body.info.jobs).toMatchObject({
      status: "up",
      parked: ["emails"],
    });

    await lifecycle.start();
    const resumed = await booted.endpoint();
    expect(resumed.status).toBe(200);
    expect(resumed.body.info.jobs).not.toHaveProperty("parked");
  });

  it("a worker parked directly, as remote control does, is the same", async () => {
    const booted = await boot();
    await booted.app
      .get(BunJobsRegistry, { strict: false })
      .workerRef(undefined, "emails")
      .worker.stop();

    const { status, body } = await booted.endpoint();

    expect(status).toBe(200);
    expect(body.info.jobs).toMatchObject({ parked: ["emails"] });
  });

  it("a worker that ended while the application did not is down", async () => {
    const booted = await boot();
    await booted.app
      .get(BunJobsRegistry, { strict: false })
      .workerRef(undefined, "emails")
      .worker.close();

    const { status, body } = await booted.endpoint();

    expect(status).toBe(503);
    expect(body.error.jobs?.message).toBe('The worker on "emails" has ended');
  });

  it("a worker whose connection failed at the start is down", async () => {
    const driver = new PingingDriver();
    let refuse = true;
    const ensureQueue = driver.ensureQueue.bind(driver);
    Object.defineProperty(driver, "ensureQueue", {
      value: async (...args: Parameters<MemoryDriver["ensureQueue"]>) => {
        if (refuse) {
          refuse = false;
          throw new Error("the worker's start failed");
        }
        await ensureQueue(...args);
      },
    });
    const booted = await boot({ driver });

    await until(async () => (await booted.endpoint()).status === 503);
    const { body } = await booted.endpoint();

    expect(body.error.jobs?.message).toBe('The worker on "emails" has ended');
  });

  it("only the listed queues' workers count", async () => {
    const booted = await boot();
    await booted.app
      .get(BunJobsRegistry, { strict: false })
      .workerRef(undefined, "emails")
      .worker.close();
    checked = { queues: ["other"] };

    expect((await booted.endpoint()).status).toBe(200);
  });

  it("a @DefineJob registry worker: running, then parked", async () => {
    @Injectable()
    class Defined {
      @DefineJob("double")
      double(@JobData("n") n: number) {
        return n * 2;
      }
    }

    const booted = await boot({ providers: [Defined] });
    const standing = () =>
      booted.app
        .get(BunJobsRegistry, { strict: false })
        .startableOf(undefined)!
        .workerStates();
    await until(async () => standing().length === 1);
    expect(standing()).toEqual([{ queue: "jobs", standing: "running" }]);
    const job = await booted.jobs.queue("jobs").add("double", { n: 21 });
    await until(
      async () =>
        (await booted.jobs.queue("jobs").getJob(job.id))?.state === "completed",
    );
    expect((await booted.endpoint()).status).toBe(200);

    await booted.app.get(BunJobsLifecycle, { strict: false }).stop();
    expect(standing()).toEqual([{ queue: "jobs", standing: "parked" }]);
    const parked = await booted.endpoint();
    expect(parked.status).toBe(200);
    expect(parked.body.info.jobs).toMatchObject({ parked: ["jobs"] });
  });

  it("a worker closing with the application is not a failure", async () => {
    const booted = await boot();
    const states = booted.app
      .get(BunJobsRegistry, { strict: false })
      .startableOf(undefined)!;
    await until(async () => states.workerStates().length === 1);

    const closing = booted.app.close();
    // The explorer's own hook has begun by the time the close has yielded once.
    await until(async () => states.workerStates().length === 0);
    await closing;

    expect(states.workerStates()).toEqual([]);
  });

  it("a context that is not there is down, and does not reject", async () => {
    const booted = await boot();
    checked = { context: "absent" };

    const { status, body } = await booted.endpoint();

    expect(status).toBe(503);
    expect(body.error.jobs?.message).toBe("The jobs health check failed");
  });

  it("a named context is the one read", async () => {
    const backlogged = new MemoryDriver();

    @Module({
      imports: [
        BunJobsModule.forRoot({
          name: "other",
          namespace: `health-${crypto.randomUUID()}`,
          driver: backlogged,
          logger: false,
          autoStart: false,
        }),
        BunJobsModule.forRoot({
          namespace: `health-${crypto.randomUUID()}`,
          driver: new MemoryDriver(),
          logger: false,
          autoStart: false,
        }),
        BunJobsHealthModule,
      ],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    cleanups.push(() => app.close());
    await app
      .get<BunJobs>(getBunJobsToken("other"), { strict: false })
      .queue("emails")
      .add("a", {});
    const indicator = app.get(BunJobsHealthIndicator, { strict: false });
    const options = { queues: ["emails"], maxOutstanding: 0 };

    expect((await indicator.isHealthy("jobs", options)).jobs?.status).toBe(
      "up",
    );
    expect(
      (await indicator.isHealthy("jobs", { ...options, context: "other" })).jobs
        ?.status,
    ).toBe("down");
  });
});
