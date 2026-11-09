/**
 * `@kingsleyweb/bun-nest/jobs/terminus` (plan §9.8), through real terminus and a controller,
 * over the adapter with no socket. A health check's two answers are 200 and 503, so each case
 * reads both the indicator's result and what the endpoint says.
 */
import type { BunJobs, BunQueue } from "@kingsleyweb/bun-jobs";
import type { INestApplication, Type } from "@nestjs/common";
import { MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Controller, Get, Inject, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { HealthCheck, HealthCheckService } from "@nestjs/terminus";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunJobsLifecycle,
  BunJobsModule,
  getBunJobsToken,
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
    name?: string;
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

  it("the backlog is read across every queue when none are named", async () => {
    const booted = await boot({ autoStart: false });
    await booted.jobs.queue("other").add("a", {});
    await booted.jobs.queue("other").add("b", {});
    checked = { maxOutstanding: 1 };

    const { status, body } = await booted.endpoint();

    expect(status).toBe(503);
    expect(body.error.jobs?.message).toContain('"other"');
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

  it("down when a worker it started is stopped, and up again when it resumes", async () => {
    const booted = await boot();
    const lifecycle = booted.app.get(BunJobsLifecycle, { strict: false });
    await until(async () => (await booted.endpoint()).status === 200);

    await lifecycle.stop();
    const { status, body } = await booted.endpoint();
    expect(status).toBe(503);
    expect(body.error.jobs?.message).toBe('The worker on "emails" is stopped');

    await lifecycle.start();
    await until(async () => (await booted.endpoint()).status === 200);
  });

  it("only the listed queues' workers count", async () => {
    const booted = await boot();
    await booted.app.get(BunJobsLifecycle, { strict: false }).stop();
    checked = { queues: ["other"] };

    expect((await booted.endpoint()).status).toBe(200);
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
