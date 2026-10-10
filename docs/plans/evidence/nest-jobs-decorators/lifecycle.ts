/**
 * Q: When should the integration drain its workers on `app.close()`, so a job
 * in flight finishes before the services it uses are torn down?
 *
 * Nest's close is onModuleDestroy -> beforeApplicationShutdown -> dispose ->
 * onApplicationShutdown, each walked over modules by distance, and global
 * modules have the largest distance. A job takes 300 ms and uses a "database"
 * whose service closes it in onModuleDestroy. app.close() is called 50 ms into
 * the job. Each scenario says where the drain runs and where the database
 * lives; the job either completes or fails because the database was closed
 * under it.
 *
 * Run: bun lifecycle.ts
 */
import "reflect-metadata";
import type { OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { BunJobs, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { ProtoOptions } from "./proto";
import { Explorer, JobData, Process, Processor, ProtoJobsModule, until } from "./proto";

let trace: string[] = [];
const say = (line: string) => trace.push(line);

@Injectable()
class Db implements OnModuleInit, OnModuleDestroy {
  closed = false;
  onModuleInit() { say("Db.onModuleInit: connected"); }
  onModuleDestroy() { this.closed = true; say("Db.onModuleDestroy: connection closed"); }
  async query(what: string) {
    if (this.closed) throw new Error("database is closed");
    return `row for ${what}`;
  }
}

@Processor("work")
class WorkProcessor implements OnApplicationBootstrap {
  constructor(@Inject(Db) private readonly db: Db) {}
  onApplicationBootstrap() { say("WorkProcessor.onApplicationBootstrap"); }
  @Process()
  async handle(@JobData() data: { key: string }) {
    say("job: started");
    await Bun.sleep(300);
    const row = await this.db.query(data.key);
    say("job: finished");
    return row;
  }
}

@Module({ providers: [Db], exports: [Db] })
class DbModule {}
@Global()
@Module({ providers: [Db], exports: [Db] })
class GlobalDbModule {}

interface Scenario {
  title: string;
  drainIn: ProtoOptions["drainIn"];
  jobsGlobal: boolean;
  db: "same-module" | "imported-module" | "global-module";
}

async function run(s: Scenario): Promise<string> {
  trace = [];
  const jobs = new BunJobs({ namespace: `nestjobs-lifecycle-${crypto.randomUUID()}`, driver: new MemoryDriver() });

  @Module({
    imports: s.db === "imported-module" ? [DbModule] : [],
    providers: s.db === "same-module" ? [Db, WorkProcessor] : [WorkProcessor],
  })
  class FeatureModule {}

  @Module({
    imports: [
      ProtoJobsModule.forRoot({ jobs, drainIn: s.drainIn, trace: say }, s.jobsGlobal),
      ...(s.db === "global-module" ? [GlobalDbModule] : []),
      FeatureModule,
    ],
  })
  class AppModule {}

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  const [worker] = app.get(Explorer).workers;
  let outcome = "pending";
  worker!.on("completed", () => { outcome = "completed"; });
  worker!.on("failed", (_job, error) => { outcome = `failed: ${error.message}`; });
  await jobs.queue("work").add("x", { key: "a" });
  await until(() => trace.includes("job: started"));
  await Bun.sleep(50);
  say("app.close() called");
  await app.close();
  await jobs.close();
  return outcome;
}

const scenarios: Scenario[] = [
  { title: "A. drain in the jobs module's onModuleDestroy; jobs module global; Db in the processor's module", drainIn: "onModuleDestroy", jobsGlobal: true, db: "same-module" },
  { title: "B. drain in beforeApplicationShutdown; Db in a module the feature imports", drainIn: "beforeApplicationShutdown", jobsGlobal: true, db: "imported-module" },
  { title: "C. drain in the jobs module's onModuleDestroy; jobs module global; Db in an imported module", drainIn: "onModuleDestroy", jobsGlobal: true, db: "imported-module" },
  { title: "D. drain in the jobs module's onModuleDestroy; jobs module NOT global; Db in an imported module", drainIn: "onModuleDestroy", jobsGlobal: false, db: "imported-module" },
  { title: "E. drain attached to the processor instance (its module's onModuleDestroy); Db in an imported module", drainIn: "processorModule", jobsGlobal: true, db: "imported-module" },
  { title: "F. drain attached to the processor instance; Db in the SAME module as the processor", drainIn: "processorModule", jobsGlobal: true, db: "same-module" },
  { title: "H. drain attached to the processor instance; Db in a @Global module", drainIn: "processorModule", jobsGlobal: true, db: "global-module" },
  { title: "G. drain in the jobs module's onModuleDestroy; Db in a @Global module", drainIn: "onModuleDestroy", jobsGlobal: true, db: "global-module" },
];

for (const s of scenarios) {
  const outcome = await run(s);
  console.log(`\n${s.title}\n  outcome: ${outcome}`);
  for (const line of trace) console.log(`  | ${line}`);
}
