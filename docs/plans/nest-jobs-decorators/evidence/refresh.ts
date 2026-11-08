/**
 * Q (refresh, 2026-11-08): do the Nest APIs the refreshed design adds or
 * leans on behave the same on Nest 11 (11.2.7) and Nest 12 (12.2.0)?
 *
 * 1. ConfigurableModuleBuilder with setClassMethodName("forRoot") and an
 *    `isGlobal` extra: forRoot, forRootAsync with useFactory, useClass and
 *    useExisting, and the module really global (a feature module that does
 *    not import it can inject its options).
 * 2. ContextIdFactory.getByRequest(job) with a durable ContextIdStrategy:
 *    the strategy sees a bun-jobs Job, and what the call leaves on the job
 *    (if anything) does not reach JSON.stringify(job).
 * 3. Nest 12 only: a job parameter decorator that records a Standard Schema
 *    under ROUTE_ARGS_METADATA's `schema` field, validated by Nest's own
 *    StandardSchemaValidationPipe as a global pipe (APP_PIPE), under the "bun-jobs"
 *    context type. On Nest 11 the pipe does not exist; the case says so.
 * 5. bun-validate V6's pipes (bun-nest root) on a job parameter, on both
 *    majors: StandardSchemaPipe as a parameter pipe, and the global
 *    StandardValidationPipe (APP_PIPE) on a SchemaDto-typed parameter, with
 *    @JobData recorded as Nest's BODY paramtype (3, what microservices'
 *    @Payload uses) and as one of our own types (reported as "custom").
 * 4. The order Nest runs onModuleDestroy for two providers of ONE module
 *    when one depends on the other (the lifecycle F case, reduced).
 *
 * Run from this folder (R3): bun refresh.ts
 */
import "reflect-metadata";
import type { ContextIdStrategy, HostComponentInfo } from "@nestjs/core";
import { BunJobs, MemoryDriver } from "@kingsleyweb/bun-jobs";
import * as common from "@nestjs/common";
import { ConfigurableModuleBuilder, Inject, Injectable, Module, Scope } from "@nestjs/common";
import { APP_PIPE, ContextIdFactory, NestFactory, REQUEST } from "@nestjs/core";
import type { BunQueueWorker } from "@kingsleyweb/bun-jobs";
import { Explorer, Process, Processor, ProtoJobsModule, until } from "./proto";

function watch(workers: BunQueueWorker[]) {
  const settled = new Map<string, string>();
  for (const w of workers) {
    w.on("completed", (job, result) => settled.set(job.id, `completed: ${JSON.stringify(result)}`));
    w.on("dead", (job, error) => settled.set(job.id, `dead: ${error.constructor.name}: ${error.message.split("\n")[0]} (attemptsMade=${job.attemptsMade})`));
  }
  return settled;
}

const nestVersion = (await import("@nestjs/core/package.json", { with: { type: "json" } })).default.version as string;
console.log(`# bun refresh.ts — ${new Date().toISOString()}, Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), @nestjs/core ${nestVersion}`);
const results: string[] = [];
const report = (line: string) => { results.push(line); console.log(line); };

/* --- 1. ConfigurableModuleBuilder ---------------------------------------- */

interface JobsModuleOptions { namespace: string }
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<JobsModuleOptions>()
  .setClassMethodName("forRoot")
  .setExtras({ isGlobal: true }, (definition, extras) => ({ ...definition, global: extras.isGlobal }))
  .build();

@Module({ exports: [MODULE_OPTIONS_TOKEN] })
class JobsModule extends ConfigurableModuleClass {}

@Injectable()
class Reader {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) readonly options: JobsModuleOptions) {}
}
@Module({ providers: [Reader] })
class FeatureModule {}

@Injectable()
class OptionsFactory {
  create(): JobsModuleOptions { return { namespace: "from-class" }; }
}
@Module({ providers: [OptionsFactory], exports: [OptionsFactory] })
class FactoryHost {}

