/**
 * The Nest pipeline around a job (nest-jobs-decorators PR-n3): guards,
 * interceptors, pipes, filters and parameter decorators, under a real Nest
 * application on a real bun-jobs driver. The conformance target is Nest's own
 * pipeline, so each is paired with the same enhancer on an HTTP route in the
 * same application.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type {
  BunQueue,
  BunQueueWorker,
  Job,
  ProcessorContext,
} from "@kingsleyweb/bun-jobs";
import type {
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExecutionContext,
  ExceptionFilter,
  LoggerService,
  NestInterceptor,
  PipeTransform,
  Type,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import type { JobProgressFn } from "../lib/jobs/index";
import { createRequire } from "node:module";
import { ConfigError, createDeferred } from "@kingsleyweb/bun-common";
import {
  BunQueue as BunQueueClass,
  UnrecoverableJobError,
} from "@kingsleyweb/bun-jobs";
import * as nestCommon from "@nestjs/common";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  createParamDecorator,
  ForbiddenException,
  Injectable,
  Logger,
  Module,
  Post,
  Scope,
  SetMetadata,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  ModulesContainer,
  NestFactory,
  Reflector,
} from "@nestjs/core";
import {
  ENTRY_PROVIDER_WATERMARK,
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PIPES_METADATA,
} from "@nestjs/common/constants.js";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum.js";
import { FORBIDDEN_MESSAGE } from "@nestjs/core/guards/constants.js";
import { afterEach, describe, expect, it } from "bun:test";
import { IsString } from "class-validator";
import * as v from "valibot";
import { z } from "zod";
import { memoryDriver } from "@kingsleyweb/bun-cache";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunCacheInterceptor,
  BunCacheModule,
  Cacheable,
} from "../lib/cache/index";
import {
  BaseJobExceptionFilter,
  BunJobsExecutionContext,
  BunJobsModule,
  CurrentJob,
  DefineJob,
  getQueueToken,
  getWorkerToken,
  isBunJobsContext,
  JobAttempt,
  JobContext,
  JobData,
  JobForbiddenError,
  JobId,
  JobLogger,
  JobLoggingInterceptor,
  JobName,
  JobProgress,
  JobSignal,
  Process,
  Processor,
  QueueToken,
  UnrecoverableOn,
} from "../lib/jobs/index";
import { JobParamType } from "../lib/jobs/decorators/params";
import {
  NEST_BODY_PARAMTYPE,
  NEST_ENHANCER_METADATA,
  NEST_ENTRY_PROVIDER_WATERMARK,
  NEST_FORBIDDEN_MESSAGE,
} from "../lib/jobs/metadata";
import { BunThrottlerModule } from "../lib/throttler/module";
import {
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationException,
  StandardValidationPipe,
  ValidationExceptionFilter,
} from "../lib/validation";
import "reflect-metadata";

/** Nest's version, as this test sees it: the repo's lock, or a matrix copy's. */
const NEST_VERSION = (
  createRequire(import.meta.url)("@nestjs/core/package.json") as {
    version: string;
  }
).version;

/**
 * Whether Nest scans the class behind `{ provide, useClass }` for enhancers
 * (11.2.8 and 12.2.0; 11.2.7 and 12.1.3 do not): what Nest registered for one,
 * as the library's boot check reads it, never a version.
 */
async function nestScansUseClass(): Promise<boolean> {
  class ProbeGuard {
    canActivate() {
      return true;
    }
  }
  @UseGuards(ProbeGuard)
  class ProbeHost {}
  @Module({ providers: [{ provide: ProbeHost, useClass: ProbeHost }] })
  class ProbeModule {}
  const context = await NestFactory.createApplicationContext(ProbeModule, {
    logger: false,
  });
  const scanned = [...context.get(ModulesContainer).values()].some((module) =>
    module.injectables.has(ProbeGuard),
  );
  await context.close();
  return scanned;
}

/** Nest's major. */
const NEST_MAJOR = Number(NEST_VERSION.split(".")[0]);

/** Applications to close after each test, and anything else to undo. */
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A jobs module and a registered queue `q`, for an app's imports. */
function jobsImports(options: { enhancers?: boolean; logger?: never } = {}) {
  return [
    BunJobsModule.forRoot({
      namespace: `nest-pipeline-${crypto.randomUUID().slice(0, 8)}`,
      driver: { type: "memory" },
      ...options,
    }),
    BunJobsModule.registerQueue({ name: "q" }),
  ];
}

/** Boots an app on the HTTP adapter; `prepare` runs between create and init. */
async function bootHttp(
  module: Type<unknown>,
  prepare?: (app: Awaited<ReturnType<typeof NestFactory.create>>) => void,
  logger: LoggerService | false = false,
) {
  const adapter = new BunHttpAdapter(30000);
  const app = await NestFactory.create(module, adapter, {
    logger,
    abortOnError: false,
  });
  cleanups.push(() => app.close());
  prepare?.(app);
  await app.init();
  const queue = app.get<BunQueue<any, any, any>>(getQueueToken("q"), {
    strict: false,
  });
  const worker = app.get<{ worker: BunQueueWorker<any, any, any> }>(
    getWorkerToken("q"),
    { strict: false },
  ).worker;
  return { app, adapter, queue, worker, settled: watch(worker) };
}

/** A module class with the given metadata. */
function moduleNamed(metadata: Parameters<typeof Module>[0]): Type<unknown> {
  class AppModule {}
  Module(metadata)(AppModule);
  return AppModule;
}

/** The message of the `ConfigError` a failing boot gives. */
async function bootProblem(module: Type<unknown>): Promise<string> {
  let caught: unknown;
  let app:
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
    | undefined;
  try {
    app = await NestFactory.createApplicationContext(module, {
      logger: false,
      abortOnError: false,
    });
  } catch (error) {
    caught = error;
  }
  await app?.close();
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).message;
}

