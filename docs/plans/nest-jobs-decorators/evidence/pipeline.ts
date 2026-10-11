/**
 * Q: Do Nest guards, interceptors, pipes, exception filters and custom
 * parameter decorators run around a bun-jobs handler through
 * ExternalContextCreator, under a context type of our own? Do the global
 * ones (APP_GUARD, useGlobalInterceptors) reach it? What does a filter's
 * return value do to the job? What does Nest log by default on a job error?
 *
 * Run: bun pipeline.ts
 */
import "reflect-metadata";
import type { CallHandler, ExceptionFilter, ArgumentsHost, CanActivate, ExecutionContext, NestInterceptor, PipeTransform } from "@nestjs/common";
import { BunJobs, MemoryDriver, UnrecoverableJobError } from "@kingsleyweb/bun-jobs";
import { toStandardSchema } from "@kingsleyweb/bun-common";
import { BadRequestException, Catch, createParamDecorator, Injectable, Module, SetMetadata, UseFilters, UseGuards, UseInterceptors } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { tap } from "rxjs";
import { InjectQueue, JobData, JobId, JOBS_CONTEXT, Process, Processor, ProtoJobsModule, queueProvider, switchToJob, until } from "./proto";

const log: string[] = [];
const say = (line: string) => { log.push(line); console.log(line); };

/* A Standard Schema pipe: what a JobDataPipe over bun-common's schema type would do. */
const Email = toStandardSchema<{ to: string }>((value) =>
  typeof value === "object" && value !== null && typeof (value as { to?: unknown }).to === "string"
    ? { value: value as { to: string } }
    : { issues: [{ message: "to must be a string", path: ["to"] }] });
@Injectable()
class SchemaPipe implements PipeTransform {
  async transform(value: unknown) {
    const result = await Email["~standard"].validate(value);
    if (result.issues) throw new BadRequestException(result.issues.map((i) => i.message).join("; "));
    return result.value;
  }
}

/* A guard reading metadata through Reflector, and checking the context type. */
const RequiresFlag = (flag: string) => SetMetadata("flag", flag);
@Injectable()
class FlagGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const flag = this.reflector.get<string>("flag", context.getHandler());
    const job = switchToJob(context).getJob<{ to: string }>();
    say(`guard: type=${context.getType()} class=${context.getClass().name} handler=${context.getHandler().name} flag=${flag} job=${job.name}`);
    return flag !== "off" || job.data.to !== "blocked@example.com";
  }
}

/* A global guard registered as APP_GUARD, written for HTTP, as many apps have. */
@Injectable()
class GlobalHttpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    say(`global APP_GUARD: type=${context.getType()}`);
    // The idiom the plan recommends documenting: let non-HTTP contexts pass.
    if (context.getType<string>() !== "http") return true;
    return Boolean(context.switchToHttp().getRequest()?.headers?.authorization);
  }
}

@Injectable()
class TimingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const started = performance.now();
    const job = switchToJob(context).getJob();
    return next.handle().pipe(tap({
      next: (value) => say(`interceptor: ${job.name}#${job.id} -> ${JSON.stringify(value)} in ${(performance.now() - started).toFixed(2)} ms`),
      error: (error: Error) => say(`interceptor: ${job.name}#${job.id} threw ${error.constructor.name}: ${error.message}`),
    }));
  }
}

/* Maps a validation failure to "no retry will help": UnrecoverableJobError. */
@Catch(BadRequestException)
class InvalidDataFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost) {
    say(`filter: type=${host.getType()} ${exception.message} -> UnrecoverableJobError`);
    throw new UnrecoverableJobError(`invalid data: ${exception.message}`);
  }
}

/* A filter that RETURNS instead of rethrowing: what happens to the job? */
@Catch(TypeError)
class SwallowFilter implements ExceptionFilter {
  catch(exception: TypeError) {
    say(`filter: swallowing ${exception.message} and returning "recovered"`);
    return "recovered";
  }
}

