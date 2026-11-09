/**
 * The entry a summoner starts: `runSummonedApplication` on a Nest module with processors on
 * `emails` and `images`, and a service each one injects. Its driver comes from `FIXTURE_DRIVER`,
 * and it appends what it does to `FIXTURE_LOG`, so a test can read the order: each job, the
 * service's `onModuleDestroy`, what the helper returned, what it logged at `error`, and the
 * exit code.
 *
 * `FIXTURE_DESTROY=hang`: the service's `onModuleDestroy` never returns, and holds the process
 * open. `FIXTURE_CLOSE=reject`: the context's `close()` rejects, which it does not do for a
 * provider's throw from Nest 12 on, so it is forced. `FIXTURE_HOOK=reject`: passes a
 * `beforeExit` that rejects.
 * `FIXTURE_OPTIONS`: JSON, more of `runSummonedApplication`'s options.
 */
import type { RunSummonedApplicationOptions } from "../../../lib/jobs/index";
import type { Job } from "@kingsleyweb/bun-jobs";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { summonedFromArgs } from "@kingsleyweb/bun-jobs";
import { Inject, Injectable, Module } from "@nestjs/common";
import { NestApplicationContext } from "@nestjs/core";
import {
  BunJobsModule,
  CurrentJob,
  JobData,
  Process,
  Processor,
  runSummonedApplication,
} from "../../../lib/jobs/index";
import "reflect-metadata";

/** Writes one line of the log. */
function note(line: string): void {
  appendFileSync(process.env.FIXTURE_LOG!, `${line}\n`);
}

process.on("exit", (code) => {
  note(`exit ${code}`);
});

if (process.env.FIXTURE_CLOSE === "reject") {
  NestApplicationContext.prototype.close = async () => {
    throw new Error("the close failed");
  };
}

/** What a processor injects: DI really ran. */
@Injectable()
class Greeter {
  greet(name: string): string {
    return `hello ${name}`;
  }

  async onModuleDestroy() {
    note("destroying");
    if (process.env.FIXTURE_DESTROY === "hang") {
      setInterval(() => {}, 1_000);
      await new Promise<never>(() => {});
    }
    note("destroyed");
  }
}

const options = { concurrency: 2, pollInterval: 20, reportInterval: 200 };

@Processor("emails", options)
class Emails {
  constructor(@Inject(Greeter) readonly greeter: Greeter) {}

  @Process()
  run(@JobData("name") name: string, @CurrentJob() job: Job) {
    note(`emails ${job.id} ${this.greeter.greet(name)} ${process.pid}`);
    return name;
  }
}

@Processor("images", options)
class Images {
  @Process()
  run(@CurrentJob() job: Job) {
    note(`images ${job.id}`);
  }
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace:
        process.env.FIXTURE_NAMESPACE ??
        summonedFromArgs()?.namespace ??
        "fixture",
      driver: JSON.parse(process.env.FIXTURE_DRIVER!) as {
        type: "sql";
        url: string;
      },
      logger: false,
    }),
  ],
  providers: [Greeter, Emails, Images],
})
class WorkerModule {}

try {
  const result = await runSummonedApplication(WorkerModule, {
    idleFor: 300,
    idleCheckInterval: 30,
    nest: { logger: false },
    logger: (event) => {
      if (event.level === "error") {
        note(`logged ${event.message}`);
      }
    },
    ...(process.env.FIXTURE_HOOK === "reject"
      ? {
          beforeExit: async () => {
            note("own hook");
            throw new Error("the hook rejected");
          },
        }
      : {}),
    ...(JSON.parse(
      process.env.FIXTURE_OPTIONS ?? "{}",
    ) as RunSummonedApplicationOptions),
  });
  note(`returned ${result.reason} ${result.completed}`);
} catch (error) {
  note(`threw ${(error as Error).name}: ${(error as Error).message}`);
  process.exit(3);
}
