/**
 * The health indicator on real backends: the file and SQLite drivers always, and Redis,
 * Postgres, MySQL, MariaDB and MongoDB when `BUN_JOBS_TEST_*_URL` names a server. A backend
 * with no URL skips visibly; a URL that cannot be reached fails, as bun-jobs' suites do.
 *
 * Each case reads what the plan needs a backend to answer: that a live worker is counted, so
 * `requireWorkers` is not down for it; that it is down with demand and no worker, since this
 * driver keeps records; a backlog; and a parked worker.
 */
import type { BunJobs, DriverConfig } from "@kingsleyweb/bun-jobs";
import type { INestApplicationContext } from "@nestjs/common";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createDriver } from "@kingsleyweb/bun-jobs";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunJobsLifecycle,
  BunJobsModule,
  getBunJobsToken,
  Process,
  Processor,
} from "../lib/jobs/index";
import {
  BunJobsHealthIndicator,
  BunJobsHealthModule,
} from "../lib/jobs/terminus/index";
import "reflect-metadata";

const dir = mkdtempSync(join(tmpdir(), "bun-nest-terminus-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TABLES = "bun_jobs_test_";

/** Each backend, and its config when it can run. */
const BACKENDS: [string, DriverConfig | undefined][] = [
  ["file", { type: "file", root: join(dir, "file") }],
  [
    "sqlite",
    {
      type: "sql",
      url: `sqlite://${join(dir, "jobs.db")}`,
      tablePrefix: TABLES,
    },
  ],
  ...(
    [
      ["redis", "REDIS", (url: string) => ({ type: "redis", url })],
      [
        "postgres",
        "POSTGRES",
        (url: string) => ({
          type: "sql",
          url,
          adapter: "postgres",
          tablePrefix: TABLES,
        }),
      ],
      [
        "mysql",
        "MYSQL",
        (url: string) => ({
          type: "sql",
          url,
          adapter: "mysql",
          tablePrefix: TABLES,
        }),
      ],
      [
        "mariadb",
        "MARIADB",
        (url: string) => ({
          type: "sql",
          url,
          adapter: "mysql",
          tablePrefix: TABLES,
        }),
      ],
      ["mongodb", "MONGODB", (url: string) => ({ type: "mongodb", url })],
    ] as const
  ).map(([name, variable, config]): [string, DriverConfig | undefined] => {
    const url = process.env[`BUN_JOBS_TEST_${variable}_URL`];
    return [
      name,
      url === undefined ? undefined : (config(url) as DriverConfig),
    ];
  }),
];

const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

@Processor("emails", { reportInterval: 100, pollInterval: 20 })
class Emails {
  @Process()
  run() {
    return "sent";
  }
}

/** Boots an application on the backend; its namespace is purged after, and only that. */
async function boot(
  config: DriverConfig,
  autoStart: boolean,
): Promise<{
  app: INestApplicationContext;
  jobs: BunJobs;
  indicator: BunJobsHealthIndicator;
}> {
  const namespace = `health-${crypto.randomUUID().slice(0, 8)}`;

  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace,
        driver: config,
        logger: false,
        autoStart,
        shutdown: { timeout: 500 },
      }),
      BunJobsHealthModule,
    ],
    providers: [Emails],
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  cleanups.push(async () => {
    await app.close();
    const driver = createDriver(config);
    await driver.connect();
    await driver.purge(namespace);
    await driver.close();
  });
  return {
    app,
    jobs: app.get<BunJobs>(getBunJobsToken(), { strict: false }),
    indicator: app.get(BunJobsHealthIndicator, { strict: false }),
  };
}

/** Waits for a condition. */
async function until(condition: () => Promise<boolean>): Promise<void> {
  const by = Date.now() + 5_000;
  while (!(await condition()) && Date.now() < by) {
    await Bun.sleep(25);
  }
  expect(await condition()).toBe(true);
}

/** Long enough for a server's first connection, under load. */
const OPTIONS = { queues: ["emails"], timeout: 4_000 };

for (const [name, config] of BACKENDS) {
  const suite = config === undefined ? describe.skip : describe;

  suite(`the health indicator on ${name}`, () => {
    it("is up with a live worker counted, and requireWorkers holds", async () => {
      const { jobs, indicator } = await boot(config!, true);

      await until(
        async () => (await jobs.queue("emails").getDemand()).workers >= 1,
      );
      const result = await indicator.isHealthy("jobs", {
        ...OPTIONS,
        requireWorkers: true,
        maxOutstanding: 100,
      });

      expect(result.jobs).toMatchObject({
        status: "up",
        queues: { emails: { workers: 1 } },
      });
    }, 20_000);

    it("keeps worker records: down with demand and no worker, and on a backlog", async () => {
      const { jobs, indicator } = await boot(config!, false);
      await jobs.queue("emails").add("a", {});
      await jobs.queue("emails").add("b", {});

      const noWorker = await indicator.isHealthy("jobs", {
        ...OPTIONS,
        requireWorkers: true,
      });
      expect(noWorker.jobs).toMatchObject({
        status: "down",
        message: '"emails" has demand and no live worker',
        queues: { emails: { outstanding: 2, workers: 0 } },
      });
      expect((await jobs.queue("emails").listWorkers()).length).toBe(0);

      const backlog = await indicator.isHealthy("jobs", {
        ...OPTIONS,
        maxOutstanding: 1,
      });
      expect(backlog.jobs).toMatchObject({
        status: "down",
        message: '"emails" has more than 1 jobs outstanding',
      });
    }, 20_000);

    it("a parked worker is up, shown as parked", async () => {
      const { app, jobs, indicator } = await boot(config!, true);
      await until(
        async () => (await jobs.queue("emails").getDemand()).workers >= 1,
      );

      await app.get(BunJobsLifecycle, { strict: false }).stop();
      const result = await indicator.isHealthy("jobs", {
        ...OPTIONS,
        requireWorkers: true,
      });

      expect(result.jobs).toMatchObject({
        status: "up",
        parked: ["emails"],
      });
    }, 20_000);
  });
}