async function moduleCase(label: string, root: common.DynamicModule) {
  @Module({ imports: [root, FeatureModule] })
  class App {}
  try {
    const app = await NestFactory.createApplicationContext(App, { logger: false, abortOnError: false });
    const ns = app.get(Reader).options.namespace;
    report(`1. ${label.padEnd(36)} -> feature module (no import) read namespace=${ns}; global=${root.global}`);
    await app.close();
  } catch (error) {
    report(`1. ${label.padEnd(36)} -> FAILED: ${(error as Error).message.split("\n")[0]}`);
  }
}
await moduleCase("forRoot (default isGlobal: true)", JobsModule.forRoot({ namespace: "sync" }));
await moduleCase("forRootAsync useFactory", JobsModule.forRootAsync({ useFactory: () => ({ namespace: "factory" }) }));
await moduleCase("forRootAsync useClass", JobsModule.forRootAsync({ useClass: class implements common.ConfigurableModuleOptionsFactory<JobsModuleOptions, "create"> { create() { return { namespace: "use-class" }; } } }));
await moduleCase("forRootAsync useExisting", JobsModule.forRootAsync({ imports: [FactoryHost], useExisting: OptionsFactory }));
await moduleCase("forRoot isGlobal: false (expect failure)", JobsModule.forRoot({ namespace: "local", isGlobal: false }));

/* --- 2. getByRequest(job) with a durable strategy ------------------------- */

const seen: string[] = [];
class TenantStrategy implements ContextIdStrategy {
  attach(contextId: ReturnType<typeof ContextIdFactory.create>, request: unknown) {
    const isJob = typeof request === "object" && request !== null && "attemptsMade" in request && "data" in request;
    seen.push(isJob ? `job(tenant=${(request as { data: { tenant: string } }).data.tenant})` : "not a job");
    return (info: HostComponentInfo) => (info.isTreeDurable ? contextId : contextId);
  }
}
ContextIdFactory.apply(new TenantStrategy());

const jobs2 = new BunJobs({ namespace: `refresh-${crypto.randomUUID()}`, driver: new MemoryDriver() });
let jobJson = "";
let symbolsOnJob = 0;
let requestIsJob = 0;

@Processor("tenants", { scope: Scope.REQUEST })
class TenantProcessor {
  constructor(@Inject(REQUEST) private readonly request: unknown) {}
  @Process()
  run(job: { data: unknown }) {
    if (this.request === job) requestIsJob++;
    // What the design does before resolving: ask the strategy through getByRequest.
    ContextIdFactory.getByRequest(job as never);
    symbolsOnJob = Object.getOwnPropertySymbols(job).length;
    jobJson = JSON.stringify(job);
    return "ok";
  }
}
@Module({ imports: [ProtoJobsModule.forRoot({ jobs: jobs2 })], providers: [TenantProcessor] })
class ScopedApp {}
{
  const app = await NestFactory.createApplicationContext(ScopedApp, { logger: false });
  await app.init();
  const settled = watch(app.get(Explorer).workers);
  const job = await jobs2.queue("tenants").add("t", { tenant: "acme" });
  await until(() => settled.has(job.id));
  report(`2. job: ${settled.get(job.id)}`);
  report(`2. strategy saw: ${seen.join(", ") || "nothing"}; REQUEST was the job: ${requestIsJob === 1}`);
  report(`2. own symbol properties on the job after getByRequest: ${symbolsOnJob}; JSON carries a context id: ${/contextId|REQUEST_CONTEXT/i.test(jobJson)}`);
  await app.close();
  await jobs2.close();
}
ContextIdFactory.apply({ attach: (id) => () => id } as ContextIdStrategy);

/* --- 3. Nest 12's StandardSchemaValidationPipe on a job parameter -------- */

const SchemaPipeClass = (common as Record<string, unknown>).StandardSchemaValidationPipe as
  | (new (options?: { validateCustomDecorators?: boolean }) => common.PipeTransform)
  | undefined;
