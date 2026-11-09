import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type {
  RemoteContext,
  RemoteExecutor,
  RemoteExecutorOptions,
  RemoteJobHandler,
} from "@kingsleyweb/bun-jobs/remote";
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OnApplicationBootstrap,
  OnModuleInit,
  OptionalFactoryDependency,
} from "@nestjs/common";
import type { Wrapper } from "./explorer";
import type { OnDenied, OnInvalid } from "./pipeline";
import { ConfigError, resolveLogger } from "@kingsleyweb/bun-common";
import { createRemoteExecutor } from "@kingsleyweb/bun-jobs/remote";
import { Logger, Module, SetMetadata } from "@nestjs/common";
import {
  DiscoveryModule,
  DiscoveryService,
  ExternalContextCreator,
  HttpAdapterHost,
  MetadataScanner,
  ModuleRef,
} from "@nestjs/core";
import { checkHandlerMethod, classOf, handlerInvoker } from "./explorer";
import { REMOTE_HANDLER_METADATA } from "./metadata";
import { assertNoProblems } from "./registry";

/** What {@link RemoteHandler} takes. */
export interface RemoteHandlerOptions {
  /** See `ProcessorOptions.enhancers`. */
  enhancers?: boolean;
  /** See `ProcessorOptions.onDenied`. */
  onDenied?: OnDenied;
  /** See `ProcessorOptions.onInvalid`. */
  onInvalid?: OnInvalid;
}

/** What {@link RemoteHandler} recorded on a method. */
interface RemoteHandlerMetadata {
  /** The job name. */
  readonly name: string;
  /** The options as given. */
  readonly options: RemoteHandlerOptions | undefined;
}

/**
 * Runs a job on a remote executor from a method of any provider, through the Nest
 * pipeline, under the `"bun-jobs"` context type. `BunRemoteExecutorModule` collects these
 * into `handlers`. `"*"` runs any name with no handler of its own.
 *
 * The job and the context are the executor's own, reduced from a worker's: `@CurrentJob()`
 * gives a `RemoteJob`, with `log` and `updateProgress` and nothing that needs a driver, so
 * `isBunJob()` is false for it. The other parameter decorators read as they do on a worker.
 *
 * @param name The job name.
 * @param options See {@link RemoteHandlerOptions}.
 */
export function RemoteHandler(
  name: string,
  options?: RemoteHandlerOptions,
): MethodDecorator {
  const recorded: RemoteHandlerMetadata = { name, options };
  return SetMetadata(REMOTE_HANDLER_METADATA, recorded);
}

/**
 * What {@link BunRemoteExecutorModule.forRoot} accepts: `createRemoteExecutor()`'s options,
 * with `handlers` coming from `@RemoteHandler`, and where to mount.
 */
export interface BunRemoteExecutorModuleOptions extends Omit<
  RemoteExecutorOptions,
  "handlers"
> {
  /**
   * Where to mount it on the adapter, as a prefix: the protocol at `path`, and `path/healthz`
   * and `path/readyz`. Below Nest's router, so guards and the global prefix do not apply to
   * the route: the signature is its authentication, and `@UseGuards` applies to each handler.
   */
  path: string;
}

/** What {@link BunRemoteExecutorModule.forRootAsync} accepts. */
export interface BunRemoteExecutorModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  /** Providers injected into {@link useFactory}. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  /** Builds the options, with whatever {@link inject} resolved. */
  useFactory: (
    ...args: any[]
  ) => BunRemoteExecutorModuleOptions | Promise<BunRemoteExecutorModuleOptions>;
}

/** The provider of the module's options. Never leaves the module. */
const EXECUTOR_OPTIONS = Symbol("BUN_REMOTE_EXECUTOR_OPTIONS");

/** The adapter methods the mount uses, read structurally. */
interface MountAdapter {
  use: (
    path: string,
    handler: (
      req: BunRequest,
      res: BunResponse,
      next: () => void,
    ) => Promise<unknown>,
  ) => unknown;
}

