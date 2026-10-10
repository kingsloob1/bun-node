/**
 * Q: Can a processor be request-scoped — a fresh DI sub-tree per job, with
 * REQUEST resolving to the job — and what does that cost per job against a
 * singleton processor, through the whole pipeline (ExternalContextCreator)?
 *
 * Each processor handles N jobs on the memory driver at concurrency 8. The
 * handler does no work, so the difference is the per-job DI and wrapping.
 *
 * Run: bun scoped.ts [N]
 */
import "reflect-metadata";
import { BunJobs, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Inject, Injectable, Module, Scope } from "@nestjs/common";
import { NestFactory, REQUEST } from "@nestjs/core";
import { JobId, Process, Processor, ProtoJobsModule, until } from "./proto";

const N = Number(process.argv[2] ?? 2000);
const seen = { raw: 0, singleton: 0, scoped: 0, scopedInstances: new Set<unknown>(), requestIsJob: 0 };

/** A request-scoped helper: one per job, and it can see the job as REQUEST. */
@Injectable({ scope: Scope.REQUEST })
class JobAudit {
  constructor(@Inject(REQUEST) readonly job: { id: string; name: string }) {}
}

@Processor("singleton", { concurrency: 8 })
class SingletonProcessor {
  @Process()
  handle(@JobId() _id: string) {
    seen.singleton++;
  }
}

@Processor("scoped", { concurrency: 8, scope: Scope.REQUEST })
class ScopedProcessor {
  constructor(@Inject(JobAudit) private readonly audit: JobAudit) {}
  @Process()
  handle(@JobId() id: string) {
    seen.scoped++;
    seen.scopedInstances.add(this);
    if (this.audit.job.id === id) seen.requestIsJob++;
  }
}

const jobs = new BunJobs({ namespace: `nestjobs-scoped-${crypto.randomUUID()}`, driver: new MemoryDriver() });

@Module({
  imports: [ProtoJobsModule.forRoot({ jobs })],
  providers: [SingletonProcessor, ScopedProcessor, JobAudit],
})
class AppModule {}

const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
await app.init();

// The baseline: a plain bun-jobs worker, no Nest in the path.
void jobs.worker("raw", () => { seen.raw++; }, { concurrency: 8 }).run();

async function time(queue: "raw" | "singleton" | "scoped") {
  const q = jobs.queue(queue);
  await q.addBulk(Array.from({ length: 50 }, (_, i) => ({ name: "warm", data: { i } })));
  await until(() => seen[queue] >= 50, 20_000);
  const before = seen[queue];
  const started = performance.now();
  await q.addBulk(Array.from({ length: N }, (_, i) => ({ name: "x", data: { i } })));
  await until(() => seen[queue] >= before + N, 60_000);
  return performance.now() - started;
}

console.log(`N=${N} jobs each, memory driver, concurrency 8, Bun ${Bun.version}; three rounds`);
for (let round = 1; round <= 3; round++) {
  const raw = await time("raw");
  const singleton = await time("singleton");
  const scoped = await time("scoped");
  const us = (ms: number) => `${ms.toFixed(0)} ms (${((ms / N) * 1000).toFixed(0)} µs/job)`;
  console.log(`round ${round}: plain worker ${us(raw)} | singleton @Processor ${us(singleton)} | request-scoped @Processor ${us(scoped)}`);
}
console.log(`scoped: distinct instances ${seen.scopedInstances.size} for ${seen.scoped} jobs; REQUEST was the job in ${seen.requestIsJob} of them`);
await app.close();
await jobs.close();
