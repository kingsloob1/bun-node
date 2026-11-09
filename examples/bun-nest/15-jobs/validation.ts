/**
 * Validating job data, asserted: bun-jobs' schemas (checked when a job is
 * **added** and again before the handler), and Nest's pipes on `@JobData`
 * (`StandardSchemaPipe`, `@JobData({ schema })`, and a `SchemaDto` under the
 * global `StandardValidationPipe`).
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/validation.ts
 * ```
 *
 * Which layer to use:
 *
 * | Layer | Checks | On a bad payload |
 * |---|---|---|
 * | a schema on the queue (`registerQueue({ options: { schema } })`) | every job, in every process that adds it | `add()` rejects with `JobDataValidationError`; **nothing is written** |
 * | a schema on the processor (`@Processor(q, { schema })`) | before the handler, whoever added the job | the attempt fails as `UnrecoverableJobError`: `dead` at once |
 * | a pipe on a parameter | one method's input, after the guards | `StandardValidationException`, and `dead` at once |
 *
 * A pipe is for one name on a queue carrying several, or for a transform a
 * handler wants (`z.coerce.number()` hands the handler a `number`). A schema is
 * for data that crosses a deployment boundary. `schema` is always
 * `{ data, result }`, never a bare schema. (`07-validation/` owns the same
 * pipes for HTTP.)
 *
 * Every dead job below was added with `attempts: 3` and reports one attempt
 * made: a retry would see the same data, so none is made. The issues the pipe
 * found are on the error, with `target: "body"` (`@JobData()` is recorded as
 * Nest's BODY type, which is what lets a global validation pipe see it) and
 * the failing `path`. `onInvalid: "retry"` on the class retries it like any
 * error instead, and the last scenario counts two attempts.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunQueue } from "@kingsleyweb/bun-jobs";
import type { Outcome } from "./helpers/outcomes";
import {
  BunJobs,
  JobDataValidationError,
  UnrecoverableJobError,
} from "@kingsleyweb/bun-jobs";
import {
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationException,
  StandardValidationPipe,
} from "@kingsleyweb/bun-nest";
import {
  BunJobsModule,
  getQueueToken,
  JobData,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import { Module } from "@nestjs/common";
import { APP_PIPE, NestFactory } from "@nestjs/core";
import { z } from "zod";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";
import { watchQueue } from "./helpers/outcomes";
import "reflect-metadata";

/** The shape every scenario's good payload has. */
const Email = z.object({ to: z.string() });

/** The same, with a transform: a handler gets a `number`. */
const Counted = z.object({ count: z.coerce.number() });

/** A DTO class from a schema, for the global pipe to find. */
class EmailDto extends SchemaDto(Email) {}

@Processor("piped")
class Piped {
  /** `new StandardSchemaPipe(schema)` on the parameter. */
  @Process("pipe")
  pipe(@JobData(new StandardSchemaPipe(Email)) data: z.infer<typeof Email>) {
    return data.to;
  }

  /** `@JobData({ schema })` is the same pipe. */
  @Process("option")
  option(@JobData({ schema: Email }) data: z.infer<typeof Email>) {
    return data.to;
  }

  /** The handler receives the schema's output: a number. */
  @Process("count")
  count(@JobData({ schema: Counted }) data: z.infer<typeof Counted>) {
    return typeof data.count;
  }

  /** A `SchemaDto` parameter, checked by the global pipe. */
  @Process("dto")
  dto(@JobData() data: EmailDto) {
    return data.to;
  }
}

/** The processor's own `schema`, before any handler. */
@Processor("guarded", { schema: { data: Email } })
class Guarded {
  @Process()
  run(@JobData("to") to: string) {
    return to;
  }
}

/** `onInvalid: "retry"`: an invalid payload is an ordinary failure. */
@Processor("retrying", { onInvalid: "retry" })
class Retrying {
  @Process()
  run(@JobData({ schema: Email }) data: z.infer<typeof Email>) {
    return data.to;
  }
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-validation",
      driver: { type: "memory" },
      logger: false,
    }),
    // A schema on the queue: checked wherever a job is added.
    BunJobsModule.registerQueue({
      name: "checked",
      options: { schema: { data: Email } },
    }),
    BunJobsModule.registerQueue(
      { name: "piped" },
      { name: "guarded" },
      { name: "retrying" },
    ),
  ],
  providers: [
    Piped,
    Guarded,
    Retrying,
    // Validates a `SchemaDto` parameter on controllers, and on jobs.
    { provide: APP_PIPE, useClass: StandardValidationPipe },
  ],
})
class AppModule {}