/**
 * The request the executor verifies, with the exact bytes received. The adapter has usually
 * read the body by the time a route runs, since it reads it before the pipeline unless told
 * otherwise, and bun-common keeps those bytes. Bun gives a copy of a read `Request` an empty
 * body (oven-sh/bun#44307), so a request is rebuilt from them rather than copied.
 */
function unreadRequest(req: BunRequest): Request {
  const request = req.request;
  if (!request.bodyUsed) {
    return request;
  }
  const bytes = req.buffer as Uint8Array | undefined;
  if (bytes === undefined) {
    throw new ConfigError(
      "BunRemoteExecutorModule: the adapter read this request's body and kept no bytes (retainBuffer: false), and a signature covers the exact bytes. Leave retainBuffer on, or set parseBody: false on the adapter",
    );
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  });
}

/** Mounts the executor at `onModuleInit`, and builds its handlers at bootstrap. */
export class BunRemoteExecutorHost
  implements OnModuleInit, OnApplicationBootstrap
{
  /** Where the host reports what it cannot report by failing. */
  readonly #logger = new Logger("BunRemoteExecutorModule");
  /** The executor, once bootstrap has built its handlers. */
  #executor: RemoteExecutor | undefined;

  constructor(
    /** The module's options. */
    private readonly options: BunRemoteExecutorModuleOptions,
    /** Where the adapter is. */
    private readonly adapterHost: HttpAdapterHost,
    /** Finds the handlers. */
    private readonly discovery: DiscoveryService,
    /** Builds each handler's pipeline. */
    private readonly ecc: ExternalContextCreator,
    /** Resolves a request-scoped handler per job. */
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Mounts the route ahead of the host's catch-alls, as `BunJobsApiModule` does. */
  onModuleInit(): void {
    const adapter = this.adapterHost?.httpAdapter as unknown as
      MountAdapter | undefined;
    if (typeof adapter?.use !== "function") {
      throw new ConfigError(
        "BunRemoteExecutorModule needs an HTTP adapter to mount on. Create the application with NestFactory.create(AppModule, new BunHttpAdapter())",
      );
    }
    adapter.use(this.options.path, async (req, res) => {
      if (this.#executor === undefined) {
        await res.status(503).end();
        return;
      }
      let request: Request;
      try {
        request = unreadRequest(req);
      } catch (error) {
        this.#logger.error((error as Error).message);
        await res.status(500).end();
        return;
      }
      await res.send(await this.#executor(request));
    });
  }

  /** Builds the handlers: the global enhancers exist by now. */
  onApplicationBootstrap(): void {
    const problems: string[] = [];
    const handlers: Record<string, RemoteJobHandler> = {};
    const labels = new Map<string, string>();
    const seen = new Set<object>();
    const scanner = new MetadataScanner();
    for (const wrapper of this.discovery.getProviders() as unknown as Wrapper[]) {
      const target = classOf(wrapper);
      if (typeof target !== "function" || target.prototype === undefined) {
        continue;
      }
      for (const method of scanner.getAllMethodNames(
        target.prototype as object,
      )) {
        const handler = (target.prototype as Record<string, object>)[method];
        const metadata =
          typeof handler === "function"
            ? (Reflect.getMetadata(REMOTE_HANDLER_METADATA, handler) as
                RemoteHandlerMetadata | undefined)
            : undefined;
        if (metadata === undefined) {
          continue;
        }
        const perJob = wrapper.isTransient || !wrapper.isDependencyTreeStatic();
        if (!perJob) {
          if (seen.has(wrapper.instance as object)) {
            continue;
          }
        }
        const label = `${target.name}.${method}`;
        const existing = labels.get(metadata.name);
        if (existing !== undefined) {
          problems.push(
            `two @RemoteHandler methods for job "${metadata.name}", ${existing} and ${label}`,
          );
          continue;
        }
        labels.set(metadata.name, label);
        const enhancers = metadata.options?.enhancers ?? true;
        checkHandlerMethod(
          wrapper,
          target as { prototype: object },
          method,
          label,
          enhancers,
          problems,
        );
        const invoke = handlerInvoker(
          { ecc: this.ecc, moduleRef: this.moduleRef },
          wrapper,
          method,
          perJob,
          {
            label,
            handlerName: metadata.name,
            enhancers,
            onDenied: metadata.options?.onDenied,
            onInvalid: metadata.options?.onInvalid,
          },
        );
        // A remote context carries no logger, which the pipeline's decorators and
        // interceptor read: this one is Nest's, so it reaches `app.useLogger()`.
        const logger = resolveLogger(new Logger("BunRemoteExecutor"));
        handlers[metadata.name] = (job, ctx: RemoteContext) =>
          invoke(
            job as never,
            Object.assign(Object.create(ctx) as RemoteContext, {
              logger,
            }) as never,
          );
      }
      if (typeof wrapper.instance === "object" && wrapper.instance !== null) {
        seen.add(wrapper.instance);
      }
    }
    if (labels.size === 0) {
      this.#logger.warn(
        "BunRemoteExecutorModule is imported, and no @RemoteHandler exists, so the executor runs nothing but its canary",
      );
    }
    assertNoProblems(problems);
    const { path: _path, ...options } = this.options;
    this.#executor = createRemoteExecutor({ ...options, handlers });
  }
}

/** The module around its options provider. */
function moduleOf(
  optionsProvider: DynamicModule["providers"],
  imports: DynamicModule["imports"],
): DynamicModule {
  return {
    module: BunRemoteExecutorModule,
    imports: [DiscoveryModule, ...(imports ?? [])],
    providers: [
      ...(optionsProvider ?? []),
      {
        provide: BunRemoteExecutorHost,
        useFactory: (
          options: BunRemoteExecutorModuleOptions,
          adapterHost: HttpAdapterHost,
          discovery: DiscoveryService,
          ecc: ExternalContextCreator,
          moduleRef: ModuleRef,
        ) =>
          new BunRemoteExecutorHost(
            options,
            adapterHost,
            discovery,
            ecc,
            moduleRef,
          ),
        inject: [
          EXECUTOR_OPTIONS,
          HttpAdapterHost,
          DiscoveryService,
          ExternalContextCreator,
          ModuleRef,
        ],
      },
    ],
  };
}

/**
 * A remote executor on the Nest application: `createRemoteExecutor()`, with its handlers
 * collected from `@RemoteHandler` methods on any provider and mounted on the adapter. The
 * signature covers the exact bytes sent, and the module hands the executor those bytes on
 * any adapter whose `retainBuffer` is on (the default).
 *
 * ```ts
 * BunRemoteExecutorModule.forRootAsync({
 *   inject: [ConfigService],
 *   useFactory: (config: ConfigService) => ({
 *     path: "/jobs",
 *     secret: config.getOrThrow("EXECUTOR_SECRET"),
 *   }),
 * });
 * ```
 */
export class BunRemoteExecutorModule {
  /**
   * The module with its options given now.
   *
   * @param options See {@link BunRemoteExecutorModuleOptions}.
   */
  static forRoot(options: BunRemoteExecutorModuleOptions): DynamicModule {
    return moduleOf(
      [{ provide: EXECUTOR_OPTIONS, useFactory: () => options }],
      [],
    );
  }

  /**
   * The module with its options built while the application boots, for a secret from
   * configuration above all.
   *
   * @param options Where the options come from.
   */
  static forRootAsync(
    options: BunRemoteExecutorModuleAsyncOptions,
  ): DynamicModule {
    return moduleOf(
      [
        {
          provide: EXECUTOR_OPTIONS,
          useFactory: options.useFactory,
          inject: [...(options.inject ?? [])],
        },
      ],
      options.imports,
    );
  }
}

Module({})(BunRemoteExecutorModule);
