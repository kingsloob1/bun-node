import type { JobsApi, JobsApiConfig } from "@kingsleyweb/bun-jobs";
import type {
  BeforeApplicationShutdown,
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit,
  OptionalFactoryDependency,
} from "@nestjs/common";
import { createJobsApi } from "@kingsleyweb/bun-jobs";
import { Inject, Module } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { BunHttpAdapter } from "../BunHttpAdapter";
import { BUN_JOBS_API, BUN_JOBS_API_OPTIONS } from "./tokens";

/**
 * The bun-jobs management API as a NestJS module.
 *
 * It is deliberately **not** exported from `@kingsleyweb/bun-nest`'s barrel:
 * this package ships raw `.ts`, so a re-export would make every Nest app
 * compile `@kingsleyweb/bun-jobs` whether or not it has one. Import it from
 * `@kingsleyweb/bun-nest/jobs`, which is where the dependency starts.
 *
 * Each lifecycle hook runs where it must, and the shutdown one was measured
 * rather than assumed — `NestApplication.close()` is
 * `callDestroyHook() → callBeforeShutdownHook() → dispose() → callShutdownHook()`:
 *
 * - **`onModuleInit`** mounts the HTTP router. Nest registers controllers
 *   before init hooks and installs its not-found and error handling after
 *   them, so mounting here puts this prefix ahead of the host's catch-alls.
 * - **`onApplicationBootstrap`** attaches the socket. `app.useWebSocketAdapter()`
 *   runs before this and swaps the adapter's `BunWebSocket`; attaching earlier
 *   would register the upgrade route on an instance about to be replaced,
 *   leaving a route with no handler.
 * - **`beforeApplicationShutdown`** closes the API, because `dispose()` stops
 *   the HTTP server — and this adapter force-stops it — between the two
 *   shutdown hooks. Closing in `onApplicationShutdown` would tear the
 *   transport down first and clients would see a 1006 abnormal close instead
 *   of the protocol's 1001 "going away".
 * - **`onApplicationShutdown`** closes it again, harmlessly: `close()` is
 *   idempotent, and this covers a host that disposes without the earlier hook.
 */

/** What {@link BunJobsApiModule.forRoot} accepts. */
export interface BunJobsApiModuleOptions extends JobsApiConfig {
  /**
   * Attach the live-events socket to the Nest adapter's `BunWebSocket` at
   * bootstrap. Defaults to `true` whenever the API has a socket. A socket
   * given its own `websocket.port` serves itself and is never attached.
   */
  attachWebSocket?: boolean;
}

/** What {@link BunJobsApiModule.forRootAsync} accepts. */
export interface BunJobsApiModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  /** Providers injected into {@link useFactory}. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  /** Builds the options, with whatever {@link inject} resolved. */
  useFactory: (
    ...args: any[]
  ) => BunJobsApiModuleOptions | Promise<BunJobsApiModuleOptions>;
}

/** Injects the built {@link JobsApi}. */
export const InjectJobsApi = () => Inject(BUN_JOBS_API);

/** Whether a value looks like an HTTP adapter this module can mount on. */
function looksLikeBunAdapter(value: unknown): value is BunHttpAdapter {
  const candidate = value as Partial<BunHttpAdapter> | undefined;
  return (
    typeof candidate?.use === "function" &&
    typeof candidate.getInstance === "function" &&
    // The mark of *this* package's adapter: the `BunWebSocket` the socket
    // attaches to. An Express or Fastify adapter has nothing of the sort.
    candidate.webSocketAdapter !== undefined
  );
}

/**
 * The application's adapter, which must be this package's.
 *
 * `instanceof` is the first test and a capability probe the second: a package
 * shipping raw `.ts` can be loaded twice under some resolutions, and two
 * copies of one class fail `instanceof` while being the same adapter.
 */
function requireBunAdapter(host: HttpAdapterHost | undefined): BunHttpAdapter {
  const adapter: unknown = host?.httpAdapter;
  if (adapter instanceof BunHttpAdapter || looksLikeBunAdapter(adapter)) {
    return adapter as BunHttpAdapter;
  }
  const got =
    adapter === undefined || adapter === null
      ? "no HTTP adapter (the application was not created with one)"
      : ((adapter as object).constructor?.name ?? typeof adapter);
  throw new TypeError(
    `BunJobsApiModule requires @kingsleyweb/bun-nest's BunHttpAdapter: expected BunHttpAdapter, got ${got}. Create the application with \`NestFactory.create(AppModule, new BunHttpAdapter())\`.`,
  );
}

/** Builds the API from the options provided under {@link BUN_JOBS_API_OPTIONS}. */
const apiProvider = {
  provide: BUN_JOBS_API,
  useFactory: (options: BunJobsApiModuleOptions): JobsApi =>
    createJobsApi(options),
  inject: [BUN_JOBS_API_OPTIONS],
};

@Module({})
export class BunJobsApiModule
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  constructor(
    /** The built API. */
    @Inject(BUN_JOBS_API) private readonly api: JobsApi,
    /** The options it was built from. */
    @Inject(BUN_JOBS_API_OPTIONS)
    private readonly options: BunJobsApiModuleOptions,
    /**
     * Where the application's HTTP adapter is found. Injected by token
     * rather than by parameter type, so this does not depend on
     * `emitDecoratorMetadata` being on in the consumer's build.
     */
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  /** Registers the API with options known at module definition time. */
  static forRoot(options: BunJobsApiModuleOptions): DynamicModule {
    return {
      module: BunJobsApiModule,
      providers: [
        { provide: BUN_JOBS_API_OPTIONS, useValue: options },
        apiProvider,
      ],
      exports: [BUN_JOBS_API, BUN_JOBS_API_OPTIONS],
    };
  }

  /** Registers the API with options built by a factory, with injection. */
  static forRootAsync(options: BunJobsApiModuleAsyncOptions): DynamicModule {
    return {
      module: BunJobsApiModule,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: BUN_JOBS_API_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        apiProvider,
      ],
      exports: [BUN_JOBS_API, BUN_JOBS_API_OPTIONS],
    };
  }

  /** Mounts the HTTP router under `basePath`. */
  onModuleInit(): void {
    const adapter = requireBunAdapter(this.adapterHost);
    adapter.use(this.api.basePath, this.api.router);
  }

  /** Attaches the socket, once the WebSocket adapter can no longer be swapped. */
  onApplicationBootstrap(): void {
    const socket = this.api.websocket;
    if (!socket || this.options.attachWebSocket === false) {
      return;
    }
    if (socket.port !== undefined) {
      // A dedicated server of its own; there is nothing to attach.
      return;
    }
    socket.attach(requireBunAdapter(this.adapterHost).getInstance());
  }

  /** Closes what the API owns, while the transport is still up. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.api.close();
  }

  /** Closes it again, for a host that disposed without the earlier hook. */
  async onApplicationShutdown(): Promise<void> {
    await this.api.close();
  }
}