/** What a dead job's error says: the issues the pipe found. */
function issuesOf(outcome: Outcome): { target: string; path: string }[] {
  return ((outcome.error as UnrecoverableJobError).context?.issues ?? []) as {
    target: string;
    path: string;
  }[];
}

title("Validating job data: schemas and pipes");

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
  abortOnError: false,
});
try {
  const queueOf = (name: string) =>
    app.get<BunQueue>(getQueueToken(name), { strict: false });
  const jobs = app.get(BunJobs);

  /* ---------------------------------------------------------------- */
  step("A schema on the queue: refused where the job is added");

  const checked = queueOf("checked");
  await checked.add("welcome", { to: "ada" });
  const before = (await checked.count()).waiting;
  await checkRejects(
    "adding a bad payload",
    () => checked.add("welcome", { to: 42 }),
    { name: JobDataValidationError.name },
  );
  checkEqual(
    "and nothing was written",
    (await checked.count()).waiting,
    before,
  );

  /* ---------------------------------------------------------------- */
  step("Pipes on @JobData: dead at once, with the issues");

  const piped = watchQueue(app, "piped");
  for (const name of ["pipe", "option", "dto"]) {
    const good = await queueOf("piped").add(name, { to: "ada" });
    checkEqual(
      `${name}: a good payload completes`,
      (await piped.outcome(good.id)).result,
      "ada",
    );
    const bad = await queueOf("piped").add(name, { to: 42 }, { attempts: 3 });
    const outcome = await piped.outcome(bad.id);
    checkEqual(
      `${name}: a bad one is dead after one attempt of three`,
      [outcome.state, outcome.attemptsMade],
      ["dead", 1],
    );
    check(
      `${name}: as UnrecoverableJobError, caused by StandardValidationException`,
      outcome.error instanceof UnrecoverableJobError &&
        outcome.error.cause instanceof StandardValidationException,
      outcome.error,
    );
    checkEqual(
      `${name}: the issue names the target and the field`,
      issuesOf(outcome)[0] && [
        issuesOf(outcome)[0]!.target,
        issuesOf(outcome)[0]!.path,
      ],
      ["body", "to"],
    );
  }

  const counted = await queueOf("piped").add("count", { count: "7" });
  checkEqual(
    'a transforming schema hands the handler its output: "7" arrives as a number',
    (await piped.outcome(counted.id)).result,
    "number",
  );

  /* ---------------------------------------------------------------- */
  step("A schema on the processor: before the handler, whoever added the job");

  const guarded = watchQueue(app, "guarded");
  // A producer that never registered the queue with a schema: nothing refuses it here.
  const stray = await jobs
    .queue("guarded")
    .add("x", { to: 42 }, { attempts: 3 });
  const strayOutcome = await guarded.outcome(stray.id);
  checkEqual(
    "the bad payload got in, and the processor killed it after one attempt",
    [strayOutcome.state, strayOutcome.attemptsMade, strayOutcome.error?.name],
    ["dead", 1, "UnrecoverableJobError"],
  );
  const fine = await jobs.queue("guarded").add("x", { to: "ada" });
  checkEqual(
    "a good one completes",
    (await guarded.outcome(fine.id)).result,
    "ada",
  );

  /* ---------------------------------------------------------------- */
  step('onInvalid: "retry": an invalid payload is an ordinary failure');

  const retrying = watchQueue(app, "retrying");
  const again = await queueOf("retrying").add("x", { to: 42 }, { attempts: 2 });
  const retried = await retrying.outcome(again.id);
  checkEqual(
    "both attempts were made",
    [retried.state, retried.attemptsMade],
    ["dead", 2],
  );
  check(
    "ending in the pipe's own exception, not UnrecoverableJobError",
    retried.error instanceof StandardValidationException,
    retried.error?.name,
  );
} finally {
  await app.close();
}

summary();
