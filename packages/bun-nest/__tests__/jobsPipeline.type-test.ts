/**
 * What TypeScript catches from a queue token to a handler (plan
 * nest-jobs-decorators §10), with the types read from the `BunQueue` a token
 * class extends. Checked by `bun run check`; a `*.type-test.ts` is not a test
 * file, so `bun test --check` never reads it. Each `@ts-expect-error` is its own
 * negative control: unused, it fails as TS2578.
 */
import type {
  Job,
  JobMapFromSchemas,
  ProcessorContext,
} from "@kingsleyweb/bun-jobs";
import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";
import type {
  BunJobsContextType,
  JobProgressFn,
  QueueJobData,
  QueueJobName,
  QueueJobResult,
} from "../lib/jobs/index";
import { BunQueue } from "@kingsleyweb/bun-jobs";
import { z } from "zod";
import {
  BaseJobExceptionFilter,
  BunJobsExecutionContext,
  isBunJobsContext,
  JobData,
  JobForbiddenError,
  JobProgress,
  Process,
  Processor,
  QueueToken,
  UnrecoverableOn,
} from "../lib/jobs/index";

interface Email {
  to: string;
}
interface Wrong {
  count: number;
}

@QueueToken("emails")
export abstract class EmailsQueue extends BunQueue<
  Email,
  string,
  "welcome" | "digest"
> {}

/* The types come back out of a token class, with nothing else declared on it. */
export const data: QueueJobData<typeof EmailsQueue> = { to: "ada" };
export const result: QueueJobResult<typeof EmailsQueue> = "sent";
export const name: QueueJobName<typeof EmailsQueue> = "digest";
// @ts-expect-error -- the wrong payload
export const wrongData: QueueJobData<typeof EmailsQueue> = { count: 1 };
// @ts-expect-error -- the wrong result
export const wrongResult: QueueJobResult<typeof EmailsQueue> = 1;
// @ts-expect-error -- an undeclared name
export const wrongName: QueueJobName<typeof EmailsQueue> = "nope";

@Processor(EmailsQueue)
export class Typed {
  @Process(EmailsQueue, "welcome")
  async full(job: Job<Email, string>, ctx: ProcessorContext) {
    return `${job.data.to}:${ctx.attempt}`;
  }

  @Process(EmailsQueue, "digest", { concurrency: 2 })
  jobOnly(job: Job<Email, string>) {
    return job.data.to;
  }

  @Process(EmailsQueue)
  catchAll() {
    return "any";
  }

  // @ts-expect-error -- the job's payload type is wrong
  @Process(EmailsQueue, "welcome")
  async wrongPayload(job: Job<Wrong, string>) {
    return String(job.data.count);
  }

  // @ts-expect-error -- the result type is wrong: a number where the queue says string
  @Process(EmailsQueue, "welcome")
  async wrongReturn(job: Job<Email, string>) {
    return job.data.to.length;
  }

  // @ts-expect-error -- a name the queue does not declare
  @Process(EmailsQueue, "nope")
  undeclared(job: Job<Email, string>) {
    return job.data.to;
  }

  // @ts-expect-error -- the typed form requires (job, ctx), so parameter decorators do not combine with it
  @Process(EmailsQueue, "welcome")
  decorated(@JobData() value: Email) {
    return value.to;
  }

  /* The plain form is the caller's word: a parameter decorator cannot see its type. */
  @Process("digest")
  plain(@JobData() value: Wrong) {
    return value.count;
  }
}

/* A token typed from the same schemas the queue is registered with. */
export const schemas = {
  welcome: {
    data: z.object({ to: z.string() }),
    result: z.object({ id: z.string() }),
  },
};
type SchemaJobs = JobMapFromSchemas<typeof schemas>;

@QueueToken("schemas")
export abstract class SchemaQueue extends BunQueue<
  SchemaJobs["welcome"]["data"],
  SchemaJobs["welcome"]["result"],
  "welcome"
> {}

@Processor(SchemaQueue)
export class FromSchemas {
  @Process(SchemaQueue, "welcome")
  welcome(job: Job<{ to: string }, { id: string }>) {
    return { id: job.data.to };
  }

  // @ts-expect-error -- the schema says the result carries an `id`
  @Process(SchemaQueue, "welcome")
  wrong(job: Job<{ to: string }, { id: string }>) {
    return { nope: job.data.to };
  }
}

/* The parameter decorators' arguments. */
JobData();
JobData("to");
JobData({ property: "to", schema: schemas.welcome.data, pipes: [] });
// @ts-expect-error -- not a property, a pipe or the object form
JobData(1);
// @ts-expect-error -- not an option of the object form
JobData({ nope: 1 });

export class Progress {
  run(@JobProgress() progress: JobProgressFn) {
    return progress(50);
  }
}

/* The context. */
export function guard(context: ExecutionContext) {
  const type: BunJobsContextType = context.getType<BunJobsContextType>();
  const host = BunJobsExecutionContext.create(context);
  const job: Job<Email, string> = host.getJob<Email, string>();
  const ctx: ProcessorContext = host.getProcessorContext();
  const queue: string = host.getQueueName();
  const handler: string = host.getHandlerName();
  return [type, job, ctx, queue, handler, isBunJobsContext(context)];
}

export function filterHost(host: ArgumentsHost) {
  return BunJobsExecutionContext.create(host).getJob();
}

/* The failures. */
export const forbidden: Error = new JobForbiddenError("no");
UnrecoverableOn(Error);
// @ts-expect-error -- an error class
UnrecoverableOn("Error");

export class Decides extends BaseJobExceptionFilter<Error> {
  override catch(exception: Error, host: ArgumentsHost): unknown {
    return super.catch(exception, host);
  }
}

/* The options. */
Processor("q", { enhancers: false, onDenied: "retry", onInvalid: "retry" });
// @ts-expect-error -- "fail" or "retry"
Processor("q", { onDenied: "drop" });
// @ts-expect-error -- "fail" or "retry"
Processor("q", { onInvalid: "drop" });
