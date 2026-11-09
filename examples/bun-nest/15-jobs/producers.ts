/**
 * Producers in a Nest application, asserted: `BunJobsModule.forRoot` (one
 * `BunJobs` context on the memory driver), `registerQueue`, `@InjectQueue` and
 * a typed `@QueueToken` class adding jobs.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/producers.ts
 * ```
 *
 * - **`forRoot`** builds the context (global by default). `@InjectBunJobs()`
 *   and the class `BunJobs` are the same object.
 * - **`registerQueue("emails")`** makes the queue injectable in the importing
 *   module: `@InjectQueue("emails")` is the real `BunQueue`.
 * - **A `@QueueToken` class** is the token and the type at once: the same
 *   `BunQueue` object arrives, and the compiler refuses a wrong payload or an
 *   undeclared name (the `@ts-expect-error` lines, proved by
 *   `bun scripts/typecheck.ts`). At run time nothing stops a cast, so the
 *   second half adds a job the type would refuse and the queue's `schema` is
 *   what refuses it.
 * - No worker runs here: the jobs just sit `waiting`, and the example reads
 *   them back.
 *
 * Decorators on constructor parameters need the working directory's
 * `tsconfig.json` (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import {
  BunJobs,
  BunQueue,
  JobDataValidationError,
} from "@kingsleyweb/bun-jobs";
import {
  BunJobsModule,
  getQueueToken,
  InjectBunJobs,
  InjectQueue,
  QueueToken,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { z } from "zod";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** What an `emails` job carries. */
interface Email {
  /** The recipient. */
  to: string;
}

/** What a `reports` job carries. */
interface Report {
  /** How many pages. */
  pages: number;
}

/**
 * The typed token for the `reports` queue: a named class extending `BunQueue`
 * with the payload and the job names it takes.
 */
@QueueToken("reports")
abstract class ReportsQueue extends BunQueue<Report, string, "monthly"> {}

/** A queue's payload schema: also checked at run time, at enqueue. */
const ReportSchema = z.object({ pages: z.number().int().positive() });

/** A service that only produces. */
@Injectable()
class Signup {
  constructor(
    /** The untyped, by-name queue. */
    @InjectQueue("emails") readonly emails: BunQueue<Email>,
    /** The same context as the class `BunJobs`. */
    @InjectBunJobs() readonly decorated: BunJobs,
    /** The typed queue, injected by its class. */
    readonly reports: ReportsQueue,
  ) {}

  /** Adds a welcome email. */
  welcome(to: string) {
    return this.emails.add("welcome", { to }, { attempts: 3 });
  }
}

@Module({
  imports: [
    BunJobsModule.registerQueue(
      {
        name: "emails",
        options: { defaultJobOptions: { attempts: 5 } },
      },
      { name: ReportsQueue, options: { schema: { data: ReportSchema } } },
    ),
  ],
  providers: [Signup],
})
class SignupModule {}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-producers",
      driver: { type: "memory" },
      autoStart: false,
    }),
    SignupModule,
  ],
})
class AppModule {}

title("Producers: forRoot, registerQueue, @InjectQueue, @QueueToken");

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
});

/* ------------------------------------------------------------------ */
step("One context, injected two ways");

const signup = app.get(Signup);
const byClass = app.get(BunJobs);
check("@InjectBunJobs() is the class BunJobs", signup.decorated === byClass);

/* ------------------------------------------------------------------ */
step("@InjectQueue(name) adds a job");

const welcome = await signup.welcome("ada@example.com");
const stored = await signup.emails.getJob(welcome.id);
checkEqual("the job is stored with its data", stored?.data, {
  to: "ada@example.com",
});
checkEqual("it is waiting: nothing consumes it", stored?.state, "waiting");
checkEqual(
  "the job's own attempts beat the queue default",
  stored?.opts.attempts,
  3,
);

const defaulted = await signup.emails.add("digest", {
  to: "grace@example.com",
});
checkEqual(
  "a job with none takes registerQueue's defaultJobOptions",
  (await signup.emails.getJob(defaulted.id))?.opts.attempts,
  5,
);

check(
  "getQueueToken('emails') is the same queue object",
  app.get(getQueueToken("emails"), { strict: false }) === signup.emails,
);

/* ------------------------------------------------------------------ */
step("A typed @QueueToken class");

check(
  "the token and @InjectQueue(ReportsQueue) give one BunQueue",
  app.get(getQueueToken("reports"), { strict: false }) === signup.reports,
);
check(
  "it is a real BunQueue, not an instance of the token class",
  !(signup.reports instanceof ReportsQueue),
);

const monthly = await signup.reports.add("monthly", { pages: 3 });
checkEqual(
  "a typed add stores the job",
  (await signup.reports.getJob(monthly.id))?.data,
  { pages: 3 },
);

// The compiler refuses both of these; `bun scripts/typecheck.ts` proves it.
// At run time only the queue's schema stands in the way of a wrong payload.
await checkRejects(
  "a wrong payload, forced past the compiler, is refused by the schema",
  // @ts-expect-error `pages` is a number
  () => signup.reports.add("monthly", { pages: "three" }),
  { name: JobDataValidationError.name },
);
// Nor is a name checked at run time: this queue declares only "monthly", the
// compiler refuses "yearly", and the job is stored all the same.
const waitingBefore = await signup.reports.count("waiting");
// @ts-expect-error "yearly" is not a name this queue declares
await signup.reports.add("yearly", { pages: 1 });
checkEqual(
  "an undeclared name, forced past the compiler, is NOT refused at run time",
  (await signup.reports.count("waiting")) - waitingBefore,
  1,
);
show("the compiler's refusals are the @ts-expect-error lines above");

await app.close();
summary();
