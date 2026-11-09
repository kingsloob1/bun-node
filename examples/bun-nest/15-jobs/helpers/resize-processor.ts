/**
 * A processor file for `off-thread.ts` (`run-all.ts` skips `helpers/`): it runs
 * wherever its target puts it, with no Nest around it, and builds a Nest
 * application context of its own with `createProcessorContext` to resolve a
 * service by dependency injection.
 */
import process from "node:process";
import { defineProcessor } from "@kingsleyweb/bun-jobs";
import { createProcessorContext } from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import "reflect-metadata";

/** How many contexts this process has built a service for. */
let builds = 0;

/** What the service depends on: injection is what is being shown. */
@Injectable()
class Dependency {
  readonly value = "injected";
}

@Injectable()
class ResizeService {
  constructor(private readonly dependency: Dependency) {
    builds += 1;
  }

  resize(name: string) {
    return `${this.dependency.value}:${name}`;
  }
}

@Module({ providers: [Dependency, ResizeService] })
class ImagesWorkerModule {}

export default defineProcessor(async (job) => {
  const app = await createProcessorContext(ImagesWorkerModule, {
    logger: false,
  });
  // Asked again, it is the same context, built once per process.
  const again = await createProcessorContext(ImagesWorkerModule);
  return {
    resized: app.get(ResizeService).resize(job.name),
    sameContext: app === again,
    builds,
    pid: process.pid,
  };
});
