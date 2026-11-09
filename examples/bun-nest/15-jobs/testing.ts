/**
 * Testing jobs without a worker process, asserted: `BunJobsTestingModule`,
 * `runJob` and `drainJobs` from `@kingsleyweb/bun-nest/jobs/testing`, with
 * Nest's own overrides, and beside `adapter.fetch()` for the HTTP side.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/testing.ts
 * ```
 *
 * This is a script that does what a test file does, with the same `check()`
 * calls the other examples use in place of `expect`:
 *
 * - **`runJob(app, queue, name, data)`** adds a real job, starts that queue's
 *   worker if it is stopped, and answers once the job settles, through the real
 *   pipeline. A job that fails is an **outcome** (`state: "dead"`, with its
 *   `error` and `attempts`), not a rejection.
 * - **`BunJobsTestingModule.forRoot()`** is the jobs module on a memory
 *   driver, a namespace unique to the call, workers not started until a
 *   helper asks. Two applications built in one process cannot meet.
 * - **`overrideGuard` reaches the job.** The same `FlagGuard` that kills a
 *   job in one test is replaced in another and the job completes.
 * - **`overrideProvider(getQueueToken(...))`** swaps a queue for a fake.
 * - **`drainJobs`** runs workers until nothing is left, for a flow or a
 *   fan-out: an HTTP request (through `adapter.fetch` with a
 *   `remoteAddress`, no port) enqueues, the job enqueues a second, and the
 *   drain answers both, in the order they settled.
 *
 * `@nestjs/testing` is a devDependency of bun-nest and resolves from the
 * repository's `node_modules`; a project of your own installs it.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunQueue, Job } from "@kingsleyweb/bun-jobs";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BunJobsExecutionContext,
  BunJobsModule,
  getQueueToken,
  InjectQueue,
  JobData,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import {
  BunJobsTestingModule,
  drainJobs,
  runJob,
} from "@kingsleyweb/bun-nest/jobs/testing";
import {
  Controller,
  Injectable,
  Module,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import "reflect-metadata";

/** A feature flag read off the job: the guard under test. */
@Injectable()
class FlagGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const job = BunJobsExecutionContext.create(context).getJob() as Job<{
      enabled?: boolean;
    }>;
    return job.data.enabled !== false;
  }
}

/** The code under test: a processor with a guard, a failing name and a fan-out. */
@Processor("emails")
@UseGuards(FlagGuard)
class EmailService {
  constructor(@InjectQueue("receipts") private readonly receipts: BunQueue) {}

  @Process("welcome")
  async welcome(@JobData("to") to: string) {
    await this.receipts.add("receipt", { to });
    return `sent:${to}`;
  }

  @Process("broken")
  broken(): never {
    throw new Error("the mail server is down");
  }
}

/** The fan-out's far end. */
@Processor("receipts")
class Receipts {
  /** Recipients receipted, in order. */
  static readonly stored: string[] = [];

  @Process("receipt")
  receipt(@JobData("to") to: string) {
    Receipts.stored.push(to);
    return `receipt:${to}`;
  }
}

/** Signing up: the HTTP side, which adds a job with the caller's address. */
@Controller("signups")
class Signups {
  constructor(@InjectQueue("emails") private readonly emails: BunQueue) {}

  @Post()
  async create(@Req() req: { ip?: string }) {
    const { id } = await this.emails.add("welcome", { to: req.ip });
    return { id };
  }
}

/** The module under test: the queues, processors and controller, and no `forRoot`. */
@Module({
  imports: [
    BunJobsModule.registerQueue({ name: "emails" }, { name: "receipts" }),
  ],
  providers: [EmailService, Receipts],
  controllers: [Signups],
})
class ShopModule {}

/** A testing module with the jobs context a test leaves to `BunJobsTestingModule`. */
function testing() {
  return Test.createTestingModule({
    imports: [BunJobsTestingModule.forRoot(), ShopModule],
    // Nest logs every unfiltered job error with its stack, once per attempt:
    // this run fails jobs on purpose, so it is kept quiet.
  }).setLogger({ log: () => {}, warn: () => {}, error: () => {} });
}

title("BunJobsTestingModule, runJob and drainJobs");

/* ------------------------------------------------------------------ */
step("runJob: an outcome through the real pipeline");

{
  const app = await (await testing().compile()).init();
  const done = await runJob(app, "emails", "welcome", {
    to: "ada@example.com",
  });
  checkEqual(
    "completed, with the handler's result",
    [done.state, done.result],
    ["completed", "sent:ada@example.com"],
  );
  checkEqual("on its first attempt", done.attempts, 1);

  const broken = await runJob(app, "emails", "broken", {}, { attempts: 2 });
  checkEqual(
    "a failing job is an outcome, not a rejection: dead",
    broken.state,
    "dead",
  );
  checkEqual("after both attempts (backoff is 0 in tests)", broken.attempts, 2);
  checkEqual(
    "with its error",
    broken.error?.message,
    "the mail server is down",
  );

  const denied = await runJob(
    app,
    "emails",
    "welcome",
    { enabled: false },
    { attempts: 3 },
  );
  checkEqual("the guard denies: dead", denied.state, "dead");
  checkEqual(
    "after one attempt of three: a retry would ask the same guard",
    denied.attempts,
    1,
  );
  await app.close();
}

/* ------------------------------------------------------------------ */
step("Overrides are plain Nest, and reach the job's pipeline");

{
  const app = await (
    await testing()
      .overrideGuard(FlagGuard)
      .useValue({ canActivate: () => true })
      .compile()
  ).init();
  const allowed = await runJob(app, "emails", "welcome", { enabled: false });
  checkEqual(
    "with overrideGuard, the same job the guard killed completes",
    allowed.state,
    "completed",
  );
  await app.close();
}

{
  const added: [string, unknown][] = [];
  const fake = {
    add: (name: string, data: unknown) => {
      added.push([name, data]);
      return Promise.resolve({ id: "fake-1" });
    },
  };
  const app = await (
    await testing()
      .overrideProvider(getQueueToken("receipts"))
      .useValue(fake)
      .compile()
  ).init();
  const done = await runJob(app, "emails", "welcome", {
    to: "fake@example.com",
  });
  checkEqual(
    "overrideProvider on a queue token: the handler used the fake",
    [done.state, added],
    ["completed", [["receipt", { to: "fake@example.com" }]]],
  );
  await app.close();
}

/* ------------------------------------------------------------------ */
step("drainJobs beside adapter.fetch(): no port, a fan-out run to the end");

{
  const adapter = new BunHttpAdapter();
  const app = (await testing().compile()).createNestApplication(adapter);
  await app.init();

  const response = await adapter.fetch("/signups", {
    method: "POST",
    remoteAddress: "10.0.0.4",
  });
  checkEqual(
    "the request, from a peer address the test chose",
    response.status,
    201,
  );

  const settled = await drainJobs(app, { queues: ["emails", "receipts"] });
  checkEqual(
    "the drain answers the job and the one it fanned out, in the order they settled",
    settled.map((job) => [job.name, job.returnValue]),
    [
      ["welcome", "sent:10.0.0.4"],
      ["receipt", "receipt:10.0.0.4"],
    ],
  );
  check(
    "and the far end ran",
    Receipts.stored.includes("10.0.0.4"),
    Receipts.stored,
  );
  checkEqual(
    "a second drain has nothing new to report",
    await drainJobs(app),
    [],
  );
  await app.close();
}

summary();
