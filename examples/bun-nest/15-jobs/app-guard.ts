/**
 * A global `APP_GUARD` that meets jobs, asserted: the `getType()` idiom keeps an
 * HTTP guard from breaking them, and a guard can choose to apply to jobs.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/app-guard.ts
 * ```
 *
 * Global guards, interceptors, pipes and filters (`APP_GUARD`, or
 * `useGlobalGuards`) reach job handlers as well as routes: the pipeline
 * around a job is Nest's, so a guard written for HTTP now runs on jobs, with
 * `context.getType()` answering `"bun-jobs"` instead of `"http"`. A guard that
 * reads `switchToHttp().getRequest()` unconditionally is therefore a bug the
 * first time a job runs. Three guards, three queues:
 *
 * 1. **`NaiveGuard`** reads an HTTP header and nothing else: the negative
 *    control. A job through it fails (it throws, so it is retried: `failed`
 *    on each attempt, `dead` at the end).
 * 2. **`HttpOnlyGuard`** opens with the idiom, `if (context.getType() !==
 *    "http") return true`, and then guards the route: a request with no key is
 *    403, and a job passes untouched.
 * 3. **`JobsAwareGuard`** is the other half of the idiom: it applies to jobs
 *    on purpose, by `getType() === "bun-jobs"`, and denies the job named
 *    `blocked` (dead at once, as any denial is, since a retry asks the same
 *    guard the same question).
 *
 * One application per guard, each with a controller route and a queue, so the
 * same guard is seen from both sides.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { BunQueue, Job } from "@kingsleyweb/bun-jobs";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BunJobsExecutionContext,
  BunJobsModule,
  getQueueToken,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import { watchQueue } from "./helpers/outcomes";
import "reflect-metadata";

/** A guard written for HTTP only: reads a header from the request. */
@Injectable()
class NaiveGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // On a job there is no HTTP request: this is the bug.
    return (
      context.switchToHttp().getRequest<BunRequest>().getHeader("x-key") ===
      "secret"
    );
  }
}

/** The same rule, behind the idiom: it only speaks for HTTP. */
@Injectable()
class HttpOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") {
      return true;
    }
    return (
      context.switchToHttp().getRequest<BunRequest>().getHeader("x-key") ===
      "secret"
    );
  }
}

/** A guard that means to apply to jobs, and says how. */
@Injectable()
class JobsAwareGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType<string>() !== "bun-jobs") {
      return true;
    }
    return BunJobsExecutionContext.create(context).getJob().name !== "blocked";
  }
}

@Processor("work")
class Work {
  @Process("ok")
  ok() {
    return "ran";
  }

  @Process("blocked")
  blocked() {
    return "ran";
  }
}

@Controller("route")
class Route {
  @Get()
  get() {
    return { ok: true };
  }
}

/** One application whose only global guard is `guard`. */
async function boot(guard: new () => CanActivate) {
  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: `examples-nest-app-guard-${crypto.randomUUID().slice(0, 8)}`,
        driver: { type: "memory" },
        logger: false,
      }),
      BunJobsModule.registerQueue({ name: "work" }),
    ],
    providers: [Work, { provide: APP_GUARD, useClass: guard }],
    controllers: [Route],
  })
  class AppModule {}

  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, adapter, {
    // Nest logs every failing job with its stack, once per attempt.
    logger: false,
    abortOnError: false,
  });
  await app.init();
  return {
    app,
    adapter,
    queue: app.get<BunQueue>(getQueueToken("work"), { strict: false }),
    watcher: watchQueue(app, "work"),
  };
}

/** Adds a job named `name` with three attempts and waits for how it ends. */
async function runJob(booted: Awaited<ReturnType<typeof boot>>, name: string) {
  const job = await booted.queue.add(name, {} as Job["data"], {
    attempts: 3,
    backoff: 0,
  });
  return await booted.watcher.outcome(job.id);
}

/** A request to the route, with a key or not. */
async function route(
  { adapter }: Awaited<ReturnType<typeof boot>>,
  key?: string,
) {
  const response = await adapter.fetch("/route", {
    headers: key === undefined ? {} : { "x-key": key },
  });
  await response.arrayBuffer();
  return response.status;
}

title("A global APP_GUARD, and what it does to jobs");

step("NaiveGuard: an HTTP-only guard breaks every job (the control)");
{
  const booted = await boot(NaiveGuard);
  try {
    checkEqual(
      "the route with the key: 200",
      await route(booted, "secret"),
      200,
    );
    const outcome = await runJob(booted, "ok");
    checkEqual(
      "the job: dead, after all three attempts (a throw is retried)",
      [outcome.state, outcome.attemptsMade],
      ["dead", 3],
    );
    check(
      "and it was the guard throwing, not a denial (not UnrecoverableJobError)",
      outcome.error !== undefined &&
        outcome.error.name !== "UnrecoverableJobError",
      outcome.error?.name,
    );
  } finally {
    await booted.app.close();
  }
}

step("HttpOnlyGuard: the idiom, guarding the route and leaving jobs alone");
{
  const booted = await boot(HttpOnlyGuard);
  try {
    checkEqual(
      "the route with the key: 200",
      await route(booted, "secret"),
      200,
    );
    checkEqual("the route without it: 403", await route(booted), 403);
    const outcome = await runJob(booted, "ok");
    checkEqual(
      "the job completes",
      [outcome.state, outcome.result],
      ["completed", "ran"],
    );
  } finally {
    await booted.app.close();
  }
}

step("JobsAwareGuard: a guard that applies to jobs on purpose");
{
  const booted = await boot(JobsAwareGuard);
  try {
    checkEqual("the route is not its business: 200", await route(booted), 200);
    const ok = await runJob(booted, "ok");
    checkEqual("the job it allows completes", ok.state, "completed");
    const blocked = await runJob(booted, "blocked");
    checkEqual(
      "the job it denies is dead at once: one attempt of three",
      [blocked.state, blocked.attemptsMade],
      ["dead", 1],
    );
    checkEqual(
      "with the denial's own code",
      (blocked.error as { code?: string } | undefined)?.code,
      "JOB_FORBIDDEN",
    );
    checkEqual(
      "as UnrecoverableJobError",
      blocked.error?.name,
      "UnrecoverableJobError",
    );
  } finally {
    await booted.app.close();
  }
}

summary();
