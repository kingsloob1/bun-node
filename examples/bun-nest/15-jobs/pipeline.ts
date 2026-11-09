/**
 * The Nest pipeline around a job, asserted: a guard denying a job (dead at
 * once), a pipe refusing `@JobData()` (dead at once), an interceptor, a filter
 * that recovers a job, `UnrecoverableOn` ending one, and `onDenied: "retry"`
 * turning a denial back into an ordinary retry.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/pipeline.ts
 * ```
 *
 * A handler runs behind the guards, interceptors, pipes and filters a
 * controller does, in the same order, with `getType()` answering
 * `"bun-jobs"`. What differs is how a job *ends*:
 *
 * | What happens | The job |
 * |---|---|
 * | a guard returns `false` | `dead` at once, as `JobForbiddenError` (a retry asks the same guard the same question) |
 * | the pipe throws `StandardValidationException` | `dead` at once, as `UnrecoverableJobError`, the original as `cause` |
 * | a filter **returns** a value | `completed` with it (Nest's semantics) |
 * | `UnrecoverableOn(Err)` and the handler throws `Err` | `dead` at once |
 * | any other error | `failed`, retried while attempts remain |
 *
 * One queue and one processor per scenario, so each count below is its own.
 * Every job is added with `attempts: 3`, so "dead after one attempt" is a
 * real claim: three were allowed.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { Job } from "@kingsleyweb/bun-jobs";
import type {
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { BunQueue } from "@kingsleyweb/bun-jobs";
import { StandardSchemaPipe } from "@kingsleyweb/bun-nest";
import {
  BunJobsExecutionContext,
  BunJobsModule,
  InjectQueue,
  JobData,
  JobForbiddenError,
  Process,
  Processor,
  UnrecoverableOn,
} from "@kingsleyweb/bun-nest/jobs";
import {
  Catch,
  Injectable,
  Module,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { map } from "rxjs";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import { watchQueue } from "./helpers/outcomes";
import "reflect-metadata";

/** Everything the scenarios record, so the checks can read it. */
@Injectable()
class Trace {
  /** Handler bodies that ran, by label. */
  readonly ran: string[] = [];
  /** Guard questions asked, by label. */
  readonly asked: string[] = [];
  /** What the interceptor saw: the context type and the job's name. */
  readonly seen: string[] = [];
}

/** A job that says whether it is allowed. */
interface Gated {
  /** The feature flag the job carries. */
  allowed: boolean;
}

/** A guard denying a job whose `allowed` is false: a feature flag. */
@Injectable()
class FlagGuard implements CanActivate {
  constructor(private readonly trace: Trace) {}

  canActivate(context: ExecutionContext): boolean {
    // Around a job, `getType()` is "bun-jobs"; `create()` gives the job.
    const job = BunJobsExecutionContext.create(context).getJob() as Job<Gated>;
    this.trace.asked.push(`${context.getType()}:${job.data.allowed}`);
    return job.data.allowed;
  }
}

/** A guard that always says no, for the retry scenario. */
@Injectable()
class AlwaysNo implements CanActivate {
  constructor(private readonly trace: Trace) {}

  canActivate(): boolean {
    this.trace.asked.push("always-no");
    return false;
  }
}

/** An interceptor that records the job it wraps and shapes the result. */
@Injectable()
class Stamp implements NestInterceptor {
  constructor(private readonly trace: Trace) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const job = BunJobsExecutionContext.create(context).getJob();
    this.trace.seen.push(`${context.getType()}:${job.name}`);
    return next.handle().pipe(map((result) => `stamped(${String(result)})`));
  }
}

/** An error a filter turns into a normal result. */
class Soft extends Error {}

/** An error `UnrecoverableOn` ends a job for. */
class Hard extends Error {}

/** A filter that recovers: returning a value completes the job with it. */
@Catch(Soft)
class Recover implements ExceptionFilter {
  catch(error: Soft): string {
    return `recovered:${error.message}`;
  }
}

/** The shape `validated` jobs must have. */
const Order = z.object({ qty: z.number().int().positive() });

/** The `guarded` queue: a guard on the class. */
@Processor("guarded")
@UseGuards(FlagGuard)
class Guarded {
  constructor(private readonly trace: Trace) {}

  @Process("run")
  run() {
    this.trace.ran.push("guarded");
    return "ran";
  }
}

/** The `validated` queue: a pipe on `@JobData()`. */
@Processor("validated")
class Validated {
  constructor(private readonly trace: Trace) {}

  @Process("order")
  order(@JobData(new StandardSchemaPipe(Order)) data: z.infer<typeof Order>) {
    this.trace.ran.push(`validated:${data.qty}`);
    return data.qty * 2;
  }
}

/** The `enhanced` queue: an interceptor, a recovering filter and `UnrecoverableOn`. */
@Processor("enhanced")
@UseInterceptors(Stamp)
@UseFilters(Recover, UnrecoverableOn(Hard))
class Enhanced {
  @Process("ok")
  ok() {
    return "fine";
  }

  @Process("soft")
  soft() {
    throw new Soft("oops");
  }

  @Process("hard")
  hard() {
    throw new Hard("cannot be fixed by trying again");
  }

  @Process("plain")
  plain() {
    throw new Error("an ordinary failure");
  }
}

/** The `retrying` queue: the same denial, but `onDenied: "retry"`. */
@Processor("retrying", { onDenied: "retry" })
@UseGuards(AlwaysNo)
class Retrying {
  @Process("run")
  run() {
    return "never";
  }
}

