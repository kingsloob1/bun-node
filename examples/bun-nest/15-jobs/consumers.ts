/**
 * Consumers in a Nest application, asserted: a `@Processor` on an ordinary
 * service with several `@Process(name)` methods, and `app.close()` draining a
 * job that is still running.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/consumers.ts
 * ```
 *
 * - **One worker per queue, a method per name.** `welcome` is called as
 *   `(job, ctx)`; `digest` reads its payload with `@JobData()`. Both live on
 *   a class that also has an ordinary method (`sendNow`) and an injected
 *   dependency, because a processor is just a provider.
 * - **A name nobody handles is dead at once** (`UnrecoverableJobError`): a
 *   `@Processor` queue belongs to this service, so no retry would find a
 *   handler.
 * - **`app.close()` drains.** The worker closes in `onModuleDestroy`, and
 *   `close()` waits (up to `shutdown.timeout`) for a job in flight rather than
 *   cutting it. The handler here depends on nothing the shutdown tears down,
 *   which keeps it clear of the same-module ordering caveat on Nest 11 (the
 *   package README's "starting and draining").
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { Job, ProcessorContext } from "@kingsleyweb/bun-jobs";
import { BunQueue } from "@kingsleyweb/bun-jobs";
import {
  BunJobsModule,
  InjectQueue,
  JobData,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { watchQueue } from "./helpers/outcomes";
import "reflect-metadata";

/** Where the processor writes what it did: an injected dependency. */
@Injectable()
class Mailbox {
  /** Every message "sent", in order. */
  readonly sent: string[] = [];
  /** Set by the slow job once it has started. */
  started = false;
  /** Set by the slow job when it finishes its work. */
  finished = false;
}

/** What an `emails` job carries. */
interface Email {
  /** The recipient. */
  to: string;
}

/** An ordinary service that is also a worker for the `emails` queue. */
@Processor("emails", { concurrency: 2 })
@Injectable()
class EmailService {
  constructor(private readonly mailbox: Mailbox) {}

  /** An ordinary method: no decorator, no job. */
  sendNow(to: string): void {
    this.mailbox.sent.push(`now:${to}`);
  }

  /** Called as `(job, ctx)`, with bun-jobs' own types. */
  @Process("welcome")
  welcome(job: Job<Email, string>, ctx: ProcessorContext) {
    check("ctx.signal is not aborted while a job runs", !ctx.signal.aborted);
    this.mailbox.sent.push(`welcome:${job.data.to}`);
    return `sent:${job.data.to}`;
  }

  /** Reads the payload by decorator; once one parameter is, all must be. */
  @Process("digest")
  digest(@JobData() data: Email) {
    this.mailbox.sent.push(`digest:${data.to}`);
    return `digest:${data.to}`;
  }

  /** Takes a while, so `app.close()` can arrive while it runs. */
  @Process("slow")
  async slow() {
    this.mailbox.started = true;
    await Bun.sleep(300);
    this.mailbox.finished = true;
    return "slow-done";
  }
}

/** A service that produces for it. */
@Injectable()
class Producer {
  constructor(@InjectQueue("emails") readonly emails: BunQueue<Email>) {}
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-consumers",
      driver: { type: "memory" },
      shutdown: { timeout: 10_000 },
    }),
    BunJobsModule.registerQueue({ name: "emails" }),
  ],
  providers: [Mailbox, EmailService, Producer],
})
class AppModule {}

title("Consumers: @Processor, @Process, and app.close() draining");

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
});
const { emails } = app.get(Producer);
const mailbox = app.get(Mailbox);
const watcher = watchQueue(app, "emails");

/* ------------------------------------------------------------------ */
step("Each name reaches its own method");

const welcome = await emails.add("welcome", { to: "ada@example.com" });
const digest = await emails.add("digest", { to: "grace@example.com" });
const first = await watcher.outcome(welcome.id);
const second = await watcher.outcome(digest.id);
checkEqual(
  "welcome completed with the method's result",
  first.result,
  "sent:ada@example.com",
);
checkEqual(
  "digest, reading @JobData(), completed with its result",
  second.result,
  "digest:grace@example.com",
);
checkEqual(
  "each method ran once, with the injected Mailbox",
  [...mailbox.sent].sort(),
  ["digest:grace@example.com", "welcome:ada@example.com"],
);

app.get(EmailService).sendNow("x@example.com");
check(
  "an ordinary method on the processor is still just a method",
  mailbox.sent.includes("now:x@example.com"),
);

/* ------------------------------------------------------------------ */
step("A name nobody handles is dead at once");

const stray = await emails.add(
  "unknown",
  { to: "nobody@example.com" },
  { attempts: 5 },
);
const strayOutcome = await watcher.outcome(stray.id);
checkEqual("state", strayOutcome.state, "dead");
checkEqual("one attempt of five: no retry", strayOutcome.attemptsMade, 1);
checkEqual(
  "as UnrecoverableJobError",
  strayOutcome.error?.name,
  "UnrecoverableJobError",
);

/* ------------------------------------------------------------------ */
step("app.close() waits for a job in flight");

const slow = await emails.add("slow", { to: "late@example.com" });
await waitFor("the slow job to start", () => mailbox.started);
show("the job is running; closing now");

const closing = app.close();
check("close() has not finished the job by cutting it", !mailbox.finished);
await closing;
check(
  "close() returned only after the job finished its work",
  mailbox.finished,
);
const drained = await watcher.outcome(slow.id);
checkEqual("and the job completed, not failed", drained.state, "completed");
checkEqual("with its result", drained.result, "slow-done");

summary();
