/**
 * `SecurityModule`: bun-security on a Nest application (plan §3.5).
 */
import type {
  DynamicModule,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Provider,
} from "@nestjs/common";
import type {
  SecurityModuleAsyncOptions,
  SecurityModuleOptions,
  SecurityModuleSettings,
  SecuritySource,
} from "./security.interface";
import { ConfigError } from "@kingsleyweb/bun-common";
import { Inject, Module } from "@nestjs/common";
import { APP_GUARD, HttpAdapterHost, ModuleRef, Reflector } from "@nestjs/core";
import { BUN_SECURITY, BUN_SECURITY_OPTIONS } from "./security.constants";
import { SecurityGuard } from "./security.guard";
import { SecurityService } from "./security.service";

/** Nest's `GUARDS_METADATA` (`@nestjs/common/constants`), by value: where `@UseGuards()` writes. */
const NEST_GUARDS_METADATA = "__guards__";

/** The parts of Nest's (internal) `NestContainer` the self-test reads. */
interface ContainerView {
  readonly applicationConfig?: {
    getGlobalGuards?: () => readonly unknown[];
    getGlobalRequestGuards?: () => readonly { metatype?: unknown }[];
  };
  getModules?: () => Map<
    string,
    { controllers: Map<unknown, { metatype?: unknown }> }
  >;
}

/** Whether `value` is a `SecurityGuard` (or a subclass), as an instance or a class. */
function isSecurityGuard(value: unknown): boolean {
  if (value instanceof SecurityGuard) return true;
  return (
    typeof value === "function" &&
    (value === SecurityGuard ||
      (value as { prototype?: unknown }).prototype instanceof SecurityGuard)
  );
}

/** The module's providers around its options provider. */
function moduleOf(
  options: Provider,
  imports: DynamicModule["imports"],
  globalGuard: boolean,
  isGlobal: boolean,
): DynamicModule {
  return {
    module: SecurityModule,
    global: isGlobal,
    imports: imports ?? [],
    providers: [
      options,
      {
        // Built while Nest builds the application: its head middleware then
        // runs ahead of Nest's body parsers, middleware and routes.
        provide: SecurityService,
        useFactory: (
          source: SecuritySource & SecurityModuleSettings,
          host: HttpAdapterHost,
        ) => new SecurityService(source, host.httpAdapter),
        inject: [BUN_SECURITY_OPTIONS, HttpAdapterHost],
      },
      {
        provide: BUN_SECURITY,
        useFactory: (service: SecurityService) => service.security,
        inject: [SecurityService],
      },
      {
        provide: SecurityGuard,
        useFactory: (service: SecurityService, reflector: Reflector) =>
          new SecurityGuard(service, reflector),
        inject: [SecurityService, Reflector],
      },
      ...(globalGuard
        ? [{ provide: APP_GUARD, useExisting: SecurityGuard }]
        : []),
    ],
    exports: [
      BUN_SECURITY,
      BUN_SECURITY_OPTIONS,
      SecurityService,
      SecurityGuard,
    ],
  };
}

/**
 * bun-security on a Nest application served by bun-nest's `BunHttpAdapter`
 * (plan §3.5): the engine provided as `BUN_SECURITY` (`@InjectSecurity()`),
 * the early stage on the adapter's before-read hook, `SecurityGuard` as a
 * global guard for the route stage, and the response stage (security
 * headers, stack-trace scrubbing, outcomes). Global by default.
 *
 * When the application bootstraps, the boot self-test sends one marked
 * request through the adapter and checks that `SecurityGuard` is installed
 * (as a global guard, or with `@UseGuards()` on a controller or route), and
 * throws a `ConfigError` when either fails, so an application whose defence
 * is not in the pipeline fails at start-up (ConcaveHR's pay-api ran
 * unthrottled because a pipe was registered as its `APP_GUARD`).
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [SecurityModule.forRoot({ policy, identify: (req) => ({ user: req.user?.id }) })],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class SecurityModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    /** The engine on the adapter. */
    @Inject(SecurityService) private readonly service: SecurityService,
    /** The way to the application's container, for the guard check. */
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    /** The options, for `selfTest`. */
    @Inject(BUN_SECURITY_OPTIONS)
    private readonly options: SecurityModuleSettings,
  ) {}

  /**
   * The module with its options given now: `createSecurity`'s options (the
   * module creates the engine and closes it on shutdown) or `{ security }`,
   * an engine made elsewhere, with the settings beside them.
   */
  static forRoot(options: SecurityModuleOptions): DynamicModule {
    return moduleOf(
      { provide: BUN_SECURITY_OPTIONS, useValue: options },
      [],
      options.globalGuard !== false,
      options.isGlobal !== false,
    );
  }

  /** The module with its options built by a factory, with injection, while the application boots. */
  static forRootAsync(options: SecurityModuleAsyncOptions): DynamicModule {
    return moduleOf(
      {
        provide: BUN_SECURITY_OPTIONS,
        useFactory: options.useFactory as (
          ...args: unknown[]
        ) => SecuritySource & SecurityModuleSettings,
        inject: [...(options.inject ?? [])],
      },
      options.imports,
      options.globalGuard !== false,
      options.isGlobal !== false,
    );
  }

  /** The boot self-test: the marked request, then the guard check. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.options.selfTest === false) return;
    await this.service.selfTest();
    if (!this.#guardInstalled()) {
      throw new ConfigError(
        "SecurityModule: the boot self-test failed: no SecurityGuard is installed, so the route stage never runs. Keep forRoot()'s globalGuard (the default), provide { provide: APP_GUARD, useExisting: SecurityGuard }, or apply @UseGuards(SecurityGuard). selfTest: false turns this check off.",
      );
    }
  }

  /** Takes the engine off the adapter, and closes it if the module made it. */
  onApplicationShutdown(): void {
    this.service.close();
  }

  /** Whether a `SecurityGuard` is a global guard or on some controller or route. */
  #guardInstalled(): boolean {
    const container = Reflect.get(this.moduleRef, "container") as
      ContainerView | undefined;
    const config = container?.applicationConfig;
    if (
      config?.getGlobalGuards?.().some(isSecurityGuard) === true ||
      config
        ?.getGlobalRequestGuards?.()
        .some((wrapper) => isSecurityGuard(wrapper.metatype)) === true
    ) {
      return true;
    }
    for (const module of container?.getModules?.()?.values() ?? []) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype;
        if (typeof controller !== "function") continue;
        const guarded = (target: object) =>
          (
            (Reflect.getMetadata(NEST_GUARDS_METADATA, target) ??
              []) as unknown[]
          ).some(isSecurityGuard);
        if (guarded(controller)) return true;
        const prototype = (controller as { prototype: object }).prototype;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const method = (prototype as Record<string, unknown>)[name];
          if (typeof method === "function" && guarded(method)) return true;
        }
      }
    }
    // A Nest whose container cannot be read: the check cannot run.
    return container?.applicationConfig?.getGlobalGuards === undefined;
  }
}
