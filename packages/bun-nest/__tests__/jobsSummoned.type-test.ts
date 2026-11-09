/**
 * What the types of the summoned, off-thread and remote surface catch. Checked by `bun run check`;
 * each `@ts-expect-error` is its own negative control (TS2578 when unused).
 */
import type { SummonController, SummonedExit } from "@kingsleyweb/bun-jobs";
import type { RemoteContext, RemoteJob } from "@kingsleyweb/bun-jobs/remote";
import type { INestApplicationContext } from "@nestjs/common";
import { defineSummoner } from "@kingsleyweb/bun-jobs";
import {
  BunJobsModule,
  BunRemoteExecutorModule,
  createProcessorContext,
  InjectSummonController,
  RemoteHandler,
  runSummonedApplication,
} from "../lib/jobs/index";

class WorkerModule {}

export const exit: Promise<SummonedExit> = runSummonedApplication(
  WorkerModule,
  {
    idleFor: 30_000,
    mode: "until-stopped",
    nest: { logger: false },
  },
);
export const badMode = runSummonedApplication(WorkerModule, {
  // @ts-expect-error -- not a mode
  mode: "forever",
});

export const context: Promise<INestApplicationContext> =
  createProcessorContext(WorkerModule);
export const quiet = createProcessorContext(WorkerModule, { logger: false });
// @ts-expect-error -- a module
export const notAModule = createProcessorContext("WorkerModule");

const summoner = defineSummoner({ kind: "test", invoke: () => ({}) as never });

BunJobsModule.registerQueue({ name: "q", summon: { summoner } });
BunJobsModule.registerQueueAsync({
  name: "q",
  useFactory: () => ({ summon: { summoner } }),
});
// @ts-expect-error -- a policy names its summoner
BunJobsModule.registerQueue({ name: "q", summon: {} });

export class Ops {
  constructor(
    @InjectSummonController("q") readonly controller: SummonController,
    @InjectSummonController("q", "billing") readonly billing: SummonController,
  ) {}
}
// @ts-expect-error -- a queue's name
InjectSummonController(1);

export class Handlers {
  @RemoteHandler("resize")
  resize(job: RemoteJob<{ url: string }>, ctx: RemoteContext) {
    return [job.data.url, ctx.attempt];
  }

  @RemoteHandler("guarded", {
    onDenied: "retry",
    onInvalid: "retry",
    enhancers: true,
  })
  guarded() {}
}
// @ts-expect-error -- a job's name
RemoteHandler(1);
// @ts-expect-error -- "fail" or "retry"
RemoteHandler("x", { onDenied: "drop" });

BunRemoteExecutorModule.forRoot({
  path: "/jobs",
  secret: "s",
  maxConcurrency: 4,
});
BunRemoteExecutorModule.forRootAsync({
  inject: ["CONFIG"],
  useFactory: (config: { secret: string }) => ({
    path: "/jobs",
    secret: config.secret,
  }),
});
// @ts-expect-error -- `path` is where it mounts
BunRemoteExecutorModule.forRoot({ secret: "s" });
// @ts-expect-error -- handlers come from @RemoteHandler
BunRemoteExecutorModule.forRoot({ path: "/j", secret: "s", handlers: {} });
