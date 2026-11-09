/**
 * What the types of `@Processor`, `@Process`, `@DefineJob`, `JobsHost`,
 * `@InjectWorker` and `registerWorker` catch. Checked by `bun run check`; each
 * `@ts-expect-error` is its own negative control (TS2578 when unused).
 */
import type {
  BunQueueWorker,
  Job,
  ProcessorContext,
} from "@kingsleyweb/bun-jobs";
import type { WorkerRef } from "../lib/jobs/index";
import { Scope } from "@nestjs/common";
import { z } from "zod";
import {
  BunJobsModule,
  DefineJob,
  InjectWorker,
  JobsHost,
  Process,
  Processor,
} from "../lib/jobs/index";

interface Email {
  to: string;
}

/* The options. Everything a worker takes, and where it belongs in Nest. */
Processor("q");
Processor("q", {
  concurrency: 5,
  scope: Scope.REQUEST,
  context: "billing",
  deadLetterQueue: "dead",
  schema: { data: z.object({ to: z.string() }) },
});
// @ts-expect-error -- the module owns the context's namespace
Processor("q", { namespace: "n" });
// @ts-expect-error -- the module owns the driver
Processor("q", { driver: {} });
// @ts-expect-error -- the module starts the worker
Processor("q", { autorun: true });
// @ts-expect-error -- a queue's name or its token class
Processor(1);

Process();
Process("x");
Process("x", { concurrency: 2, rate: { max: 1, duration: "1 minute" } });
// @ts-expect-error -- a job name
Process(1);
// @ts-expect-error -- a limit on the name, not the worker's options
Process("x", { lockDuration: 1000 });

DefineJob("x", { attempts: 3, backoff: { type: "fixed", delay: 1 } });
DefineJob("x", { concurrency: 2, context: "billing" });
// @ts-expect-error -- a job option bun-jobs does not have
DefineJob("x", { nope: 1 });

/* JobsHost states what it handles, and hands back a worker of those types. */
export class Host extends JobsHost<Email, string> {
  process(job: Job<Email, string>, ctx: ProcessorContext): string {
    return `${job.data.to}:${ctx.attempt}`;
  }

  typed(): BunQueueWorker<Email, string> {
    return this.worker;
  }
}

export class WrongData extends JobsHost<Email, string> {
  // @ts-expect-error -- not the host's data type
  process(job: Job<{ count: number }, string>): string {
    return String(job.data.count);
  }
}

export class WrongResult extends JobsHost<Email, string> {
  // @ts-expect-error -- not the host's result type
  process(): number {
    return 1;
  }
}

// @ts-expect-error -- `process` is abstract
export class NoProcess extends JobsHost<Email, string> {}

/* The handle. */
export class Ops {
  constructor(
    @InjectWorker("q") readonly byName: WorkerRef,
    @InjectWorker(Host) readonly byClass: WorkerRef<Email, string>,
  ) {}

  worker(): BunQueueWorker<Email, string> {
    return this.byClass.worker;
  }
}
// @ts-expect-error -- a class or a queue's name
InjectWorker(1);

/* The module's options, on both forms. */
BunJobsModule.forRoot({
  namespace: "n",
  autoStart: false,
  shutdown: { timeout: 1_000, force: false },
  registryWorker: { concurrency: 2 },
});
// @ts-expect-error -- a duration in milliseconds
BunJobsModule.forRoot({ namespace: "n", shutdown: { timeout: "1 second" } });

/* registerWorker takes a file, not a function. */
BunJobsModule.registerWorker({
  queue: "q",
  processor: new URL("./p.ts", import.meta.url),
  options: { target: "child-process", concurrency: 2 },
});
// @ts-expect-error -- `processor` is required
BunJobsModule.registerWorker({ queue: "q" });
BunJobsModule.registerWorker({
  queue: "q",
  // @ts-expect-error -- a file: a function cannot cross to another process
  processor: () => {},
});
