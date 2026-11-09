/**
 * `runSummonedApplication`, `createProcessorContext` and summon policies on `registerQueue`
 * (nest-jobs-decorators PR-n7). A summoned process is a real child, on SQLite, as bun-jobs' own
 * summon tests run it, and one case goes through a real `localCompute` summon end to end.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type {
  BunQueue,
  BunQueueWorker,
  DriverConfig,
  Job,
  SummonController,
  SummonPolicy,
} from "@kingsleyweb/bun-jobs";
import type { INestApplicationContext, Type } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  ConfigError,
  createDeferred,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { BunJobs, createDriver, defineSummoner } from "@kingsleyweb/bun-jobs";
import { localCompute } from "@kingsleyweb/bun-jobs/provider";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobsModule,
  getQueueToken,
  getWorkerToken,
  InjectSummonController,
  runSummonedApplication,
} from "../lib/jobs/index";
import "reflect-metadata";

const FIXTURES = `${import.meta.dir}/fixtures/jobs-decorators`;
const WORKER = `${FIXTURES}/summoned-worker.ts`;
const DI_PROCESSOR = `${FIXTURES}/di-processor.ts`;
/** This package, whose tsconfig turns decorators on: Bun reads the working directory's. */
const CWD = `${import.meta.dir}/..`;

