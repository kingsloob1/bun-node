/**
 * A throwaway prototype of the integration the plan proposes, kept as small
 * as it can be while running the real Nest pipeline around real bun-jobs
 * workers. It is NOT the design: names, options and error handling are cut to
 * what the spikes need. Every spike in this folder imports it.
 *
 * What it does:
 * - `@Processor(queue)` on a class, `@Process(name?)` on its methods;
 * - `@JobData()`, `@JobId()`, `@Job()`, `@JobSignal()`, `@JobCtx()` parameter
 *   decorators, stored under Nest's own ROUTE_ARGS_METADATA key, so a user's
 *   `createParamDecorator` works on a job handler too;
 * - an explorer that, at `onApplicationBootstrap`, discovers processors with
 *   DiscoveryService + MetadataScanner, wraps each method with
 *   ExternalContextCreator under the context type "bun-jobs", and starts one
 *   BunQueueWorker per class through a BunJobs context;
 * - request-scoped processors resolved per job (ContextIdFactory + ModuleRef);
 * - workers drained in a configurable hook, so lifecycle.ts can compare them.
 */
import type {
  DynamicModule,
  ExecutionContext,
  OnApplicationBootstrap,
  OnModuleDestroy,
  BeforeApplicationShutdown,
  PipeTransform,
  Type,
} from "@nestjs/common";
import type { ParamsFactory } from "@nestjs/core";
import type {
  BunQueueWorker,
  BunQueueWorkerOptions,
  Job,
  JobProcessor,
  ProcessorContext,
} from "@kingsleyweb/bun-jobs";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import {
  Inject,
  Injectable,
  Module,
  Scope,
  SetMetadata,
} from "@nestjs/common";
import { ROUTE_ARGS_METADATA, SCOPE_OPTIONS_METADATA } from "@nestjs/common/constants.js";
import { assignMetadata } from "@nestjs/common/decorators/http/route-params.decorator.js";
import {
  ContextIdFactory,
  DiscoveryModule,
  DiscoveryService,
  ExternalContextCreator,
  MetadataScanner,
  ModuleRef,
} from "@nestjs/core";

export const JOBS_CONTEXT = "bun-jobs" as const;
export type JobsContextType = typeof JOBS_CONTEXT;

const PROCESSOR = "bun-jobs:processor";
const PROCESS = "bun-jobs:process";
export const BUN_JOBS = Symbol("BUN_JOBS");
const OPTIONS = Symbol("BUN_JOBS_OPTIONS");

/* --- decorators ------------------------------------------------------ */

export interface ProcessorOptions
  extends Omit<BunQueueWorkerOptions, "namespace" | "driver"> {
  /** Nest scope of the class; REQUEST resolves a fresh instance per job. */
  scope?: Scope;
}

export function Processor(queue: string, options: ProcessorOptions = {}): ClassDecorator {
  return (target) => {
    SetMetadata(PROCESSOR, { queue, options })(target);
    // What @Injectable({ scope }) records, so the class needs no second decorator.
    SetMetadata(SCOPE_OPTIONS_METADATA, { scope: options.scope })(target);
  };
}

/** Marks a method as the handler of `name`, or of every name when omitted. */
export const Process = (name = "*"): MethodDecorator => SetMetadata(PROCESS, name);

enum JobParam {
  Job,
  Data,
  Id,
  Signal,
  Ctx,
}

function jobParam(type: JobParam) {
  return (...pipes: (Type<PipeTransform> | PipeTransform)[]): ParameterDecorator =>
    (target, key, index) => {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, key!) ?? {};
      Reflect.defineMetadata(
        ROUTE_ARGS_METADATA,
        assignMetadata(args, type, index, undefined, ...pipes),
        target.constructor,
        key!,
      );
    };
}
export const JobArg = jobParam(JobParam.Job);
export const JobData = jobParam(JobParam.Data);
export const JobId = jobParam(JobParam.Id);
export const JobSignal = jobParam(JobParam.Signal);
export const JobCtx = jobParam(JobParam.Ctx);

/** How the handler's (job, ctx) become each decorated parameter. */
const paramsFactory: ParamsFactory = {
  exchangeKeyForValue(type, _data, args: [Job, ProcessorContext]) {
    const [job, ctx] = args;
    switch (type as JobParam) {
      case JobParam.Job:
        return job;
      case JobParam.Data:
        return job.data;
      case JobParam.Id:
        return job.id;
      case JobParam.Signal:
        return ctx.signal;
      case JobParam.Ctx:
        return ctx;
    }
    return undefined;
  },
};

/** The job half of an ExecutionContext: what `switchToJob()` would return. */
export function switchToJob(context: Pick<ExecutionContext, "getArgByIndex">) {
  return {
    getJob: <T = unknown>() => context.getArgByIndex<Job<T>>(0),
    getContext: () => context.getArgByIndex<ProcessorContext>(1),
  };
}

/* --- module and explorer -------------------------------------------- */

