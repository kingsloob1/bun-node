/**
 * Work off the main thread, asserted: `registerWorker` with a `child-process`
 * target, and `createProcessorContext` giving the processor file dependency
 * injection.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/off-thread.ts
 * ```
 *
 * A `@Process` method runs in the application's process, and any other
 * `target` on a `@Processor` is a `ConfigError`, since a function cannot be
 * sent to another process. Off-thread work is a processor **file**,
 * registered as a worker the module owns (`registerWorker`), so it starts and
 * drains with the others. A file has no Nest around it, so it builds a context
 * itself, with `createProcessorContext(Module)`, and resolves what it needs.
 * What is checked:
 *
 * - The job runs in **another process** (the file reports its `process.pid`).
 * - The file got **dependency injection**: it resolved `ResizeService`, which
 *   has an injected `Dependency`.
 * - **The context is built once per process**: a second call is the same
 *   object, and the service was constructed once. (bun-jobs starts a fresh
 *   process per attempt, so this is a cache within one attempt; a processor
 *   file pays the bootstrap on every attempt, a median of 115 to 130 ms
 *   measured on a trivial module. That figure is the package's and is not
 *   measured here.)
 * - **A `@Processor` class refuses a non-default target**, which is why the
 *   file form exists.
 *
 * The child's working directory must be one whose `tsconfig.json` enables
 * decorators (oven-sh/bun#28605), so the target sets `spawn.cwd`.
 */
import type { BunQueue } from "@kingsleyweb/bun-jobs";
import type { INestApplicationContext } from "@nestjs/common";
import { join } from "node:path";
import process from "node:process";
import {
  BunJobsModule,
  getQueueToken,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { watchQueue } from "./helpers/outcomes";
import "reflect-metadata";

title(
  "registerWorker: a child process, with DI through createProcessorContext",
);

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-off-thread",
      driver: { type: "memory" },
      logger: false,
    }),
    BunJobsModule.registerQueue({ name: "images" }),
    BunJobsModule.registerWorker({
      queue: "images",
      processor: new URL("./helpers/resize-processor.ts", import.meta.url),
      options: {
        target: {
          kind: "child-process",
          // The directory whose tsconfig turns decorators on.
          spawn: { cwd: join(import.meta.dir, "..") },
        },
        pollInterval: 20,
      },
    }),
  ],
})
class AppModule {}

step("A job runs in a child process, and the file resolves a service");

const app: INestApplicationContext = await NestFactory.createApplicationContext(
  AppModule,
  { logger: false, abortOnError: false },
);
try {
  const watcher = watchQueue(app, "images");
  const images = app.get<BunQueue>(getQueueToken("images"), { strict: false });
  const job = await images.add("thumb", {});
  const outcome = await watcher.outcome(job.id);

  checkEqual("the job completed", outcome.state, "completed");
  const result = outcome.result as {
    resized: string;
    sameContext: boolean;
    builds: number;
    pid: number;
  };
  show("the file answered", result);
  checkEqual(
    "it resolved ResizeService with its Dependency injected",
    result.resized,
    "injected:thumb",
  );
  check("in another process", result.pid !== process.pid, result.pid);
  checkEqual(
    "a second createProcessorContext is the same context",
    result.sameContext,
    true,
  );
  checkEqual("and the service was built once", result.builds, 1);
} finally {
  await app.close();
}

step("A @Processor class cannot name another target");

@Processor("elsewhere", { target: "worker-thread" })
class Method {
  @Process()
  run() {}
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-off-thread-refused",
      driver: { type: "memory" },
      logger: false,
    }),
  ],
  providers: [Method],
})
class Refused {}

await checkRejects(
  "boot",
  () =>
    NestFactory.createApplicationContext(Refused, {
      logger: false,
      abortOnError: false,
    }),
  { name: "ConfigError", message: /target "worker-thread" cannot apply/ },
);

summary();