if (!SchemaPipeClass) {
  report("3. StandardSchemaValidationPipe: not exported by @nestjs/common (Nest 11): case skipped");
} else {
  const StandardSchemaValidationPipe = SchemaPipeClass;
  const { ROUTE_ARGS_METADATA } = await import("@nestjs/common/constants.js");
  const Email = {
    "~standard": {
      version: 1 as const,
      vendor: "probe",
      validate: (value: unknown) =>
        typeof value === "object" && value !== null && typeof (value as { to?: unknown }).to === "string"
          ? { value }
          : { issues: [{ message: "to must be a string", path: ["to"] }] },
    },
  };
  // A @JobData({ schema }) that writes the schema where Nest 12's ECC reads it.
  // `type` is the numeric param type stored in the key: one of our own
  // (11, JobParam.Data: Nest reports it to pipes as "custom"); 3 is RouteParamtypes.BODY, which
  // Nest reports as "body". The prototype's paramsFactory answers job.data
  // for both.
  const JobDataWithSchema = (schema: unknown, type = 11): ParameterDecorator => (target, key, index) => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, key!) ?? {};
    Reflect.defineMetadata(ROUTE_ARGS_METADATA, { ...args, [`${type}:${index}`]: { index, data: undefined, pipes: [], schema } }, target.constructor, key!);
  };
  const jobs3 = new BunJobs({ namespace: `refresh-${crypto.randomUUID()}`, driver: new MemoryDriver() });
  const outcomes: string[] = [];
  @Processor("schema")
  class SchemaProcessor {
    @Process("global")
    run(@JobDataWithSchema(Email) data: { to: string }) { return `sent:${data.to}`; }

    @Process("method")
    @common.UsePipes(new StandardSchemaValidationPipe())
    method(@JobDataWithSchema(Email) data: { to: string }) { return `sent:${data.to}`; }

    @Process("custom-on")
    @common.UsePipes(new StandardSchemaValidationPipe({ validateCustomDecorators: true }))
    customOn(@JobDataWithSchema(Email) data: { to: string }) { return `sent:${data.to}`; }

    @Process("as-body")
    asBody(@JobDataWithSchema(Email, 3) data: { to: string }) { return `sent:${data.to}`; }
  }
  @Module({
    imports: [ProtoJobsModule.forRoot({ jobs: jobs3, quietFilters: true })],
    providers: [SchemaProcessor, { provide: APP_PIPE, useValue: new StandardSchemaValidationPipe() }],
  })
  class SchemaApp {}
  const app = await NestFactory.createApplicationContext(SchemaApp, { logger: false });
  await app.init();
  const settled = watch(app.get(Explorer).workers);
  const q = jobs3.queue("schema");
  const labels: Record<string, string> = {
    "global": "APP_PIPE, type custom          ",
    "method": "@UsePipes, type custom         ",
    "custom-on": "@UsePipes validateCustomDecorators",
    "as-body": "APP_PIPE, type body            ",
  };
  for (const name of Object.keys(labels)) {
    outcomes.length = 0;
    for (const data of [{ to: "ada@example.com" }, { to: 42 }]) {
      const job = await q.add(name, data, { attempts: 1 });
      await until(() => settled.has(job.id));
      outcomes.push(`${JSON.stringify(data)} -> ${settled.get(job.id)}`);
    }
    report(`3. StandardSchemaValidationPipe, ${labels[name]} + { schema }: ${outcomes.join(" | ")}`);
  }
  await app.close();
  await jobs3.close();
}