export interface ProtoOptions {
  jobs: BunJobs;
  /** Which hook drains the workers: lifecycle.ts compares them. */
  drainIn?: "onModuleDestroy" | "beforeApplicationShutdown" | "processorModule";
  /** Pass `filters: false` and rethrow without Nest's logging fallback. */
  quietFilters?: boolean;
  /** Called with each event the explorer wants to show. */
  trace?: (line: string) => void;
}

@Injectable()
export class Explorer implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  readonly workers: BunQueueWorker[] = [];

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(ExternalContextCreator) private readonly ecc: ExternalContextCreator,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(OPTIONS) private readonly options: ProtoOptions,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const metatype = wrapper.metatype as Type | undefined;
      if (!metatype || !wrapper.instance && wrapper.isDependencyTreeStatic()) continue;
      const meta = Reflect.getMetadata(PROCESSOR, metatype) as
        | { queue: string; options: ProcessorOptions }
        | undefined;
      if (!meta) continue;

      const methods = this.scanner
        .getAllMethodNames(metatype.prototype)
        .map((method) => ({ method, name: Reflect.getMetadata(PROCESS, metatype.prototype[method]) as string | undefined }))
        .filter((m): m is { method: string; name: string } => m.name !== undefined);

      const isStatic = wrapper.isDependencyTreeStatic();
      const build = (instance: object, contextId?: ReturnType<typeof ContextIdFactory.create>) =>
        new Map(
          methods.map(({ method, name }) => [
            name,
            this.ecc.create(
              instance,
              (instance as Record<string, (...a: unknown[]) => unknown>)[method]!,
              method,
              ROUTE_ARGS_METADATA,
              paramsFactory,
              contextId,
              undefined,
              { guards: true, interceptors: true, filters: !this.options.quietFilters },
              JOBS_CONTEXT,
            ),
          ]),
        );

      const staticHandlers = isStatic ? build(wrapper.instance as object) : undefined;
      const processor: JobProcessor = async (job, ctx) => {
        let handlers = staticHandlers;
        if (!handlers) {
          // A request-scoped processor: a fresh DI sub-tree per job, with the
          // job registered as REQUEST for anything in it that injects REQUEST.
          const contextId = ContextIdFactory.create();
          this.moduleRef.registerRequestByContextId(job, contextId);
          const instance = await this.moduleRef.resolve(metatype, contextId, { strict: false });
          handlers = build(instance, contextId);
        }
        const handler = handlers.get(job.name) ?? handlers.get("*");
        if (!handler) throw new Error(`no @Process for "${job.name}" on ${metatype.name}`);
        try {
          return await handler(job, ctx);
        } catch (error) {
          if (this.options.quietFilters) throw error;
          throw error;
        }
      };

      const { scope: _scope, ...workerOptions } = meta.options;
      const worker = this.options.jobs.worker(meta.queue, processor, workerOptions);
      this.workers.push(worker);
      void worker.run();
      this.options.trace?.(`explorer: worker started on "${meta.queue}" for ${metatype.name} (${isStatic ? "singleton" : "per-job scope"})`);

      if (this.options.drainIn === "processorModule" && isStatic) {
        // Attach the drain to the processor instance's own lifecycle, so it
        // runs when that instance's module is destroyed.
        const instance = wrapper.instance as { onModuleDestroy?: () => unknown };
        const own = instance.onModuleDestroy?.bind(instance);
        Object.defineProperty(instance, "onModuleDestroy", {
          configurable: true,
          value: async () => {
            this.options.trace?.(`drain(${metatype.name}): closing its worker`);
            await worker.close();
            this.options.trace?.(`drain(${metatype.name}): worker closed`);
            await own?.();
          },
        });
      }
    }
  }

  async #drain(hook: string): Promise<void> {
    this.options.trace?.(`${hook}: closing ${this.workers.length} worker(s)`);
    await Promise.all(this.workers.map((w) => w.close()));
    this.options.trace?.(`${hook}: workers closed`);
  }

  async onModuleDestroy(): Promise<void> {
    if ((this.options.drainIn ?? "onModuleDestroy") === "onModuleDestroy") await this.#drain("onModuleDestroy");
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.options.drainIn === "beforeApplicationShutdown") await this.#drain("beforeApplicationShutdown");
  }
}

@Module({})
export class ProtoJobsModule {
  static forRoot(options: ProtoOptions, global = true): DynamicModule {
    return {
      module: ProtoJobsModule,
      global,
      imports: [DiscoveryModule],
      providers: [
        { provide: OPTIONS, useValue: options },
        { provide: BUN_JOBS, useValue: options.jobs },
        { provide: BunJobs, useExisting: BUN_JOBS },
        Explorer,
      ],
      exports: [BUN_JOBS, BunJobs],
    };
  }
}

/** `@InjectQueue(name)`: a factory provider per queue, as registerQueue would add. */
export const queueToken = (name: string) => `bun-jobs:queue:${name}`;
export const InjectQueue = (name: string) => Inject(queueToken(name));
export function queueProvider(name: string) {
  return { provide: queueToken(name), useFactory: (jobs: BunJobs) => jobs.queue(name), inject: [BUN_JOBS] };
}

/** Waits for a predicate, polling; spikes only. */
export async function until(predicate: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}