/* A user's own param decorator, written the documented way. */
const Attempt = createParamDecorator((_data: unknown, context: ExecutionContext) => switchToJob(context).getContext().attempt);

@Processor("emails", { concurrency: 2 })
@UseInterceptors(TimingInterceptor)
class EmailProcessor {
  @Process("welcome")
  @UseGuards(FlagGuard)
  @RequiresFlag("off")
  @UseFilters(InvalidDataFilter)
  welcome(@JobData(SchemaPipe) data: { to: string }, @JobId() id: string, @Attempt() attempt: number) {
    say(`handler: welcome to=${data.to} id=${id} attempt=${attempt}`);
    return `sent:${data.to}`;
  }

  @Process("flaky")
  @UseFilters(SwallowFilter)
  flaky() {
    throw new TypeError("boom");
  }

  @Process("plain-error")
  plainError() {
    throw new Error("plain failure");
  }
}

@Injectable()
class Producer {
  constructor(@InjectQueue("emails") readonly queue: import("@kingsleyweb/bun-jobs").BunQueue) {}
}

const jobs = new BunJobs({ namespace: "nestjobs-pipeline", driver: new MemoryDriver() });

@Module({
  imports: [ProtoJobsModule.forRoot({ jobs, trace: say })],
  providers: [EmailProcessor, Producer, queueProvider("emails"), { provide: APP_GUARD, useClass: GlobalHttpGuard }],
})
class AppModule {}

// An HTTP application with jobs in it: the usual shape.
const app = await NestFactory.create(AppModule, new BunHttpAdapter(), { logger: ["error"] });
app.useGlobalInterceptors({
  intercept: (context: ExecutionContext, next: CallHandler) => {
    say(`global interceptor (app.useGlobalInterceptors): type=${context.getType()}`);
    return next.handle();
  },
});
await app.init();

const queue = app.get(Producer).queue;
const worker = jobs as BunJobs;
const results = new Map<string, string>();
const finished = (id: string) => results.has(id);
const w = (await import("./proto")).Explorer;
const explorer = app.get(w);
for (const wk of explorer.workers) {
  wk.on("completed", (job, result) => results.set(job.id, `completed: ${JSON.stringify(result)}`));
  wk.on("dead", (job, error) => results.set(job.id, `dead: ${error.constructor.name}: ${error.message} (attemptsMade=${job.attemptsMade})`));
}

console.log("\n--- 1. a valid job: guard, pipe, interceptor, custom param decorator");
const ok = await queue.add("welcome", { to: "ada@example.com" }, { attempts: 3 });
await until(() => finished(ok.id));
say(`job ${ok.id}: ${results.get(ok.id)}`);

console.log("\n--- 2. invalid data: the pipe throws BadRequestException, the filter maps it to UnrecoverableJobError");
const bad = await queue.add("welcome", { to: 42 }, { attempts: 3 });
await until(() => finished(bad.id));
say(`job ${bad.id}: ${results.get(bad.id)}`);

console.log("\n--- 3. guard denies: ForbiddenException, retried until attempts run out");
const denied = await queue.add("welcome", { to: "blocked@example.com" }, { attempts: 2, backoff: 1 });
await until(() => finished(denied.id));
say(`job ${denied.id}: ${results.get(denied.id)}`);

console.log("\n--- 4. a filter that returns a value: the job COMPLETES with it");
const flaky = await queue.add("flaky", {}, { attempts: 1 });
await until(() => finished(flaky.id));
say(`job ${flaky.id}: ${results.get(flaky.id)}`);

console.log("\n--- 5. a plain error with no filter: Nest's ExternalExceptionFilter logs it (stderr above/below) and rethrows");
const plain = await queue.add("plain-error", {}, { attempts: 1 });
await until(() => finished(plain.id));
say(`job ${plain.id}: ${results.get(plain.id)}`);

await app.close();
void worker;
console.log(`\ncontext type constant: ${JOBS_CONTEXT}`);