/** Adds jobs to every queue. */
@Injectable()
class Producer {
  constructor(
    @InjectQueue("guarded") readonly guarded: BunQueue<Gated>,
    @InjectQueue("validated") readonly validated: BunQueue<unknown>,
    @InjectQueue("enhanced") readonly enhanced: BunQueue<unknown>,
    @InjectQueue("retrying") readonly retrying: BunQueue<unknown>,
  ) {}
}

@Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "examples-nest-pipeline",
      driver: { type: "memory" },
    }),
    BunJobsModule.registerQueue(
      { name: "guarded" },
      { name: "validated" },
      { name: "enhanced" },
      { name: "retrying" },
    ),
  ],
  providers: [
    Trace,
    Producer,
    FlagGuard,
    AlwaysNo,
    Stamp,
    Recover,
    Guarded,
    Validated,
    Enhanced,
    Retrying,
  ],
})
class AppModule {}

title("The Nest pipeline around a job");

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
});
const producer = app.get(Producer);
const trace = app.get(Trace);
const guarded = watchQueue(app, "guarded");
const validated = watchQueue(app, "validated");
const enhanced = watchQueue(app, "enhanced");
const retrying = watchQueue(app, "retrying");
const attempts = { attempts: 3 };

/* ------------------------------------------------------------------ */
step("A guard: allowed runs, denied is dead at once");

const allowed = await producer.guarded.add("run", { allowed: true }, attempts);
checkEqual(
  "an allowed job completes",
  (await guarded.outcome(allowed.id)).result,
  "ran",
);

const denied = await producer.guarded.add("run", { allowed: false }, attempts);
const deniedOutcome = await guarded.outcome(denied.id);
checkEqual("a denied job is dead", deniedOutcome.state, "dead");
checkEqual("after one attempt of three", deniedOutcome.attemptsMade, 1);
check("as JobForbiddenError", deniedOutcome.error instanceof JobForbiddenError);
checkEqual(
  "named UnrecoverableJobError, which is what bun-jobs keys on",
  deniedOutcome.error?.name,
  "UnrecoverableJobError",
);
checkEqual("the handler ran for the allowed job only", trace.ran, ["guarded"]);
checkEqual("getType() said bun-jobs, once per attempt", trace.asked, [
  "bun-jobs:true",
  "bun-jobs:false",
]);

/* ------------------------------------------------------------------ */
step("A pipe on @JobData(): invalid data is dead at once");

const good = await producer.validated.add("order", { qty: 4 }, attempts);
checkEqual(
  "valid data reaches the handler",
  (await validated.outcome(good.id)).result,
  8,
);

const bad = await producer.validated.add("order", { qty: "four" }, attempts);
const badOutcome = await validated.outcome(bad.id);
checkEqual("invalid data is dead", badOutcome.state, "dead");
checkEqual("after one attempt of three", badOutcome.attemptsMade, 1);
checkEqual(
  "as UnrecoverableJobError",
  badOutcome.error?.name,
  "UnrecoverableJobError",
);
checkEqual(
  "with the pipe's exception as its cause",
  (badOutcome.error?.cause as Error | undefined)?.name,
  "StandardValidationException",
);
checkEqual(
  "the handler never saw the bad job",
  trace.ran.filter((line) => line.startsWith("validated")),
  ["validated:4"],
);

/* ------------------------------------------------------------------ */
step("An interceptor, a filter that recovers, UnrecoverableOn");

const ok = await producer.enhanced.add("ok", {}, attempts);
checkEqual(
  "the interceptor reshaped the result",
  (await enhanced.outcome(ok.id)).result,
  "stamped(fine)",
);

const soft = await producer.enhanced.add("soft", {}, attempts);
const softOutcome = await enhanced.outcome(soft.id);
checkEqual(
  "a filter returning a value completes the job with it",
  [softOutcome.state, softOutcome.result],
  ["completed", "recovered:oops"],
);

const hard = await producer.enhanced.add("hard", {}, attempts);
const hardOutcome = await enhanced.outcome(hard.id);
checkEqual("UnrecoverableOn(Hard): dead", hardOutcome.state, "dead");
checkEqual("after one attempt of three", hardOutcome.attemptsMade, 1);
check("the original is the cause", hardOutcome.error?.cause instanceof Hard);

const plain = await producer.enhanced.add("plain", {}, { attempts: 2 });
const plainOutcome = await enhanced.outcome(plain.id);
checkEqual(
  "an unfiltered error is retried: dead only after all attempts",
  [plainOutcome.state, plainOutcome.attemptsMade],
  ["dead", 2],
);
checkEqual(
  "the interceptor wrapped every attempt (ok, soft, hard, plain x2)",
  trace.seen,
  [
    "bun-jobs:ok",
    "bun-jobs:soft",
    "bun-jobs:hard",
    "bun-jobs:plain",
    "bun-jobs:plain",
  ],
);

/* ------------------------------------------------------------------ */
step('onDenied: "retry"');

const retry = await producer.retrying.add(
  "run",
  {},
  { attempts: 3, backoff: 10 },
);
const retryOutcome = await retrying.outcome(retry.id);
checkEqual(
  "a denial is retried like any error: three attempts",
  retryOutcome.attemptsMade,
  3,
);
checkEqual(
  "the guard was asked three times",
  trace.asked.filter((line) => line === "always-no").length,
  3,
);
checkEqual(
  "every attempt failed (the last one is the one that went dead)",
  retrying.failures.filter((entry) => entry.id === retry.id).length,
  3,
);
checkEqual(
  "it ends dead once attempts run out, with Nest's own ForbiddenException",
  [retryOutcome.state, retryOutcome.error?.constructor.name],
  ["dead", "ForbiddenException"],
);
check(
  "and not as JobForbiddenError, which is what the default would give",
  !(retryOutcome.error instanceof JobForbiddenError),
);

await app.close();
summary();