/** How one job ended, from its worker's events. */
interface Outcome {
  state: "completed" | "dead";
  result?: unknown;
  error?: Error;
  attemptsMade: number;
}

/** Waits for jobs by id, from the moment it is called. */
function watch(worker: BunQueueWorker<any, any, any>) {
  const waiting = new Map<string, ReturnType<typeof createDeferred<Outcome>>>();
  const of = (id: string) => {
    let entry = waiting.get(id);
    if (entry === undefined) {
      entry = createDeferred<Outcome>();
      waiting.set(id, entry);
    }
    return entry;
  };
  worker.on("completed", (job: Job, result: unknown) => {
    of(job.id).resolve({
      state: "completed",
      result,
      attemptsMade: job.attemptsMade,
    });
  });
  worker.on("dead", (job: Job, error: Error) => {
    of(job.id).resolve({
      state: "dead",
      error,
      attemptsMade: job.attemptsMade,
    });
  });
  return (id: string) => of(id).promise;
}

/** POSTs JSON through the adapter, socket-free. */
function post(adapter: BunHttpAdapter, path: string, body: unknown) {
  return adapter.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Replaces the context type in a trace, so a job's and a route's compare. */
const sameShape = (trace: string[]) =>
  trace.map((line) => line.replace(/:(http|bun-jobs)$/, ""));

describe("guards, interceptors and pipes, at every level", () => {
  it("run in Nest's order, around a job as around a route, under the context type bun-jobs", async () => {
    const trace: string[] = [];

    function guard(name: string): Type<CanActivate> {
      @Injectable()
      class TraceGuard implements CanActivate {
        canActivate(context: ExecutionContext) {
          trace.push(`guard ${name}:${context.getType()}`);
          return true;
        }
      }
      return TraceGuard;
    }
    function interceptor(name: string): Type<NestInterceptor> {
      @Injectable()
      class TraceInterceptor implements NestInterceptor {
        intercept(
          context: ExecutionContext,
          next: CallHandler,
        ): Observable<unknown> {
          trace.push(`interceptor ${name}:${context.getType()}`);
          return next.handle();
        }
      }
      return TraceInterceptor;
    }
    function pipe(name: string): Type<PipeTransform> {
      @Injectable()
      class TracePipe implements PipeTransform {
        transform(value: unknown) {
          trace.push(`pipe ${name}`);
          return value;
        }
      }
      return TracePipe;
    }

    const [classGuard, methodGuard] = [guard("class"), guard("method")];
    const [classInt, methodInt] = [interceptor("class"), interceptor("method")];
    const [classPipe, methodPipe, paramPipe] = [
      pipe("class"),
      pipe("method"),
      pipe("param"),
    ];

    @Processor("q")
    @UseGuards(classGuard)
    @UseInterceptors(classInt)
    @UsePipes(classPipe)
    class Worker {
      @Process("x")
      @UseGuards(methodGuard)
      @UseInterceptors(methodInt)
      @UsePipes(methodPipe)
      x(@JobData(paramPipe) data: unknown) {
        trace.push("handler");
        return data;
      }
    }

    @Controller("r")
    @UseGuards(classGuard)
    @UseInterceptors(classInt)
    @UsePipes(classPipe)
    class Route {
      @Post()
      @UseGuards(methodGuard)
      @UseInterceptors(methodInt)
      @UsePipes(methodPipe)
      x(@Body(paramPipe) data: unknown) {
        trace.push("handler");
        return data;
      }
    }

    @Module({
      imports: jobsImports(),
      controllers: [Route],
      providers: [
        Worker,
        { provide: APP_GUARD, useClass: guard("APP") },
        { provide: APP_INTERCEPTOR, useClass: interceptor("APP") },
        { provide: APP_PIPE, useClass: pipe("APP") },
      ],
    })
    class AppModule {}

    const { adapter, queue, settled } = await bootHttp(AppModule, (app) => {
      app.useGlobalGuards(new (guard("useGlobal"))());
      app.useGlobalInterceptors(new (interceptor("useGlobal"))());
      app.useGlobalPipes(new (pipe("useGlobal"))());
    });

    const job = await queue.add("x", { a: 1 });
    const outcome = await settled(job.id);
    expect(outcome.result).toEqual({ a: 1 });
    const forJob = trace.splice(0);

    const response = await post(adapter, "/r", { a: 1 });
    expect(response.status).toBe(201);
    const forRoute = trace.splice(0);

    expect(forJob.filter((line) => line.endsWith(":bun-jobs")).length).toBe(8);
    expect(forRoute.filter((line) => line.endsWith(":http")).length).toBe(8);
    expect(sameShape(forJob)).toEqual(sameShape(forRoute));
    expect(forJob).toContain("guard method:bun-jobs");
    expect(forJob).toContain("pipe param");
    expect(forJob.at(-1)).toBe("handler");
  });

  it("a Reflector-based guard reads @SetMetadata from the method and the class", async () => {
    const roles: unknown[] = [];

    @Injectable()
    class RolesGuard implements CanActivate {
      constructor(readonly reflector: Reflector) {}

      canActivate(context: ExecutionContext) {
        roles.push(
          this.reflector.getAllAndMerge("roles", [
            context.getHandler(),
            context.getClass(),
          ]),
        );
        return true;
      }
    }

    @Processor("q")
    @UseGuards(RolesGuard)
    @SetMetadata("roles", ["class"])
    class Worker {
      @Process()
      @SetMetadata("roles", ["method"])
      run() {}
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    await settled((await queue.add("x", {})).id);
    expect(roles).toEqual([["method", "class"]]);
  });
});

describe("filters", () => {
  /** A filter class that says it ran, and rethrows. */
  function rethrowing(trace: string[], name: string): Type<ExceptionFilter> {
    @Catch()
    class TraceFilter implements ExceptionFilter {
      catch(exception: unknown, host: ArgumentsHost) {
        trace.push(`filter ${name}:${host.getType()}`);
        throw exception;
      }
    }
    return TraceFilter;
  }

  it("the nearest catches first, around a job as around a route", async () => {
    const trace: string[] = [];

    @Processor("q")
    @UseFilters(rethrowing(trace, "class"))
    class Worker {
      @Process("method")
      @UseFilters(rethrowing(trace, "method"))
      method() {
        throw new Error("boom");
      }

      @Process("class")
      classLevel() {
        throw new Error("boom");
      }
    }

    @Module({
      imports: jobsImports(),
      providers: [
        Worker,
        { provide: APP_FILTER, useClass: rethrowing(trace, "APP") },
      ],
    })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const method = await queue.add("method", {});
    expect((await settled(method.id)).error?.message).toBe("boom");
    expect(trace.splice(0)).toEqual(["filter method:bun-jobs"]);

    const classLevel = await queue.add("class", {});
    await settled(classLevel.id);
    expect(trace.splice(0)).toEqual(["filter class:bun-jobs"]);
  });

  it("a filter that returns a value completes the job with it", async () => {
    @Catch()
    class Recover implements ExceptionFilter {
      catch() {
        return "recovered";
      }
    }

    @Processor("q")
    @UseFilters(Recover)
    class Worker {
      @Process()
      run() {
        throw new Error("boom");
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("x", {}, { attempts: 3 });
    const outcome = await settled(job.id);
    expect(outcome.state).toBe("completed");
    expect(outcome.result).toBe("recovered");
  });

  it("UnrecoverableOn ends the job with no retry, on the errors it names and no others", async () => {
    class Rejected extends Error {}

    @Processor("q")
    @UseFilters(UnrecoverableOn(Rejected))
    class Worker {
      @Process("named")
      named() {
        throw new Rejected("no");
      }

      @Process("other")
      other() {
        throw new Error("other");
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const named = await queue.add("named", {}, { attempts: 3 });
    const outcome = await settled(named.id);
    expect(outcome.attemptsMade).toBe(1);
    expect(outcome.error).toBeInstanceOf(UnrecoverableJobError);
    expect(outcome.error?.message).toBe("no");
    expect(outcome.error?.cause).toBeInstanceOf(Rejected);

    // The control: an error it does not name is retried.
    const other = await queue.add("other", {}, { attempts: 2 });
    expect((await settled(other.id)).attemptsMade).toBe(2);
  });

  it("UnrecoverableOn leaves a route's error alone", async () => {
    @Controller("r")
    @UseFilters(UnrecoverableOn(BadRequestException))
    class Route {
      @Post()
      fail() {
        throw new BadRequestException("nope");
      }
    }

    @Processor("q")
    class Worker {
      @Process()
      run() {}
    }

    @Module({
      imports: jobsImports(),
      controllers: [Route],
      providers: [Worker],
    })
    class AppModule {}

    const { adapter } = await bootHttp(AppModule);
    expect((await post(adapter, "/r", {})).status).toBe(400);
  });

  it("BaseJobExceptionFilter rethrows, and a subclass decides", async () => {
    @Catch()
    class Decides extends BaseJobExceptionFilter {
      override catch(exception: unknown, host: ArgumentsHost) {
        const job = BunJobsExecutionContext.create(host).getJob();
        return job.name === "recover"
          ? "recovered"
          : super.catch(exception, host);
      }
    }

    @Processor("q")
    @UseFilters(Decides)
    class Worker {
      @Process()
      run() {
        throw new Error("boom");
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const recover = await queue.add("recover", {});
    expect((await settled(recover.id)).result).toBe("recovered");
    const fail = await queue.add("fail", {});
    expect((await settled(fail.id)).error?.message).toBe("boom");
  });

  it("an unfiltered error is logged by Nest per attempt, and a rethrowing catch-all keeps it quiet (Q5)", async () => {
    const lines: string[] = [];
    const sink: LoggerService = {
      log: () => {},
      warn: () => {},
      error: (message: unknown) => {
        lines.push(String(message));
      },
    };
    cleanups.push(() => Logger.overrideLogger(false));

    @Catch()
    class Quiet implements ExceptionFilter {
      catch(exception: unknown) {
        throw exception;
      }
    }

    @Processor("q")
    class Worker {
      @Process("loud")
      loud() {
        throw new Error("plain failure");
      }

      @Process("quiet")
      @UseFilters(Quiet)
      quiet() {
        throw new Error("quiet failure");
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule, undefined, sink);
    const loud = await queue.add("loud", {}, { attempts: 2 });
    await settled(loud.id);
    expect(lines.filter((line) => line.includes("plain failure")).length).toBe(
      2,
    );

    const quiet = await queue.add("quiet", {});
    await settled(quiet.id);
    expect(lines.some((line) => line.includes("quiet failure"))).toBe(false);
  });
});

describe("a guard's denial", () => {
  /** A guard that denies by returning false. */
  @Injectable()
  class Deny implements CanActivate {
    canActivate() {
      return false;
    }
  }

  it("ends the job at once as JobForbiddenError, where a route answers 403", async () => {
    let ran = false;

    @Processor("q")
    @UseGuards(Deny)
    class Worker {
      @Process()
      run() {
        ran = true;
      }
    }

    @Controller("r")
    @UseGuards(Deny)
    class Route {
      @Post()
      run() {}
    }

    @Module({
      imports: jobsImports(),
      controllers: [Route],
      providers: [Worker],
    })
    class AppModule {}

    const { adapter, queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("x", {}, { attempts: 3 });
    const outcome = await settled(job.id);

    expect(outcome.state).toBe("dead");
    expect(outcome.attemptsMade).toBe(1);
    expect(outcome.error).toBeInstanceOf(JobForbiddenError);
    expect(outcome.error?.name).toBe("UnrecoverableJobError");
    expect(outcome.error?.message).toContain("Worker.run: a guard denied job");
    expect(outcome.error?.cause).toBeInstanceOf(ForbiddenException);
    expect(ran).toBe(false);

    expect((await post(adapter, "/r", {})).status).toBe(403);
  });

  it('onDenied: "retry" retries it like any error', async () => {
    @Processor("q", { onDenied: "retry" })
    @UseGuards(Deny)
    class Worker {
      @Process()
      run() {}
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("x", {}, { attempts: 2 });
    const outcome = await settled(job.id);
    expect(outcome.attemptsMade).toBe(2);
    expect(outcome.error).toBeInstanceOf(ForbiddenException);
  });

  it("a guard's own exception is its decision, and is left alone", async () => {
    @Injectable()
    class Own implements CanActivate {
      canActivate(): boolean {
        throw new ForbiddenException("not this tenant");
      }
    }

    @Processor("q")
    @UseGuards(Own)
    class Worker {
      @Process()
      run() {}
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("x", {}, { attempts: 2 });
    const outcome = await settled(job.id);
    expect(outcome.attemptsMade).toBe(2);
    expect(outcome.error?.message).toBe("not this tenant");
  });
});

describe("parameter decorators", () => {
  it("all nine fill their parameters, and a method with none is called as (job, ctx)", async () => {
    let seen: Record<string, unknown> = {};
    let plain: unknown[] = [];

    @Processor("q")
    class Worker {
      @Process("decorated")
      async decorated(
        @JobData() data: { to: string },
        @JobData("to") to: string,
        @JobId() id: string,
        @JobName() name: string,
        @CurrentJob() job: Job,
        @JobContext() ctx: ProcessorContext,
        @JobSignal() signal: AbortSignal,
        @JobProgress() progress: JobProgressFn,
        @JobLogger() logger: ProcessorContext["logger"],
        @JobAttempt() attempt: number,
      ) {
        await progress(50);
        seen = { data, to, id, name, job, ctx, signal, logger, attempt };
        return "ok";
      }

      @Process("plain")
      plain(...args: unknown[]) {
        plain = args;
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("decorated", { to: "ada" });
    await settled(job.id);

    expect(seen.data).toEqual({ to: "ada" });
    expect(seen.to).toBe("ada");
    expect(seen.id).toBe(job.id);
    expect(seen.name).toBe("decorated");
    expect((seen.job as Job).id).toBe(job.id);
    const ctx = seen.ctx as ProcessorContext;
    expect(seen.signal).toBe(ctx.signal);
    expect(seen.logger).toBe(ctx.logger);
    expect(seen.attempt).toBe(1);
    expect((await queue.getJob(job.id))?.progress).toBe(50);

    const other = await queue.add("plain", {});
    await settled(other.id);
    expect((plain[0] as Job).id).toBe(other.id);
    expect((plain[1] as ProcessorContext).attempt).toBe(1);
    expect(plain.length).toBe(2);
  });

  it("@JobData takes a property, a pipe, and an object form; @JobId and @JobName take pipes", async () => {
    const upper: PipeTransform = {
      transform: (value: unknown) => String(value).toUpperCase(),
    };
    @Injectable()
    class Twice implements PipeTransform {
      transform(value: unknown) {
        return `${String(value)}${String(value)}`;
      }
    }

    @Processor("q")
    class Worker {
      @Process()
      run(
        @JobData("to", upper) property: string,
        @JobData(upper) whole: string,
        @JobData(Twice) byClass: string,
        @JobData({ property: "to", pipes: [upper] }) object: string,
        @JobId(upper) id: string,
        @JobName(upper) name: string,
      ) {
        return { property, whole, byClass, object, id, name };
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("name", { to: "ada" }, { jobId: "abc" });
    expect((await settled(job.id)).result).toEqual({
      property: "ADA",
      whole: "[OBJECT OBJECT]",
      byClass: "[object Object][object Object]",
      object: "ADA",
      id: "ABC",
      name: "NAME",
    });
  });

  it("a user's createParamDecorator works, and reads the execution context", async () => {
    const Attempt = createParamDecorator(
      (_data: unknown, context: ExecutionContext) => {
        const host = BunJobsExecutionContext.create(context);
        return {
          attempt: host.getProcessorContext().attempt,
          queue: host.getQueueName(),
          handler: host.getHandlerName(),
          job: host.getJob().name,
          isJob: isBunJobsContext(context),
          type: context.getType<string>(),
        };
      },
    );

    @Processor("q")
    class Worker {
      @Process("named")
      named(@Attempt() info: unknown) {
        return info;
      }

      @Process()
      catchAll(@Attempt() info: unknown) {
        return info;
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const named = await queue.add("named", {});
    expect((await settled(named.id)).result).toEqual({
      attempt: 1,
      queue: "q",
      handler: "named",
      job: "named",
      isJob: true,
      type: "bun-jobs",
    });
    const other = await queue.add("other", {});
    expect((await settled(other.id)).result).toMatchObject({
      handler: "*",
      job: "other",
    });
  });

  it("refuses a method with a parameter no decorator fills", async () => {
    @Processor("q")
    class Worker {
      @Process("half")
      half(@JobData() data: unknown, job: Job) {
        return [data, job];
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const message = await bootProblem(AppModule);
    expect(message).toContain("Worker.half: parameter 1 has no decorator");
  });
});

describe("validating job data", () => {
  const Email = z.object({ to: z.string() });

  /** The app and its queue, for a processor class. */
  function appFor(
    worker: Type<unknown>,
    extra: { providers?: unknown[] } = {},
  ) {
    return bootHttp(
      moduleNamed({
        imports: jobsImports(),
        providers: [worker, ...((extra.providers ?? []) as Type<unknown>[])],
      }),
    );
  }

  /** Asserts a bad payload ended the job at once, with issues naming the body. */
  function expectDeadWithIssues(outcome: Outcome) {
    expect(outcome.state).toBe("dead");
    expect(outcome.attemptsMade).toBe(1);
    expect(outcome.error).toBeInstanceOf(UnrecoverableJobError);
    expect(outcome.error?.cause).toBeInstanceOf(StandardValidationException);
    const issues = (outcome.error as UnrecoverableJobError).context?.issues as {
      target: string;
      path: string;
    }[];
    expect(issues[0]?.target).toBe("body");
    expect(issues[0]?.path).toBe("to");
  }

  for (const [library, schema] of [
    ["zod", Email],
    ["valibot", v.object({ to: v.string() })],
  ] as const) {
    it(`StandardSchemaPipe on @JobData validates and transforms with ${library}`, async () => {
      @Processor("q")
      class Worker {
        @Process()
        run(@JobData(new StandardSchemaPipe(schema)) data: { to: string }) {
          return data.to;
        }
      }
      const { queue, settled } = await appFor(Worker);

      const good = await queue.add("x", { to: "ada" });
      expect((await settled(good.id)).result).toBe("ada");
      const bad = await queue.add("x", { to: 42 }, { attempts: 3 });
      expectDeadWithIssues(await settled(bad.id));
    });
  }

  it("@JobData({ schema }) is the same pipe", async () => {
    @Processor("q")
    class Worker {
      @Process()
      run(@JobData({ schema: Email }) data: { to: string }) {
        return data.to;
      }
    }
    const { queue, settled } = await appFor(Worker);

    const good = await queue.add("x", { to: "ada" });
    expect((await settled(good.id)).result).toBe("ada");
    const bad = await queue.add("x", { to: 42 }, { attempts: 3 });
    expectDeadWithIssues(await settled(bad.id));
  });

  it('onInvalid: "retry" retries a failed pipe like any error', async () => {
    @Processor("q", { onInvalid: "retry" })
    class Worker {
      @Process()
      run(@JobData({ schema: Email }) data: { to: string }) {
        return data.to;
      }
    }
    const { queue, settled } = await appFor(Worker);

    const bad = await queue.add("x", { to: 42 }, { attempts: 2 });
    const outcome = await settled(bad.id);
    expect(outcome.attemptsMade).toBe(2);
    expect(outcome.error).toBeInstanceOf(StandardValidationException);
  });

  it("a SchemaDto parameter is checked by the global StandardValidationPipe, as BODY", async () => {
    class EmailDto extends SchemaDto(Email) {}

    @Processor("q")
    class Worker {
      @Process()
      run(@JobData() data: EmailDto) {
        return data.to;
      }
    }
    const { queue, settled } = await appFor(Worker, {
      providers: [{ provide: APP_PIPE, useClass: StandardValidationPipe }],
    });

    const good = await queue.add("x", { to: "ada" });
    expect((await settled(good.id)).result).toBe("ada");
    const bad = await queue.add("x", { to: 42 }, { attempts: 3 });
    expectDeadWithIssues(await settled(bad.id));
  });

  it("negative control: recorded as a custom parameter, that global pipe lets a bad payload through", async () => {
    class EmailDto extends SchemaDto(Email) {}
    const CustomData = createParamDecorator(
      (_data: unknown, context: ExecutionContext) =>
        BunJobsExecutionContext.create(context).getJob().data,
    );

    @Processor("q")
    class Worker {
      @Process()
      run(@CustomData() data: EmailDto) {
        return data.to;
      }
    }
    const { queue, settled } = await appFor(Worker, {
      providers: [{ provide: APP_PIPE, useClass: StandardValidationPipe }],
    });

    const bad = await queue.add("x", { to: 42 });
    const outcome = await settled(bad.id);
    expect(outcome.state).toBe("completed");
    expect(outcome.result).toBe(42);
  });

  it("@JobData({ schema }) validates once, with or without Nest 12's own global pipe", async () => {
    let validations = 0;
    const counting = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => {
          validations += 1;
          return { value };
        },
      },
    } as const;
    const NestPipe = (
      nestCommon as unknown as {
        StandardSchemaValidationPipe?: Type<PipeTransform>;
      }
    ).StandardSchemaValidationPipe;
    // 12.2 has it. Nest 11 does not, and a schema recorded only for it would be
    // silently ignored there, which is why `{ schema }` is the pipe on both.
    if (NEST_MAJOR < 12) {
      expect(NestPipe).toBeUndefined();
    }

    @Processor("q")
    class Worker {
      @Process()
      run(@JobData({ schema: counting }) data: unknown) {
        return data;
      }
    }
    const { queue, settled } = await appFor(Worker, {
      providers:
        NestPipe === undefined
          ? []
          : [{ provide: APP_PIPE, useClass: NestPipe }],
    });

    const job = await queue.add("x", {});
    await settled(job.id);
    expect(validations).toBe(1);
  });

  it("a global ValidationPipe validates a class-validator DTO on a job, and a failure retries unless UnrecoverableOn says otherwise (Q16)", async () => {
    class EmailDto {
      @IsString()
      to!: string;
    }

    @Processor("q")
    class Worker {
      @Process("retried")
      retried(@JobData() data: EmailDto) {
        return data instanceof EmailDto ? data.to : "not transformed";
      }

      @Process("ended")
      @UseFilters(UnrecoverableOn(BadRequestException))
      ended(@JobData() data: EmailDto) {
        return data.to;
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule, (app) => {
      app.useGlobalPipes(new ValidationPipe({ transform: true }));
    });

    const good = await queue.add("retried", { to: "ada" });
    expect((await settled(good.id)).result).toBe("ada");

    const retried = await queue.add("retried", { to: 42 }, { attempts: 2 });
    const first = await settled(retried.id);
    expect(first.attemptsMade).toBe(2);
    expect(first.error).toBeInstanceOf(BadRequestException);

    const ended = await queue.add("ended", { to: 42 }, { attempts: 2 });
    const second = await settled(ended.id);
    expect(second.attemptsMade).toBe(1);
    expect(second.error?.cause).toBeInstanceOf(BadRequestException);
  });
});

describe("enhancers: false", () => {
  /** A guard that would deny, were it asked. */
  @Injectable()
  class Deny implements CanActivate {
    canActivate() {
      return false;
    }
  }

  it("on the module or the class calls the method directly, past every enhancer", async () => {
    for (const where of ["module", "class"] as const) {
      @Processor("q", where === "class" ? { enhancers: false } : {})
      @UseGuards(Deny)
      class Worker {
        @Process()
        run(job: Job, ctx: ProcessorContext) {
          return [job.name, ctx.attempt];
        }
      }

      const AppModule = moduleNamed({
        imports: jobsImports(where === "module" ? { enhancers: false } : {}),
        providers: [Worker],
      });

      const { queue, settled } = await bootHttp(AppModule);
      const job = await queue.add("x", {});
      expect((await settled(job.id)).result).toEqual(["x", 1]);
    }
  });

  it("a class's enhancers: true wins over the module's false", async () => {
    @Processor("q", { enhancers: true })
    @UseGuards(Deny)
    class Worker {
      @Process()
      run() {}
    }

    @Module({
      imports: jobsImports({ enhancers: false }),
      providers: [Worker],
    })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const outcome = await settled((await queue.add("x", {})).id);
    expect(outcome.error).toBeInstanceOf(JobForbiddenError);
  });

  it("refuses parameter decorators it would never read", async () => {
    @Processor("q", { enhancers: false })
    class Worker {
      @Process()
      run(@JobData() data: unknown) {
        return data;
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    expect(await bootProblem(AppModule)).toContain(
      "Worker.run: enhancers: false calls the method as (job, ctx)",
    );
  });
});

describe("the pipeline beside the rest", () => {
  it("runs for a request-scoped processor, with a fresh instance and REQUEST the job", async () => {
    const seen: unknown[] = [];

    @Injectable()
    class Record implements CanActivate {
      canActivate(context: ExecutionContext) {
        seen.push(BunJobsExecutionContext.create(context).getJob().name);
        return true;
      }
    }

    @Processor("q", { scope: Scope.REQUEST })
    @UseGuards(Record)
    class Scoped {
      @Process()
      run(@JobData("n") n: number, @JobAttempt() attempt: number) {
        return [n, attempt];
      }
    }

    @Module({ imports: jobsImports(), providers: [Scoped] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("scoped", { n: 7 });
    expect((await settled(job.id)).result).toEqual([7, 1]);
    expect(seen).toEqual(["scoped"]);
  });

  it("runs for @DefineJob, with its own failure policy", async () => {
    @Injectable()
    class Deny implements CanActivate {
      canActivate() {
        return false;
      }
    }

    @Injectable()
    class Reports {
      @DefineJob("data", { attempts: 3 })
      data(@JobData("month") month: string) {
        return month;
      }

      @DefineJob("denied", { attempts: 3 })
      @UseGuards(Deny)
      denied() {}

      @DefineJob("retried", { attempts: 2, onDenied: "retry" })
      @UseGuards(Deny)
      retried() {}
    }

    const jobsModule = BunJobsModule.forRoot({
      namespace: `nest-pipeline-${crypto.randomUUID().slice(0, 8)}`,
      driver: { type: "memory" },
    });

    @Module({ imports: [jobsModule], providers: [Reports] })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    cleanups.push(() => app.close());
    const { BunJobs } = await import("@kingsleyweb/bun-jobs");
    const jobs = app.get(BunJobs, { strict: false }) as InstanceType<
      typeof BunJobs
    >;
    const registry = await jobs.start();
    const settled = watch(registry as BunQueueWorker<any, any, any>);

    const data = await jobs.now("data", { month: "may" });
    expect((await settled(data.id)).result).toBe("may");
    const denied = await jobs.now("denied", {});
    expect((await settled(denied.id)).attemptsMade).toBe(1);
    const retried = await jobs.now("retried", {});
    expect((await settled(retried.id)).attemptsMade).toBe(2);
  });

  it("the typed form of @Process runs, and refuses a token for another queue", async () => {
    @QueueToken("q")
    abstract class QQueue extends BunQueueClass<
      { to: string },
      string,
      "welcome"
    > {}
    @QueueToken("elsewhere")
    abstract class Elsewhere extends BunQueueClass<{ to: string }, string> {}

    @Processor(QQueue)
    class Worker {
      @Process(QQueue, "welcome", { concurrency: 2 })
      welcome(job: Job<{ to: string }, string>) {
        return job.data.to;
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("welcome", { to: "ada" });
    expect((await settled(job.id)).result).toBe("ada");
    expect((await queue.getLimits())?.names?.welcome).toEqual({
      concurrency: 2,
    });

    @Processor(QQueue)
    class Wrong {
      @Process(Elsewhere)
      run(job: Job<{ to: string }, string>) {
        return job.data.to;
      }
    }

    @Module({ imports: jobsImports(), providers: [Wrong] })
    class WrongModule {}

    expect(await bootProblem(WrongModule)).toContain(
      'Wrong.run: @Process names queue "elsewhere", but the class\'s @Processor is on "q"',
    );
  });

  it("bun-nest's own global enhancers leave a job alone", async () => {
    let calls = 0;

    @Controller("r")
    class Route {
      @Post()
      run() {
        return { ok: true };
      }
    }

    @Processor("q")
    class Worker {
      @Process()
      run() {
        calls += 1;
        return calls;
      }
    }

    @Module({
      imports: [
        ...jobsImports(),
        BunThrottlerModule.forRoot({
          throttlers: [{ limit: 1, ttl: "1m" }],
          globalGuard: true,
        }),
        BunCacheModule.forRoot({ driver: memoryDriver(), sweepInterval: 0 }),
      ],
      controllers: [Route],
      providers: [
        Worker,
        { provide: APP_INTERCEPTOR, useClass: BunCacheInterceptor },
        { provide: APP_FILTER, useClass: ValidationExceptionFilter },
      ],
    })
    class AppModule {}

    const { adapter, queue, settled } = await bootHttp(AppModule);
    // Over the throttler's limit of one, and with the same arguments, so a guard
    // or a cache that touched a job would show.
    const one = await queue.add("x", {});
    const two = await queue.add("x", {});
    expect((await settled(one.id)).result).toBe(1);
    expect((await settled(two.id)).result).toBe(2);

    // The control: the throttler is installed and does answer a route.
    expect((await post(adapter, "/r", {})).status).toBe(201);
    expect((await post(adapter, "/r", {})).status).toBe(429);
  });

  it("refuses @Cacheable on a handler, whichever decorator comes first", async () => {
    @Processor("q")
    class Worker {
      @Process("above")
      @Cacheable({ key: () => "same" })
      async above() {}

      @Cacheable({ key: () => "same" })
      @Process("below")
      async below() {}
    }

    @Module({
      imports: [
        ...jobsImports(),
        BunCacheModule.forRoot({ driver: memoryDriver(), sweepInterval: 0 }),
      ],
      providers: [Worker],
    })
    class AppModule {}

    const message = await bootProblem(AppModule);
    expect(message).toContain("Worker.above: @Cacheable on a job handler");
    expect(message).toContain("Worker.below: @Cacheable on a job handler");
  });
});

describe("JobLoggingInterceptor", () => {
  it("logs one line per attempt through the job's logger, and passes a route through", async () => {
    const events: { level: string; message: string; fields?: object }[] = [];

    @Controller("r")
    @UseInterceptors(JobLoggingInterceptor)
    class Route {
      @Post()
      run() {
        return { ok: true };
      }
    }

    @Processor("q")
    @UseInterceptors(JobLoggingInterceptor)
    class Worker {
      @Process("good")
      good() {
        return "ok";
      }

      @Process("bad")
      bad() {
        throw new Error("boom");
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot({
          namespace: `nest-pipeline-${crypto.randomUUID().slice(0, 8)}`,
          driver: { type: "memory" },
          logger: (event) => {
            events.push(event as never);
          },
        }),
        BunJobsModule.registerQueue({ name: "q" }),
      ],
      controllers: [Route],
      providers: [Worker],
    })
    class AppModule {}

    const { adapter, queue, settled } = await bootHttp(AppModule);
    const good = await queue.add("good", {});
    await settled(good.id);
    const bad = await queue.add("bad", {}, { attempts: 2 });
    await settled(bad.id);

    const lines = events.filter(({ message }) => message.startsWith("job "));
    expect(lines.map(({ message }) => message)).toEqual([
      "job good completed",
      "job bad failed",
      "job bad failed",
    ]);
    expect(lines[0]?.fields).toMatchObject({
      attempt: 1,
      outcome: "completed",
    });
    expect(lines[2]?.fields).toMatchObject({ attempt: 2, outcome: "failed" });
    expect(
      typeof (lines[0]?.fields as { durationMs?: unknown }).durationMs,
    ).toBe("number");

    expect((await post(adapter, "/r", {})).status).toBe(201);
    expect(
      events.filter(({ message }) => message.startsWith("job ")).length,
    ).toBe(3);
  });
});

describe("enhancers Nest would silently skip", () => {
  /** What the guards below record. */
  const asked: string[] = [];
  afterEach(() => {
    asked.length = 0;
  });

  /** A guard class that says it ran. */
  @Injectable()
  class Asked implements CanActivate {
    canActivate() {
      asked.push("class guard");
      return true;
    }
  }
  /** A guard instance that says it ran. */
  const instanceGuard: CanActivate = {
    canActivate() {
      asked.push("instance guard");
      return true;
    },
  };

  it("refuses an enhancer class on a provider made by a factory, which Nest scans for none, on both majors", async () => {
    @Processor("q")
    @UseGuards(Asked)
    class Made {
      @Process()
      run() {}
    }

    @Module({
      imports: jobsImports(),
      providers: [{ provide: "MADE", useFactory: () => new Made() }],
    })
    class AppModule {}

    const message = await bootProblem(AppModule);
    expect(message).toContain("Made.run: Nest would silently not run Asked");
  });

  it("the same on a value provider, and for a class pipe on a parameter", async () => {
    @Injectable()
    class ParamPipe implements PipeTransform {
      transform(value: unknown) {
        return value;
      }
    }

    @Processor("q")
    class Valued {
      @Process()
      run(@JobData(ParamPipe) data: unknown) {
        return data;
      }
    }

    @Module({
      imports: jobsImports(),
      providers: [{ provide: "VALUED", useValue: new Valued() }],
    })
    class AppModule {}

    expect(await bootProblem(AppModule)).toContain(
      "Valued.run: Nest would silently not run ParamPipe",
    );
  });

  it("a factory's processor runs an enhancer given as an instance", async () => {
    @Processor("q")
    @UseGuards(instanceGuard)
    class Made {
      @Process()
      run() {
        return "ran";
      }
    }

    @Module({
      imports: jobsImports(),
      providers: [{ provide: "MADE", useFactory: () => new Made() }],
    })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    const job = await queue.add("x", {});
    expect((await settled(job.id)).result).toBe("ran");
    expect(asked).toEqual(["instance guard"]);
  });

  it("a useClass provider runs a class guard where Nest scans it, and is refused where Nest drops it", async () => {
    @Processor("q")
    @UseGuards(Asked)
    class Used {
      @Process()
      run() {
        return "ran";
      }
    }

    @Module({
      imports: jobsImports(),
      providers: [{ provide: Used, useClass: Used }],
    })
    class AppModule {}

    if (await nestScansUseClass()) {
      const { queue, settled } = await bootHttp(AppModule);
      await settled((await queue.add("x", {})).id);
      expect(asked).toEqual(["class guard"]);
    } else {
      expect(await bootProblem(AppModule)).toContain(
        "Used.run: Nest would silently not run Asked",
      );
    }
  });

  it("the control: a plain class provider runs the class guard", async () => {
    @Processor("q")
    @UseGuards(Asked)
    class Plain {
      @Process()
      run() {
        return "ran";
      }
    }

    @Module({ imports: jobsImports(), providers: [Plain] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    await settled((await queue.add("x", {})).id);
    expect(asked).toEqual(["class guard"]);
  });

  it("a request-scoped APP_GUARD is asked around a singleton processor, as around a route, per job", async () => {
    const instances = new Set<unknown>();

    @Injectable({ scope: Scope.REQUEST })
    class ScopedGuard implements CanActivate {
      canActivate(context: ExecutionContext) {
        asked.push(`scoped:${context.getType()}`);
        return true;
      }
    }

    @Processor("q")
    class Worker {
      @Process()
      run() {
        instances.add(this);
      }
    }

    @Controller("r")
    class Route {
      @Post()
      run() {}
    }

    @Module({
      imports: jobsImports(),
      controllers: [Route],
      providers: [Worker, { provide: APP_GUARD, useClass: ScopedGuard }],
    })
    class AppModule {}

    const { adapter, queue, settled } = await bootHttp(AppModule);
    await settled((await queue.add("x", {})).id);
    await settled((await queue.add("x", {})).id);
    expect(asked.splice(0)).toEqual(["scoped:bun-jobs", "scoped:bun-jobs"]);
    expect(instances.size).toBe(2);
    await post(adapter, "/r", {});
    expect(asked).toEqual(["scoped:http"]);
  });

  it("a transient guard is asked, and leaves the processor a singleton", async () => {
    const instances = new Set<unknown>();

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientGuard implements CanActivate {
      canActivate() {
        asked.push("transient");
        return true;
      }
    }

    @Processor("q")
    @UseGuards(TransientGuard)
    class Worker {
      @Process()
      run() {
        instances.add(this);
      }
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    const { queue, settled } = await bootHttp(AppModule);
    await settled((await queue.add("x", {})).id);
    await settled((await queue.add("x", {})).id);
    expect(asked).toEqual(["transient", "transient"]);
    expect(instances.size).toBe(1);
  });

  it("refuses a request-scoped global beside a processor made by a factory", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ScopedGuard implements CanActivate {
      canActivate() {
        return true;
      }
    }

    @Processor("q")
    class Made {
      @Process()
      run() {}
    }

    @Module({
      imports: jobsImports(),
      providers: [
        { provide: "MADE", useFactory: () => new Made() },
        { provide: APP_GUARD, useClass: ScopedGuard },
      ],
    })
    class AppModule {}

    expect(await bootProblem(AppModule)).toContain(
      "Made: request-scoped global enhancers (ScopedGuard) are not asked",
    );
  });

  it("names the global guards a job will meet, at debug", async () => {
    const lines: string[] = [];
    const sink: LoggerService = {
      log: () => {},
      warn: () => {},
      error: () => {},
      debug: (message: unknown) => {
        lines.push(String(message));
      },
    };
    cleanups.push(() => Logger.overrideLogger(false));

    @Processor("q")
    class Worker {
      @Process()
      run() {}
    }

    @Module({ imports: jobsImports(), providers: [Worker] })
    class AppModule {}

    await bootHttp(
      AppModule,
      (app) => {
        app.useGlobalGuards(new Asked());
      },
      sink,
    );
    expect(lines.join("\n")).toContain("also apply to jobs");
    expect(lines.join("\n")).toContain("Asked");
  });
});

describe("Nest's values, by value", () => {
  it("equal Nest's constants", () => {
    expect(NEST_BODY_PARAMTYPE).toBe(RouteParamtypes.BODY);
    expect(NEST_ENTRY_PROVIDER_WATERMARK).toBe(ENTRY_PROVIDER_WATERMARK);
    expect(NEST_FORBIDDEN_MESSAGE).toBe(FORBIDDEN_MESSAGE);
    expect(NEST_ENHANCER_METADATA).toEqual([
      GUARDS_METADATA,
      INTERCEPTORS_METADATA,
      PIPES_METADATA,
      EXCEPTION_FILTERS_METADATA,
    ]);
    // Our own parameter types stay above every type Nest has.
    for (const type of Object.values(JobParamType)) {
      expect(Object.values(RouteParamtypes)).not.toContain(type);
    }
  });
});
