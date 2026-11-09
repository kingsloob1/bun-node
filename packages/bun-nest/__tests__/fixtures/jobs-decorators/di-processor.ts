/**
 * A processor file with DI inside it: `createProcessorContext` builds a Nest context in whatever
 * thread or process this runs in, and resolves a provider from it. It also holds a `@Processor`,
 * which must not start from here.
 */
import process from "node:process";
import { defineProcessor } from "@kingsleyweb/bun-jobs";
import { Inject, Injectable, Module } from "@nestjs/common";
import {
  BunJobsModule,
  createProcessorContext,
  getWorkerToken,
  Process,
  Processor,
} from "../../../lib/jobs/index";
import "reflect-metadata";

/** How many contexts this thread or process has built. */
let builds = 0;

@Injectable()
class Dependency {
  readonly value = "injected";
}

@Injectable()
class ResizeService {
  constructor(@Inject(Dependency) readonly dependency: Dependency) {
    builds += 1;
  }

  resize(name: string) {
    return `${this.dependency.value}:${name}`;
  }
}

@Processor("inner")
class Inner {
  @Process()
  run() {}
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "inner",
      driver: { type: "memory" },
      logger: false,
    }),
    BunJobsModule.registerQueue({ name: "inner" }),
  ],
  providers: [Dependency, ResizeService, Inner],
})
class ImagesWorkerModule {}

export default defineProcessor(async (job) => {
  const app = await createProcessorContext(ImagesWorkerModule, {
    logger: false,
  });
  const again = await createProcessorContext(ImagesWorkerModule);
  return {
    resized: app.get(ResizeService).resize(job.name),
    sameContext: app === again,
    builds,
    pid: process.pid,
    innerRunning: app.get<{ worker: { isRunning: boolean } }>(
      getWorkerToken("inner"),
      { strict: false },
    ).worker.isRunning,
  };
});
