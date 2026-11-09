/**
 * What the types of `BunJobsModule` and its tokens catch (plan
 * nest-jobs-decorators §10). Checked by `bun run check`; `bun test`, even with
 * `--check`, never reads a `*.type-test.ts`. Each `@ts-expect-error` is its own
 * negative control: unused, it fails as TS2578.
 */
import type { BunQueueOptions, JobMapFromSchemas } from "@kingsleyweb/bun-jobs";
import { BunJobs, BunQueue, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { z } from "zod";
import { BunJobsModule, InjectQueue, QueueToken } from "../lib/jobs/index";

interface Email {
  to: string;
}

@QueueToken("emails")
export abstract class EmailsQueue extends BunQueue<
  Email,
  string,
  "welcome" | "digest"
> {}

/** A named class token is the injection token and the type at once. */
export class Producer {
  constructor(
    readonly emails: EmailsQueue,
    @InjectQueue(EmailsQueue) readonly decorated: EmailsQueue,
  ) {}

  async send(): Promise<void> {
    await this.emails.add("welcome", { to: "ada@example.com" });
    // @ts-expect-error -- the wrong payload
    await this.emails.add("welcome", { count: 1 });
    // @ts-expect-error -- a job name the queue does not declare
    await this.emails.add("nope", { to: "ada@example.com" });
  }
}

/* A token typed from the same job schemas the queue is registered with. */
export const schemas = {
  welcome: {
    data: z.object({ to: z.string() }),
    result: z.object({ id: z.string() }),
  },
};
type EmailJobs = JobMapFromSchemas<typeof schemas>;

@QueueToken("schemas")
export abstract class SchemaQueue extends BunQueue<
  EmailJobs["welcome"]["data"],
  EmailJobs["welcome"]["result"],
  "welcome"
> {}

export async function usesSchemaToken(queue: SchemaQueue): Promise<void> {
  await queue.add("welcome", { to: "ada@example.com" });
  // @ts-expect-error -- the schema says `to` is a string
  await queue.add("welcome", { to: 42 });
  // @ts-expect-error -- a name the schemas do not declare
  await queue.add("digest", { to: "ada@example.com" });
}

// @ts-expect-error -- only a class extending BunQueue can be a queue token
@QueueToken("no")
export abstract class NotAQueue {}

export const notAToken = class {};
// @ts-expect-error -- neither a name nor a queue token class
InjectQueue(notAToken);
// @ts-expect-error -- neither a name nor a queue token class
InjectQueue(1);

/* The module's options. */
const driver = new MemoryDriver();
const jobs = new BunJobs({ namespace: "t", driver });

BunJobsModule.forRoot({ namespace: "t", driver });
BunJobsModule.forRoot({ namespace: "t", driver, logger: false, name: "a" });
BunJobsModule.forRoot({ jobs, isGlobal: false });
// A typed registry can be borrowed, and named.
abstract class AppJobs extends BunJobs<{
  report: { data: { month: string }; result: void };
}> {}
BunJobsModule.forRoot({ namespace: "t", driver, token: AppJobs });
BunJobsModule.forRoot({
  jobs: new BunJobs<{ report: { data: number; result: void } }>({
    namespace: "t",
    driver,
  }),
});
// @ts-expect-error -- `namespace` is required when the module builds the context
BunJobsModule.forRoot({ driver });
// @ts-expect-error -- a borrowed context's options are the application's
BunJobsModule.forRoot({ jobs, namespace: "t" });
// @ts-expect-error -- a token must be a class extending BunJobs
BunJobsModule.forRoot({ jobs, token: NotAQueue });

BunJobsModule.forRootAsync({
  inject: ["CONFIG"],
  useFactory: (config: { namespace: string }) => ({
    namespace: config.namespace,
    driver,
  }),
});
BunJobsModule.forRootAsync({
  // @ts-expect-error -- an options class answers with `createBunJobsOptions`
  useClass: class {},
});

/* Queue registrations. */
BunJobsModule.registerQueue(
  { name: "plain" },
  { name: "billed", context: "billing" },
  { name: "defaults", options: { defaultJobOptions: { attempts: 3 } } },
  // A schema passes through, as to `jobs.queue()`.
  {
    name: "checked",
    options: {
      schema: { data: z.object({ to: z.string() }) },
      dataValidation: { enqueue: "warn" },
    },
  },
  EmailsQueue,
  { name: EmailsQueue, options: { subscribe: true } },
);
// @ts-expect-error -- a queue's context and driver are the context's
BunJobsModule.registerQueue({ name: "x", options: { namespace: "y" } });
// A class that is not a token is refused at run time alone: every class has a
// `name`, so it also reads as a `{ name }` entry here.

BunJobsModule.registerQueueAsync({
  name: "emails",
  inject: ["CONFIG"],
  useFactory: (config: { attempts: number }) => ({
    options: { defaultJobOptions: { attempts: config.attempts } },
  }),
});
BunJobsModule.registerQueueAsync({
  name: "emails",
  // @ts-expect-error -- the factory answers with `{ options }`
  useFactory: () => ({ namespace: "y" }),
});

/** `BunQueueOptions` is reachable from the entry as a type. */
export type _Options = BunQueueOptions;