/** Applications to close after each test, and anything else to undo. */
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A SQLite backend in a temporary directory, with a log file beside it. */
async function sqlite() {
  const dir = await mkdtemp(join(tmpdir(), "bun-nest-summon-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const driver: DriverConfig = {
    type: "sql",
    url: `sqlite://${join(dir, "jobs.db")}`,
  };
  return { dir, driver, log: join(dir, "log") };
}

/** Lines of a log, once it exists. */
function linesOf(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

/** A producer on the backend, closed afterwards. */
function producer(driver: DriverConfig, namespace: string) {
  const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
  cleanups.push(() => jobs.close());
  return jobs;
}

/** Runs the fixture as a summoned process; resolves when it has exited. */
async function runWorker(
  env: {
    driver: DriverConfig;
    log: string;
    namespace?: string;
    extra?: Record<string, string>;
  },
  args: string[],
  duringRun?: (child: Bun.Subprocess) => Promise<void>,
) {
  const child = Bun.spawn([process.execPath, WORKER, ...args], {
    cwd: CWD,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      PATH: process.env.PATH ?? "",
      FIXTURE_DRIVER: JSON.stringify(env.driver),
      FIXTURE_LOG: env.log,
      ...(env.namespace === undefined
        ? {}
        : { FIXTURE_NAMESPACE: env.namespace }),
      ...env.extra,
    },
  });
  // A test that fails must not leave one running.
  cleanups.push(async () => {
    child.kill("SIGKILL");
    await child.exited;
  });
  await duringRun?.(child);
  return await child.exited;
}

/** A module class with the given metadata. */
function moduleOf(metadata: Parameters<typeof Module>[0]): Type<unknown> {
  class AppModule {}
  Module(metadata)(AppModule);
  return AppModule;
}

/** Boots an application context that closes after the test. */
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

/** Waits for a condition, as a summon gives no event to wait on from here. */
async function until(
  condition: () => boolean | Promise<boolean>,
  withinMs = 30_000,
): Promise<boolean> {
  const by = Date.now() + withinMs;
  while (Date.now() < by) {
    if (await condition()) {
      return true;
    }
    await Bun.sleep(25);
  }
  return await condition();
}

describe("runSummonedApplication", () => {
  it("runs the summoned queue through DI and the pipeline, closes the context, then exits 0", async () => {
    const backend = await sqlite();
    const jobs = producer(backend.driver, "shop");
    const queue = jobs.queue<{ name: string }, unknown>("emails");
    const added = await queue.add("welcome", { name: "ada" });
    // Another queue's job: this summon does not name it.
    await jobs.queue<unknown, unknown>("images").add("resize", {});

    const code = await runWorker(backend, [
      "--bun-jobs-summon-id=attempt-1",
      "--bun-jobs-summon-namespace=shop",
      "--bun-jobs-summon-queue=emails",
    ]);

    expect(code).toBe(0);
    const lines = linesOf(backend.log);
    expect(lines[0]).toStartWith(`emails ${added.id} hello ada`);
    expect(lines.indexOf("destroyed")).toBeGreaterThan(0);
    expect(lines.at(-1)).toBe("exit 0");
    expect(lines.indexOf("destroyed")).toBeLessThan(lines.indexOf("exit 0"));
    expect(lines.some((line) => line.startsWith("images"))).toBe(false);
    expect((await queue.getJob(added.id))?.state).toBe("completed");
    expect((await jobs.queue<unknown, unknown>("images").count()).waiting).toBe(
      1,
    );
  }, 60_000);

  it("runs every queue of a group unit, one worker each", async () => {
    const backend = await sqlite();
    const jobs = producer(backend.driver, "shop");
    await jobs
      .queue<{ name: string }, unknown>("emails")
      .add("x", { name: "a" });
    await jobs.queue<unknown, unknown>("images").add("y", {});

    const code = await runWorker(backend, [
      "--bun-jobs-summon-id=attempt-2",
      "--bun-jobs-summon-namespace=shop",
      "--bun-jobs-summon-queue=emails",
      "--bun-jobs-summon-queue=images",
    ]);

    expect(code).toBe(0);
    const lines = linesOf(backend.log);
    expect(lines.some((line) => line.startsWith("emails"))).toBe(true);
    expect(lines.some((line) => line.startsWith("images"))).toBe(true);
  }, 60_000);

  it('"in-invocation" resolves with how it stopped, rather than exiting', async () => {
    const backend = await sqlite();
    const jobs = producer(backend.driver, "shop");
    await jobs
      .queue<{ name: string }, unknown>("emails")
      .add("x", { name: "a" });

    const code = await runWorker(backend, [
      "--bun-jobs-summon-id=attempt-3",
      "--bun-jobs-summon-namespace=shop",
      "--bun-jobs-summon-queue=emails",
      "--bun-jobs-summon-mode=in-invocation",
    ]);

    expect(code).toBe(0);
    const lines = linesOf(backend.log);
    expect(lines).toContain("returned idle 1");
    expect(lines.indexOf("destroyed")).toBeLessThan(
      lines.indexOf("returned idle 1"),
    );
  }, 60_000);

  it("a provider whose onModuleDestroy hangs is cut by the backstop, with the unit's code", async () => {
    const backend = await sqlite();

    const code = await runWorker(
      {
        ...backend,
        extra: {
          FIXTURE_DESTROY: "hang",
          FIXTURE_OPTIONS: JSON.stringify({ beforeExitTimeout: 300 }),
        },
      },
      [
        "--bun-jobs-summon-id=attempt-hang",
        "--bun-jobs-summon-namespace=shop",
        "--bun-jobs-summon-queue=emails",
      ],
    );

    expect(code).toBe(0);
    const lines = linesOf(backend.log);
    expect(lines).toContain("destroying");
    expect(lines).not.toContain("destroyed");
    expect(lines.join("\n")).toContain(
      "logged Summoned worker's beforeExit did not finish",
    );
    expect(lines.at(-1)).toBe("exit 0");
  }, 30_000);

  it("a signal during the context's close moves the backstop to the grace", async () => {
    const backend = await sqlite();
    let sent = 0;

    const code = await runWorker(
      {
        ...backend,
        extra: {
          FIXTURE_DESTROY: "hang",
          FIXTURE_OPTIONS: JSON.stringify({ beforeExitTimeout: 60_000 }),
        },
      },
      [
        "--bun-jobs-summon-id=attempt-signal",
        "--bun-jobs-summon-namespace=shop",
        "--bun-jobs-summon-queue=emails",
        "--bun-jobs-summon-grace-ms=1500",
      ],
      async (child) => {
        await until(() => linesOf(backend.log).includes("destroying"));
        sent = Date.now();
        child.kill("SIGTERM");
      },
    );

    expect(code).toBe(0);
    expect(linesOf(backend.log).join("\n")).toContain(
      "logged Summoned worker's beforeExit did not finish",
    );
    // Within the grace, not the minute its own timeout would have given it.
    expect(Date.now() - sent).toBeLessThan(1_250 + 5_000);
  }, 30_000);

  it("a close that fails is logged, and the exit keeps the unit's code", async () => {
    const backend = await sqlite();

    const code = await runWorker(
      { ...backend, extra: { FIXTURE_CLOSE: "reject" } },
      [
        "--bun-jobs-summon-id=attempt-throw",
        "--bun-jobs-summon-namespace=shop",
        "--bun-jobs-summon-queue=emails",
      ],
    );

    expect(code).toBe(0);
    const lines = linesOf(backend.log);
    expect(lines.join("\n")).toContain(
      "logged Summoned worker's beforeExit failed",
    );
    expect(lines.at(-1)).toBe("exit 0");
  }, 30_000);

  it("a beforeExit of the caller's own runs first, and the context closes though it rejects", async () => {
    const backend = await sqlite();

    const code = await runWorker(
      { ...backend, extra: { FIXTURE_HOOK: "reject" } },
      [
        "--bun-jobs-summon-id=attempt-hook",
        "--bun-jobs-summon-namespace=shop",
        "--bun-jobs-summon-queue=emails",
      ],
    );

    expect(code).toBe(0);
    const lines = linesOf(backend.log);
    expect(lines).toContain("own hook");
    expect(lines.indexOf("own hook")).toBeLessThan(lines.indexOf("destroyed"));
    expect(lines.join("\n")).toContain(
      "logged Summoned worker's beforeExit failed",
    );
  }, 30_000);

  it("exit: false goes straight to runSummoned: it returns, with the context closed", async () => {
    const backend = await sqlite();

    const code = await runWorker(
      { ...backend, extra: { FIXTURE_OPTIONS: '{"exit":false}' } },
      [
        "--bun-jobs-summon-id=attempt-noexit",
        "--bun-jobs-summon-namespace=shop",
        "--bun-jobs-summon-queue=emails",
      ],
    );

    expect(code).toBe(0);
    const lines = linesOf(backend.log);
    expect(lines).toContain("returned idle 0");
    expect(lines.indexOf("destroyed")).toBeLessThan(
      lines.indexOf("returned idle 0"),
    );
  }, 30_000);

  it("a close that fails in a refused start does not hide why it was refused", async () => {
    const backend = await sqlite();

    const code = await runWorker(
      { ...backend, extra: { FIXTURE_CLOSE: "reject" } },
      [
        "--bun-jobs-summon-id=attempt-refused",
        "--bun-jobs-summon-namespace=shop",
        "--bun-jobs-summon-queue=nope",
      ],
    );

    expect(code).toBe(3);
    const lines = linesOf(backend.log);
    expect(lines.join("\n")).toContain('names queue "nope"');
    expect(lines).toContain(
      "logged runSummonedApplication: closing the application failed",
    );
    expect(lines.join("\n")).not.toContain("threw Error");
  }, 30_000);

  it("refuses a queue the module has no processor for, naming it, and closes the context", async () => {
    const backend = await sqlite();

    const code = await runWorker(backend, [
      "--bun-jobs-summon-id=attempt-4",
      "--bun-jobs-summon-namespace=shop",
      "--bun-jobs-summon-queue=nope",
    ]);

    expect(code).toBe(3);
    const lines = linesOf(backend.log);
    expect(lines.join("\n")).toContain('names queue "nope"');
    expect(lines).toContain("destroyed");
  }, 60_000);

  it("refuses a namespace no context here consumes, though a processor has the queue's name", async () => {
    const backend = await sqlite();

    const code = await runWorker({ ...backend, namespace: "elsewhere" }, [
      "--bun-jobs-summon-id=attempt-5",
      "--bun-jobs-summon-namespace=shop",
      "--bun-jobs-summon-queue=emails",
    ]);
    expect(code).toBe(3);
    expect(linesOf(backend.log).join("\n")).toContain(
      'names queue "emails" in namespace "shop"',
    );
  }, 60_000);

  it("refuses a process that was not summoned", async () => {
    @Module({})
    class Empty {}

    await expect(runSummonedApplication(Empty)).rejects.toThrow(
      "this process was not summoned",
    );
  });

  it("through a real summon: registerQueue's policy, localCompute, and a child that drains and exits", async () => {
    const backend = await sqlite();
    const namespace = "summon-e2e";
    const units = join(backend.dir, "units.log");
    const injected = createDeferred<SummonController>();

    @Injectable()
    class Ops {
      constructor(
        @InjectSummonController("emails") controller: SummonController,
      ) {
        injected.resolve(controller);
      }
    }

    const summon: SummonPolicy = {
      summoner: localCompute({
        entry: WORKER,
        output: { file: units },
        maxUnits: 1,
        shutdown: { graceMs: 2_000 },
        cwd: CWD,
      }),
      triggers: { onAdd: false, events: false, poll: false },
      cooldown: 0,
      env: {
        FIXTURE_DRIVER: JSON.stringify(backend.driver),
        FIXTURE_LOG: backend.log,
      },
    };

    const app = await boot(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({
            namespace,
            driver: backend.driver,
            logger: false,
          }),
          BunJobsModule.registerQueue({ name: "emails", summon }),
        ],
        providers: [Ops],
      }),
    );
    const controller = await injected.promise;
    const queue = app.get<BunQueue<{ name: string }, unknown>>(
      getQueueToken("emails"),
      { strict: false },
    );
    const job = await queue.add("welcome", { name: "ada" });

    expect(await controller.check()).toMatchObject({
      action: "summoned",
      outcome: "started",
    });
    expect(await until(() => linesOf(backend.log).includes("exit 0"))).toBe(
      true,
    );
    const lines = linesOf(backend.log);
    expect(lines[0]).toStartWith(`emails ${job.id} hello ada`);
    expect(lines).toContain("destroyed");
    expect((await queue.getJob(job.id))?.state).toBe("completed");
  }, 90_000);
});

