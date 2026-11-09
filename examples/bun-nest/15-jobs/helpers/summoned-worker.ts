/**
 * The file a platform runs when it summons compute for `emails`, in
 * `summoned.ts` (`run-all.ts` skips `helpers/`): a Nest module with one
 * processor and a service it injects, run by `runSummonedApplication`.
 *
 * Its driver comes from `WORKER_DRIVER` (JSON) and it appends what it does to
 * the file `WORKER_LOG` names, so the process that summoned it can read the
 * order of events: each job with the process id it ran in, the service's
 * `onModuleDestroy`, and the exit code.
 */
import type { Job } from "@kingsleyweb/bun-jobs";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { summonedFromArgs } from "@kingsleyweb/bun-jobs";
import {
  BunJobsModule,
  CurrentJob,
  JobData,
  Process,
  Processor,
  runSummonedApplication,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import "reflect-metadata";

/** Appends one line to the log. */
function note(line: string): void {
  appendFileSync(process.env.WORKER_LOG!, `${line}\n`);
}

process.on("exit", (code) => {
  note(`exit ${code}`);
});

/** What the processor injects: dependency injection really ran here. */
@Injectable()
class Greeter {
  greet(name: string): string {
    return `hello ${name}`;
  }

  /** Runs when `runSummonedApplication` closes the context. */
  onModuleDestroy() {
    note("destroyed");
  }
}

@Processor("emails", { concurrency: 2, pollInterval: 20 })
class Emails {
  constructor(private readonly greeter: Greeter) {}

  @Process()
  run(@JobData("name") name: string, @CurrentJob() job: Job) {
    note(`job ${job.id} ${this.greeter.greet(name)} pid=${process.pid}`);
    return name;
  }
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      // The summon's own namespace, which is the controller's.
      namespace: summonedFromArgs()?.namespace ?? "not-summoned",
      driver: JSON.parse(process.env.WORKER_DRIVER!) as {
        type: "sql";
        url: string;
      },
      logger: false,
    }),
  ],
  providers: [Greeter, Emails],
})
class WorkerModule {}

// Exits the process itself when it is done, so nothing runs after this line.
await runSummonedApplication(WorkerModule, {
  // Exit once the queue has been empty for this long.
  idleFor: 300,
  idleCheckInterval: 30,
  nest: { logger: false },
});