/* --- 5. bun-validate V6's pipes on a job parameter ----------------------- */
{
  const { SchemaDto, StandardSchemaPipe, StandardValidationPipe } = await import("@kingsleyweb/bun-nest");
  const { toStandardSchema } = await import("@kingsleyweb/bun-common");
  const { ROUTE_ARGS_METADATA } = await import("@nestjs/common/constants.js");
  const Email = toStandardSchema<{ to: string }>((value) =>
    typeof value === "object" && value !== null && typeof (value as { to?: unknown }).to === "string"
      ? { value: value as { to: string } }
      : { issues: [{ message: "to must be a string", path: ["to"] }] });
  class EmailDto extends SchemaDto(Email) {}
  const JobDataAs = (type: number, ...pipes: common.PipeTransform[]): ParameterDecorator => (target, key, index) => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, key!) ?? {};
    Reflect.defineMetadata(ROUTE_ARGS_METADATA, { ...args, [`${type}:${index}`]: { index, data: undefined, pipes } }, target.constructor, key!);
  };
  const BODY = 3;
  const OWN = 11; // the prototype's JobParam.Data
  const jobs5 = new BunJobs({ namespace: `refresh-${crypto.randomUUID()}`, driver: new MemoryDriver() });
  @Processor("v6")
  class V6Processor {
    @Process("pipe-body")
    pipeBody(@JobDataAs(BODY, new StandardSchemaPipe(Email)) data: { to: string }) { return `sent:${data.to}`; }

    @Process("pipe-own")
    pipeOwn(@JobDataAs(OWN, new StandardSchemaPipe(Email)) data: { to: string }) { return `sent:${data.to}`; }

    @Process("dto-body")
    dtoBody(@JobDataAs(BODY) data: EmailDto) { return `sent:${(data as { to: string }).to}`; }

    @Process("dto-own")
    dtoOwn(@JobDataAs(OWN) data: EmailDto) { return `sent:${(data as { to: string }).to}`; }
  }
  @Module({
    imports: [ProtoJobsModule.forRoot({ jobs: jobs5, quietFilters: true })],
    providers: [V6Processor, { provide: APP_PIPE, useValue: new StandardValidationPipe() }],
  })
  class V6App {}
  const app = await NestFactory.createApplicationContext(V6App, { logger: false });
  await app.init();
  const issues = new Map<string, string>();
  for (const w of app.get(Explorer).workers) {
    w.on("dead", (job, error) => issues.set(job.id, JSON.stringify((error as { issues?: unknown }).issues ?? null)));
  }
  const settled = watch(app.get(Explorer).workers);
  const q = jobs5.queue("v6");
  const labels: Record<string, string> = {
    "pipe-body": "StandardSchemaPipe, @JobData as BODY         ",
    "pipe-own": "StandardSchemaPipe, @JobData as own type     ",
    "dto-body": "APP_PIPE StandardValidationPipe, SchemaDto, BODY",
    "dto-own": "APP_PIPE StandardValidationPipe, SchemaDto, own ",
  };
  for (const name of Object.keys(labels)) {
    const outcomes: string[] = [];
    for (const data of [{ to: "ada@example.com" }, { to: 42 }]) {
      const job = await q.add(name, data, { attempts: 1 });
      await until(() => settled.has(job.id));
      outcomes.push(`${JSON.stringify(data)} -> ${settled.get(job.id)}${issues.has(job.id) ? ` issues=${issues.get(job.id)}` : ""}`);
    }
    report(`5. ${labels[name]}: ${outcomes.join(" | ")}`);
  }
  await app.close();
  await jobs5.close();
}

/* --- 4. onModuleDestroy order inside one module -------------------------- */

const order: string[] = [];
@Injectable()
class Db { onModuleDestroy() { order.push("Db"); } }
@Injectable()
class UsesDb {
  constructor(@Inject(Db) readonly db: Db) {}
  async onModuleDestroy() { await Bun.sleep(20); order.push("UsesDb (after 20 ms)"); }
}
@Module({ providers: [Db, UsesDb] })
class OneModule {}
{
  const app = await NestFactory.createApplicationContext(OneModule, { logger: false });
  await app.close();
  report(`4. onModuleDestroy order in one module (UsesDb depends on Db): ${order.join(" -> ")}`);
}