describe("createProcessorContext", () => {
  it("gives a child-process file DI, cached in that process, starting no worker inside it", async () => {
    const backend = await sqlite();
    const done = createDeferred<unknown>();

    const app = await boot(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({
            namespace: "files",
            driver: backend.driver,
            logger: false,
          }),
          BunJobsModule.registerQueue({ name: "images" }),
          BunJobsModule.registerWorker({
            queue: "images",
            processor: DI_PROCESSOR,
            options: {
              target: {
                kind: "child-process",
                spawn: { cwd: CWD },
              },
              pollInterval: 20,
            },
          }),
        ],
      }),
    );
    const worker = app.get<{ worker: BunQueueWorker<any, any, any> }>(
      getWorkerToken("images"),
      { strict: false },
    ).worker;
    worker.on("completed", (_job: Job, result: unknown) => {
      done.resolve(result);
    });
    worker.on("dead", (_job: Job, error: Error) => {
      done.resolve(error.message);
    });

    await app
      .get<BunQueue>(getQueueToken("images"), { strict: false })
      .add("thumb", {});

    const result = (await done.promise) as {
      resized: string;
      sameContext: boolean;
      builds: number;
      pid: number;
      innerRunning: boolean;
    };
    expect(result.resized).toBe("injected:thumb");
    expect(result.sameContext).toBe(true);
    expect(result.builds).toBe(1);
    expect(result.pid).not.toBe(process.pid);
    expect(result.innerRunning).toBe(false);
  }, 60_000);
});

