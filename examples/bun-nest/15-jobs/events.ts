/**
 * Job events in a Nest application, asserted: `@OnWorkerEvent`,
 * `@OnQueueEvent`, `@OnJobsEvent` (across two processes) and
 * `@InjectJobsNotifier`.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/events.ts
 * ```
 *
 * bun-jobs has four event sources, and a decorator for each. This runs the
 * first three and the notifier, on the **file driver** in a temporary
 * directory, because the second process needs one both can open:
 *
 * | Decorator | Hears | Where |
 * |---|---|---|
 * | `@OnWorkerEvent(event)` | this process's worker for the class's queue | a `@Processor` class |
 * | `@OnQueueEvent(queue, event)` | that queue's emitter: local events, and other processes' published ones when the queue is registered with `subscribe: true` | any singleton |
 * | `@OnJobsEvent({ kind, type, target })` | every process's **published** events in the namespace | any singleton |
 * | `@InjectJobsNotifier()` | the same stream, as an object | injected |
 *
 * (`@OnRunnerEvent` is in `runners.ts`.)
 *
 * What is checked, and what is not:
 *
 * - A scoped form, `"completed:welcome"`, hears one job name only.
 * - **Nothing is heard that was never published.** A child process adds a job
 *   with `publishEvents: false`, then another with `true`; `@OnJobsEvent` hears
 *   the second alone. That is the negative control for the cross-process lines
 *   below: the example can see a silent process.
 * - A listener that throws is logged with its class and method, never
 *   rethrown, and the job it heard still completes.
 * - The application's own process publishes nothing here, so the module logs
 *   its one `warn` reminder at boot; this example checks that line.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunQueue, Job, JobsNotifier } from "@kingsleyweb/bun-jobs";
import type { JobsEventOf } from "@kingsleyweb/bun-nest/jobs";
import type { LoggerService } from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  BunJobsModule,
  InjectJobsNotifier,
  InjectQueue,
  OnJobsEvent,
  OnQueueEvent,
  OnWorkerEvent,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { watchQueue } from "./helpers/outcomes";
import "reflect-metadata";

/** Everything the listeners heard, in order, so the checks can read it. */
@Injectable()
class Heard {
  /** `@OnWorkerEvent` lines. */
  readonly worker: string[] = [];
  /** `@OnQueueEvent` lines. */
  readonly queue: string[] = [];
  /** The ids `@OnJobsEvent` heard `added`. */
  readonly jobs: string[] = [];
  /** The ids the injected notifier heard `added`. */
  readonly notifier: string[] = [];
}

/** What a `welcome` job carries: nothing the example reads. */
type Payload = Record<string, never>;

/** The `emails` worker, with listeners for its own events. */
@Processor("emails")
class EmailProcessor {
  constructor(private readonly heard: Heard) {}

  @Process("welcome")
  welcome() {
    return "welcomed";
  }

  @Process("digest")
  digest() {
    return "digested";
  }

  @Process("bad")
  bad(): never {
    throw new Error("bad job");
  }

  /** Every completed job: `(job, result)`, as a bun-jobs worker emits it. */
  @OnWorkerEvent("completed")
  completed(job: Job, result: unknown) {
    this.heard.worker.push(`completed ${job.name} ${String(result)}`);
  }

  /** Only a job named `welcome`. */
  @OnWorkerEvent("completed:welcome")
  welcomed(job: Job) {
    this.heard.worker.push(`welcomed ${job.id}`);
  }

  /** A job given up on. */
  @OnWorkerEvent("dead")
  dead(job: Job, error: Error) {
    this.heard.worker.push(`dead ${job.name} ${error.message}`);
  }

  /** A listener that throws: logged, and it touches nothing else. */
  @OnWorkerEvent("completed:digest")
  explodes(): never {
    throw new Error("a listener's bug");
  }
}

/** Listens on a queue's emitter and on the namespace's published stream. */
@Injectable()
class Audit {
  constructor(private readonly heard: Heard) {}

  /** The queue's `added`: this process's, and (with `subscribe`) others'. */
  @OnQueueEvent("emails", "added")
  queueAdded(job: Job) {
    this.heard.queue.push(job.id);
  }

  /** Published events only, from any process. */
  @OnJobsEvent({ kind: "queue", type: "added", target: "emails" })
  jobsAdded(event: JobsEventOf<"queue", "added">) {
    this.heard.jobs.push(event.payload.id);
  }
}

/** A provider that wants the stream as an object. */
@Injectable()
class Stream {
  constructor(
    @InjectJobsNotifier() readonly notifier: JobsNotifier,
    @InjectQueue("emails") readonly emails: BunQueue<Payload>,
    heard: Heard,
  ) {
    notifier.on("event", (event) => {
      if (event.kind === "queue" && event.type === "added") {
        heard.notifier.push(event.payload.id);
      }
    });
  }
}

