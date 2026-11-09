/**
 * A summoned worker in Nest, asserted: a queue registered with a summon
 * policy (`localCompute`), an application that adds a job, and a child process
 * that runs `runSummonedApplication`, drains the queue through DI and exits.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/summoned.ts
 * ```
 *
 * Two applications are involved, and the example is the first of them:
 *
 * 1. **The controller's side**: `registerQueue({ name: "emails", summon })`
 *    gives the queue a summon policy, and `@InjectSummonController("emails")`
 *    is how a provider asks it to act (`check()`, `status()`, `now()`).
 *    `localCompute` is the summoner that starts the worker as a child process
 *    on this machine (`maxUnits: 1`). Its triggers are all off, so the
 *    summon happens when the example calls `check()`, not on a timer.
 * 2. **The worker's side**, `helpers/summoned-worker.ts`: a Nest module, run
 *    by `runSummonedApplication(WorkerModule, { idleFor })`. It reads the
 *    summon from its arguments, builds the module with nothing started,
 *    runs the worker for the summoned queue until idle, **closes the context**
 *    so `onModuleDestroy` runs, and exits.
 *
 * Both share a **SQLite** file in a temporary directory (the memory driver
 * cannot be reached from another process). What is checked:
 *
 * - The summon starts, the job completes in a **different process**, and the
 *   processor's injected service ran.
 * - The context's `onModuleDestroy` ran **before** the process exited, and the
 *   process exited 0.
 * - **Another queue's job is not run**: the summon names `emails`, and a job
 *   added to `images` is still waiting afterwards.
 * - A process that was not summoned cannot call `runSummonedApplication`: it
 *   rejects rather than starting.
 *
 * `runSummoned` owns the process's signals, so the worker must not call
 * `enableShutdownHooks`. Decorators need the working directory's
 * `tsconfig.json` (oven-sh/bun#28605): `localCompute` is given `cwd` here, and
 * the example is run from `examples/bun-nest`.
 */
import type {
  BunQueue,
  SummonController,
  SummonPolicy,
} from "@kingsleyweb/bun-jobs";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { localCompute } from "@kingsleyweb/bun-jobs/provider";
import {
  BunJobsModule,
  getQueueToken,
  InjectSummonController,
  runSummonedApplication,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** The directory whose `tsconfig.json` enables decorators: this project's. */
const CWD = join(import.meta.dir, "..");

/** The lines of a log, once it exists. */
function linesOf(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

title("runSummonedApplication, summoned by localCompute");

const dir = await mkdtemp(join(tmpdir(), "bun-nest-summoned-"));
const driver = {
  type: "sql" as const,
  url: `sqlite://${join(dir, "jobs.db")}`,
};
const log = join(dir, "worker.log");

try {
  /** Holds the controller `@InjectSummonController` injects. */
  @Injectable()
  class Ops {
    constructor(
      @InjectSummonController("emails") readonly controller: SummonController,
    ) {}
  }

  const summon: SummonPolicy = {
    summoner: localCompute({
      entry: join(import.meta.dir, "helpers/summoned-worker.ts"),
      output: { file: join(dir, "units.log") },
      maxUnits: 1,
      shutdown: { graceMs: 2_000 },
      cwd: CWD,
    }),
    // Nothing summons on its own: the example calls `check()`.
    triggers: { onAdd: false, events: false, poll: false },
    cooldown: 0,
    // What the child needs to find the same backend and report back.
    env: { WORKER_DRIVER: JSON.stringify(driver), WORKER_LOG: log },
  };

  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: "examples-nest-summoned",
        driver,
        logger: false,
      }),
      BunJobsModule.registerQueue({ name: "emails", summon }),
    ],
    providers: [Ops],
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });

  try {
    /* -------------------------------------------------------------- */
    step("A job is added, and the controller summons a worker for it");

    const emails = app.get<BunQueue<{ name: string }, unknown>>(
      getQueueToken("emails"),
      { strict: false },
    );
    const job = await emails.add("welcome", { name: "ada" });
    // A job on another queue, which this summon does not name.
    const images = app.get(BunJobs).queue<unknown, unknown>("images");
    await images.add("resize", {});

    const outcome = await app.get(Ops).controller.check();
    checkEqual(
      "check() summoned a unit",
      [outcome.action, "outcome" in outcome ? outcome.outcome : undefined],
      ["summoned", "started"],
    );

    await waitFor("the worker process to exit", () =>
      linesOf(log).includes("exit 0"),
    );
    const lines = linesOf(log);
    show("the worker's log", lines);

    const ran = lines.find((line) => line.startsWith(`job ${job.id}`));
    check(
      "the processor ran, with its injected service",
      ran?.includes("hello ada") === true,
      lines,
    );
    check(
      "in another process",
      ran !== undefined && !ran.endsWith(`pid=${process.pid}`),
      ran,
    );
    check(
      "the context's onModuleDestroy ran before the process exited",
      lines.indexOf("destroyed") > 0 &&
        lines.indexOf("destroyed") < lines.indexOf("exit 0"),
      lines,
    );
    checkEqual(
      "the job is completed in the shared backend",
      (await emails.getJob(job.id))?.state,
      "completed",
    );
    checkEqual(
      "the other queue's job was not run: it is still waiting",
      (await images.count()).waiting,
      1,
    );
  } finally {
    await app.close();
  }

  /* ---------------------------------------------------------------- */
  step("A process that was not summoned cannot run it");

  @Module({})
  class Empty {}

  await checkRejects(
    "runSummonedApplication",
    () => runSummonedApplication(Empty),
    { message: /this process was not summoned/ },
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}

summary();