describe("summon policies on registerQueue", () => {
  /** A summoner that starts nothing. */
  const summoner = defineSummoner({
    kind: "test",
    invoke: () => ({ handles: [] }) as never,
  });
  const policy = (): SummonPolicy => ({
    summoner,
    triggers: { onAdd: false, events: false, poll: false },
  });

  it("a queue given two policies, or one here and one in the summon option, fails the boot", async () => {
    const twice = await sqlite();
    expect(
      await bootProblem(
        moduleOf({
          imports: [
            BunJobsModule.forRoot({
              namespace: "s",
              driver: twice.driver,
              logger: false,
            }),
            BunJobsModule.registerQueue({ name: "q", summon: policy() }),
            moduleOf({
              imports: [
                BunJobsModule.registerQueue({ name: "q", summon: policy() }),
              ],
            }),
          ],
        }),
      ),
    ).toContain("given two summon policies");

    const both = await sqlite();
    expect(
      await bootProblem(
        moduleOf({
          imports: [
            BunJobsModule.forRoot({
              namespace: "s",
              driver: both.driver,
              logger: false,
              summon: { q: policy() },
            }),
            BunJobsModule.registerQueue({ name: "q", summon: policy() }),
          ],
        }),
      ),
    ).toContain("named by the context's summon option and by registerQueue");
  });

  it("@InjectSummonController reaches the summon option's, a queue with no policy is refused, and nothing is built unasked", async () => {
    const backend = await sqlite();

    @Injectable()
    class Ops {
      constructor(
        @InjectSummonController("q") readonly controller: SummonController,
      ) {}
    }

    const app = await boot(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({
            namespace: "s",
            driver: backend.driver,
            logger: false,
            summon: { q: policy() },
          }),
          BunJobsModule.registerQueue({ name: "q" }),
        ],
        providers: [Ops],
      }),
    );
    expect(app.get(Ops).controller).toBe(
      app.get<BunJobs>(BunJobs).summonController("q"),
    );

    const other = await sqlite();
    let refused: unknown;
    try {
      await NestFactory.createApplicationContext(
        moduleOf({
          imports: [
            BunJobsModule.forRoot({
              namespace: "s",
              driver: other.driver,
              logger: false,
            }),
            BunJobsModule.registerQueue({ name: "q" }),
          ],
          providers: [Ops],
        }),
        { logger: false, abortOnError: false },
      );
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain('No summon policy for queue "q"');

    // A queue with no policy, that nothing asks a controller for, is an ordinary queue.
    const plain = await sqlite();
    await boot(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({
            namespace: "s",
            driver: plain.driver,
            logger: false,
          }),
          BunJobsModule.registerQueue({ name: "q" }),
        ],
      }),
    );
  });

  it("a controller registerQueue built closes with the application, on a borrowed context too", async () => {
    const backend = await sqlite();
    const driver = createDriver(backend.driver);
    const jobs = new BunJobs({
      namespace: "s",
      driver,
      logger: noopLogger,
    });
    cleanups.push(() => jobs.close());

    const app = await NestFactory.createApplicationContext(
      moduleOf({
        imports: [
          BunJobsModule.forRoot({ jobs }),
          BunJobsModule.registerQueue({ name: "q", summon: policy() }),
        ],
      }),
      { logger: false, abortOnError: false },
    );
    const controller = jobs.summonController("q");
    let closed = false;
    const close = controller.close.bind(controller);
    controller.close = async () => {
      closed = true;
      await close();
    };
    await app.close();
    expect(closed).toBe(true);
  });
});