/** A logger that keeps what it is told, so the checks can read it. */
const logged = { warnings: [] as string[], errors: [] as string[] };
const logger: LoggerService = {
  log: () => {},
  warn: (message: unknown) => {
    logged.warnings.push(String(message));
  },
  error: (message: unknown) => {
    logged.errors.push(String(message));
  },
};

const root = await mkdtemp(join(tmpdir(), "bun-nest-events-"));
const namespace = `examples-nest-events-${crypto.randomUUID().slice(0, 8)}`;

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace,
      driver: { type: "file", root },
    }),
    BunJobsModule.registerQueue({
      name: "emails",
      options: { subscribe: true },
    }),
  ],
  providers: [Heard, EmailProcessor, Audit, Stream],
})
class AppModule {}

title("Job events: worker, queue, namespace and notifier");

try {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger,
    abortOnError: false,
  });
  const heard = app.get(Heard);
  const { emails } = app.get(Stream);
  const watcher = watchQueue(app, "emails");

  check(
    "the module reminded us once that this process publishes nothing",
    logged.warnings.filter((line) => line.includes("publishEvents is off"))
      .length === 1,
    logged.warnings,
  );

  /* ---------------------------------------------------------------- */
  step("@OnWorkerEvent: this process's worker, with a scoped form");

  const welcome = await emails.add("welcome", {} as Payload);
  await watcher.outcome(welcome.id);
  await waitFor("both completed listeners", () => heard.worker.length >= 2);
  checkEqual(
    "the plain and the scoped listener both heard it",
    [...heard.worker].sort(),
    ["completed welcome welcomed", `welcomed ${welcome.id}`],
  );

  const digest = await emails.add("digest", {} as Payload);
  await watcher.outcome(digest.id);
  await waitFor("the digest's listener", () =>
    heard.worker.includes("completed digest digested"),
  );
  check(
    "`completed:welcome` did not hear a digest",
    heard.worker.filter((line) => line.startsWith("welcomed")).length === 1,
  );
  await waitFor("the throwing listener to be logged", () =>
    logged.errors.some((line) => line.includes("a listener's bug")),
  );
  check(
    "a listener that threw was logged with its class and method",
    logged.errors.some((line) => line.includes("EmailProcessor.explodes")),
    logged.errors,
  );
  checkEqual(
    "and the job it heard still completed",
    (await watcher.outcome(digest.id)).state,
    "completed",
  );

  const bad = await emails.add("bad", {} as Payload, { attempts: 1 });
  await watcher.outcome(bad.id);
  await waitFor("the dead listener", () =>
    heard.worker.includes("dead bad bad job"),
  );
  show("worker listeners heard", heard.worker);

  /* ---------------------------------------------------------------- */
  step("@OnQueueEvent and the notifier: this process's own adds");

  await waitFor("the queue listener", () => heard.queue.includes(welcome.id));
  check(
    "the queue listener heard this process's own `added`",
    [welcome.id, digest.id, bad.id].every((id) => heard.queue.includes(id)),
    heard.queue,
  );
  await waitFor("the notifier", () => heard.notifier.includes(welcome.id));
  check(
    "the injected notifier heard it too, as an event on its stream",
    heard.notifier.includes(welcome.id),
    heard.notifier,
  );

  /* ---------------------------------------------------------------- */
  step("Across two processes: only what the other publishes is heard");

  const child = async (mode: "silent" | "publish", id: string) => {
    const run = Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/helpers/publisher.ts`,
        root,
        namespace,
        mode,
        id,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    checkEqual(`the ${mode} child exited cleanly`, await run.exited, 0);
  };
  // The silent child goes first: had its event been published, `@OnJobsEvent`
  // would have heard it before the published one.
  await child("silent", "from-silent");
  await child("publish", "from-published");
  await waitFor("@OnJobsEvent to hear the published job", () =>
    heard.jobs.includes("from-published"),
  );
  check("the published job was heard", heard.jobs.includes("from-published"));
  check(
    "the silent child's job was not: nothing is heard that was never published",
    !heard.jobs.includes("from-silent"),
    heard.jobs,
  );

  await waitFor("@OnQueueEvent with subscribe: true", () =>
    heard.queue.includes("from-published"),
  );
  check(
    "`subscribe: true` lets the queue's listener hear the other process's event",
    heard.queue.includes("from-published"),
  );
  await waitFor("the notifier to hear it", () =>
    heard.notifier.includes("from-published"),
  );
  check(
    "and the notifier heard it as well",
    heard.notifier.includes("from-published"),
    heard.notifier,
  );

  await app.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

summary();
