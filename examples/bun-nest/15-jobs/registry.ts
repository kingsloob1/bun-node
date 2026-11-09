/**
 * bun-jobs' job registry through `@DefineJob`, asserted: the name is checked,
 * the definition's defaults reach every job of that name, `jobs.now()` and the
 * builder add it, and a name nobody defines is refused.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/registry.ts
 * ```
 *
 * The registry gives every job of a name its defaults (attempts, backoff,
 * timeout, per-name concurrency) wherever it is added from. Its Nest form is a
 * method decorator on any provider: at bootstrap the module calls
 * `jobs.define()` for each, and `jobs.start()` once. What it shows against
 * `@Process`:
 *
 * - **The handler is a method on a provider**, with its injected service, and
 *   the defaults are the decorator's: a job added with `jobs.now()` has
 *   `attempts: 5` and the backoff without the call site saying so, and a
 *   per-call option goes on top of them.
 * - **The builder** (`jobs.run(name, data).in("100ms").start()`) takes the
 *   same definition.
 * - **A name nobody defined is refused where it is added**, with a
 *   `ConfigError` (bun-jobs', not bun-common's: they are two classes).
 * - **A name defined twice** fails the boot, naming both methods.
 *
 * Not shown: a defined job lives on the registry queue (`registryQueue`,
 * `"jobs"` by default), where a job nothing defines stays a retryable
 * `ConfigError`, unlike a `@Processor` queue's dead-at-once unhandled name.
 * That is the package README's statement and is not checked here.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunQueueWorker, Job } from "@kingsleyweb/bun-jobs";
import { BunJobs, ConfigError as JobsConfigError } from "@kingsleyweb/bun-jobs";
import { BunJobsModule, DefineJob } from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";
import "reflect-metadata";

/** What a report job carries. */
interface Report {
  /** The month to report on. */
  month: string;
}

/** A service the handler needs: it is an ordinary provider. */
@Injectable()
class Tag {
  readonly tag = "tagged";
}

@Injectable()
class ReportJobs {
  /** The month each report was made for, in order. */
  readonly made: string[] = [];

  constructor(private readonly tag: Tag) {}

  @DefineJob("send-report", {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },
  })
  sendReport(job: Job<Report>) {
    this.made.push(job.data.month);
    return `${this.tag.tag}:${job.data.month}`;
  }
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-registry",
      driver: { type: "memory" },
      logger: false,
    }),
  ],
  providers: [Tag, ReportJobs],
})
class AppModule {}

title("@DefineJob: the registry on a provider");

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
  abortOnError: false,
});
try {
  const jobs = app.get(BunJobs);
  const reports = app.get(ReportJobs);
  /** The registry worker's results, by job id. */
  const results = new Map<string, unknown>();
  // `start()` is idempotent: the module has already started it.
  const registry = (await jobs.start()) as BunQueueWorker<unknown, unknown>;
  registry.on("completed", (job: Job, result: unknown) => {
    results.set(job.id, result);
  });

  step("jobs.now(): the name checked, the defaults applied");

  const may = await jobs.now("send-report", { month: "may" });
  checkEqual(
    "the definition's attempts and backoff reached the job",
    [may.opts.attempts, may.opts.backoff],
    [5, { type: "exponential", delay: 1_000 }],
  );
  await waitFor("the handler", () => results.has(may.id));
  checkEqual(
    "the method ran, with its injected service",
    results.get(may.id),
    "tagged:may",
  );

  const urgent = await jobs.now(
    "send-report",
    { month: "june" },
    { attempts: 2 },
  );
  checkEqual(
    "a per-call option wins, and the rest of the definition stays",
    [urgent.opts.attempts, urgent.opts.backoff],
    [2, { type: "exponential", delay: 1_000 }],
  );

  step("The builder takes the same definition");

  const later = await jobs
    .run<Report>("send-report", { month: "july" })
    .in("100ms")
    .start();
  await waitFor("the delayed job", () => results.has(later.id));
  checkEqual(
    "run().in() ran the same method",
    results.get(later.id),
    "tagged:july",
  );
  checkEqual("and the methods ran for all three", reports.made.toSorted(), [
    "july",
    "june",
    "may",
  ]);

  step("A name nobody defined is refused where it is added");

  const refused = await checkRejects(
    "jobs.now('send-fax')",
    () => jobs.now("send-fax", { to: "+1 555 0100" }),
    { message: /send-fax/ },
  );
  check(
    "as bun-jobs' ConfigError",
    refused instanceof JobsConfigError,
    refused?.name,
  );
} finally {
  await app.close();
}

step("A name defined twice fails the boot");

@Injectable()
class A {
  @DefineJob("x")
  x() {}
}

@Injectable()
class B {
  @DefineJob("x")
  y() {}
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-registry-twice",
      driver: { type: "memory" },
      logger: false,
    }),
  ],
  providers: [A, B],
})
class Twice {}

await checkRejects(
  "boot",
  () =>
    NestFactory.createApplicationContext(Twice, {
      logger: false,
      abortOnError: false,
    }),
  {
    name: "ConfigError",
    message: /job "x" is defined twice, by A\.x and B\.y/,
  },
);

summary();
