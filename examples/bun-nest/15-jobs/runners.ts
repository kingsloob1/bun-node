/**
 * Runners in a Nest application, asserted: `registerRunner`, `@InjectRunner`
 * and `@OnRunnerEvent`.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/runners.ts
 * ```
 *
 * A `BunRunner` runs a **file**, on a schedule or on demand, so a method on a
 * provider cannot be its handler and a runner has no decorator: it is
 * registered. This runs the file in the application's own process
 * (`executionMode: "in-process"`), the cheapest of the modes, on the memory
 * driver. What is checked:
 *
 * - **Registered and started.** `registerRunner` puts the runner in the
 *   context's manager and starts it at bootstrap; `@InjectRunner("sweep")` is
 *   the same object as `jobs.runners.get("sweep")`.
 * - **`@OnRunnerEvent`** hears a run's `finished` with its result and a
 *   run's `failed` with its error. A method naming a runner that does not
 *   exist at bootstrap fails the boot, which is the last check.
 * - **`autoStart: false`** leaves it stopped until `BunJobsLifecycle.start()`,
 *   and `stop()` stops it again.
 * - **`app.close()` stops it.**
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunRunner } from "@kingsleyweb/bun-jobs";
import type { SweepArgs } from "./helpers/sweep";
import type { INestApplicationContext } from "@nestjs/common";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import {
  BunJobsLifecycle,
  BunJobsModule,
  InjectRunner,
  OnRunnerEvent,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** The runner's file, resolved from here. */
const SWEEP = new URL("./helpers/sweep.ts", import.meta.url);

/** Injects the runner, and listens to it. */
@Injectable()
class Ops {
  /** What the runner's events said, in order. */
  readonly heard: string[] = [];

  constructor(
    @InjectRunner("sweep") readonly sweep: BunRunner<SweepArgs, string>,
  ) {}

  /** A run's `(run, result)`. */
  @OnRunnerEvent("sweep", "finished")
  finished(_run: unknown, result: unknown) {
    this.heard.push(`finished ${String(result)}`);
  }

  /** A run's `(run, error)`. */
  @OnRunnerEvent("sweep", "failed")
  failed(_run: unknown, error: Error) {
    this.heard.push(`failed ${error.message}`);
  }
}

/** One application: the runner registered, `autoStart` as given. */
function application(autoStart: boolean) {
  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: `examples-nest-runners-${crypto.randomUUID().slice(0, 8)}`,
        driver: { type: "memory" },
        autoStart,
      }),
      BunJobsModule.registerRunner({
        id: "sweep",
        file: SWEEP,
        executionMode: "in-process",
        args: {},
      }),
    ],
    providers: [Ops],
  })
  class AppModule {}
  return NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
}

title("Runners: registerRunner, @InjectRunner and @OnRunnerEvent");

/* ------------------------------------------------------------------ */
step("Registered and started at bootstrap");

const app: INestApplicationContext = await application(true);
const ops = app.get(Ops);
const jobs = app.get(BunJobs);
check(
  "@InjectRunner is the runner the context's manager holds",
  jobs.runners.get("sweep") === ops.sweep,
);
checkEqual("started at bootstrap", ops.sweep.status, "running");
const first = await ops.sweep.trigger();
checkEqual("a trigger starts a run", first.outcome, "started");
await waitFor("the finished event", () => ops.heard.length >= 1);
checkEqual(
  "@OnRunnerEvent heard it finish, with the file's result",
  ops.heard,
  ["finished swept"],
);

step("A failing run is heard as failed");

await ops.sweep.trigger({ args: { fail: true } });
await waitFor("the failed event", () => ops.heard.length >= 2);
checkEqual(
  "and `failed` carries the file's error",
  ops.heard[1],
  "failed the sweep failed",
);

await app.close();
checkEqual("app.close() stopped the runner", ops.sweep.status, "stopped");

/* ------------------------------------------------------------------ */
step("autoStart: false, and the lifecycle");

const parked = await application(false);
const lifecycle = parked.get(BunJobsLifecycle, { strict: false });
const idle = parked.get(Ops).sweep;
checkEqual("never started at bootstrap", idle.status, "idle");
await lifecycle.start();
check(
  "BunJobsLifecycle.start() starts it",
  idle.status !== "stopped",
  idle.status,
);
await lifecycle.stop();
checkEqual("and stop() stops it again", idle.status, "stopped");
await parked.close();

/* ------------------------------------------------------------------ */
step("A listener naming a runner that does not exist fails the boot");

@Injectable()
class Missing {
  @OnRunnerEvent("nope", "failed")
  failed() {}
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-runners-missing",
      driver: { type: "memory" },
    }),
  ],
  providers: [Missing],
})
class NoRunner {}

await checkRejects(
  "boot",
  () =>
    NestFactory.createApplicationContext(NoRunner, {
      logger: false,
      abortOnError: false,
    }),
  {
    message:
      /@OnRunnerEvent names runner "nope", which does not exist by bootstrap/,
  },
);

summary();
