import type {
  DynamicModule,
  OnApplicationBootstrap,
  Provider,
} from "@nestjs/common";
import type {
  BunThrottlerModuleAsyncOptions,
  BunThrottlerModuleConfig,
  BunThrottlerModuleOptions,
  BunThrottlerOptionsFactory,
} from "./options";
import { ConfigError } from "@kingsleyweb/bun-common";
import { Logger, Module } from "@nestjs/common";
import {
  APP_GUARD,
  HttpAdapterHost,
  MetadataScanner,
  ModuleRef,
} from "@nestjs/core";
import { BunThrottlerGuard, throttlePlanFor } from "./guard";
import { BunThrottlerService } from "./options";

/**
 * Provides the options `BunThrottlerModule.forRoot()` was given (or
 * `forRootAsync()` built), before they are checked. A registered symbol, so
 * two copies of the package agree on it.
 */
export const BUN_THROTTLER_OPTIONS: unique symbol = Symbol.for(
  "@kingsleyweb/bun-nest/throttler:options",
);

/** Nest's `METHOD_METADATA` (`@nestjs/common/constants`), by value: what marks a method as a route. */
const NEST_METHOD_METADATA = "method";
/** Nest's `GUARDS_METADATA` (`@nestjs/common/constants`), by value: where `@UseGuards()` writes. */
const NEST_GUARDS_METADATA = "__guards__";

/** Whether `value` is a `BunThrottlerGuard` (or a subclass), as an instance or a class. */
function isThrottlerGuard(value: unknown): boolean {
  if (value instanceof BunThrottlerGuard) return true;
  return (
    typeof value === "function" &&
    (value === BunThrottlerGuard ||
      (value as { prototype?: unknown }).prototype instanceof BunThrottlerGuard)
  );
}

/** The parts of Nest's (internal) `NestContainer` the boot check reads. */
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

/**
 * The module's boot check, run once the application has booted
 * (`onApplicationBootstrap`, so after `app.useGlobalGuards()`):
 *
 * 1. every route's throttlers are worked out, so a `@Throttle()` naming a
 *    throttler the module does not define without both a limit and a window
 *    fails the boot rather than its first request;
 * 2. a `BunThrottlerGuard` must be installed somewhere — a global guard
 *    (`APP_GUARD`, `app.useGlobalGuards()`) or `@UseGuards()` on a
 *    controller or route — or the module's `guardCheck` logs an error
 *    (`"error"`, the default) or fails the boot (`"throw"`). Importing the
 *    module alone throttles nothing; a production application once ran
 *    unthrottled because a pipe had been registered as its `APP_GUARD`.
 *
 * The global guards are read from Nest's application config through the
 * module's `ModuleRef` (an internal, the same on Nest 11 and 12); where it
 * cannot be read the second check is skipped with a debug line. An
 * application without an HTTP adapter (an application context, a
 * microservice) is not checked.
 */
export class BunThrottlerBootCheck implements OnApplicationBootstrap {
  /** Where the check reports. */
  readonly #logger = new Logger("BunThrottlerModule");

  constructor(
    /** The module's throttlers and options. */
    private readonly service: BunThrottlerService,
    /** The module's `ModuleRef`, the way to the application's container. */
    private readonly moduleRef: ModuleRef,
    /** Whether the application serves HTTP. */
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  /** Runs both checks; see the class. */
  onApplicationBootstrap(): void {
    const container = Reflect.get(this.moduleRef, "container") as
      ContainerView | undefined;
    const modules = container?.getModules?.();
    const scanner = new MetadataScanner();
    let onRoutes = false;
    const problems: string[] = [];
    for (const module of modules?.values() ?? []) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype;
        if (typeof controller !== "function") continue;
        const prototype = (controller as { prototype: object }).prototype;
        const guarded = (target: object) =>
          (
            (Reflect.getMetadata(NEST_GUARDS_METADATA, target) ??
              []) as unknown[]
          ).some(isThrottlerGuard);
        if (guarded(controller)) onRoutes = true;
        for (const methodName of scanner.getAllMethodNames(prototype)) {
          const handler = (prototype as Record<string, unknown>)[methodName];
          if (
            typeof handler !== "function" ||
            Reflect.getMetadata(NEST_METHOD_METADATA, handler) === undefined
          ) {
            continue;
          }
          if (guarded(handler)) onRoutes = true;
          try {
            throttlePlanFor(this.service, controller, handler);
          } catch (error) {
            problems.push((error as Error).message);
          }
        }
      }
    }
    if (problems.length > 0) {
      throw new ConfigError(
        `BunThrottlerModule: ${problems.length} route${problems.length === 1 ? "" : "s"} misconfigured:\n- ${problems.join("\n- ")}`,
      );
    }
    const mode = this.service.options.guardCheck;
    if (mode === false || this.adapterHost.httpAdapter === undefined) return;
    if (onRoutes) return;
    const config = container?.applicationConfig;
    if (
      config?.getGlobalGuards === undefined ||
      config.getGlobalRequestGuards === undefined
    ) {
      this.#logger.debug(
        "cannot read this Nest's global guards; skipping the check that BunThrottlerGuard is installed",
      );
      return;
    }
    const global =
      config.getGlobalGuards().some(isThrottlerGuard) ||
      config
        .getGlobalRequestGuards()
        .some((wrapper) => isThrottlerGuard(wrapper.metatype));
    if (global) return;
    const message =
      "BunThrottlerModule is imported, but no BunThrottlerGuard is installed, so nothing is throttled. Install it as a global guard ({ provide: APP_GUARD, useClass: BunThrottlerGuard }, or forRoot({ globalGuard: true })), or with @UseGuards(BunThrottlerGuard). guardCheck: false turns this check off.";
    if (mode === "throw") throw new ConfigError(message);
    this.#logger.error(message);
  }
}

/** The module's providers around its options provider(s). */
function moduleOf(
  optionProviders: Provider[],
  imports: DynamicModule["imports"],
  globalGuard: boolean,
): DynamicModule {
  return {
    module: BunThrottlerModule,
    global: true,
    imports: imports ?? [],
    providers: [
      ...optionProviders,
      {
        provide: BunThrottlerService,
        useFactory: (options: BunThrottlerModuleConfig) =>
          new BunThrottlerService(options),
        inject: [BUN_THROTTLER_OPTIONS],
      },
      {
        provide: BunThrottlerBootCheck,
        useFactory: (
          service: BunThrottlerService,
          moduleRef: ModuleRef,
          adapterHost: HttpAdapterHost,
        ) => new BunThrottlerBootCheck(service, moduleRef, adapterHost),
        inject: [BunThrottlerService, ModuleRef, HttpAdapterHost],
      },
      ...(globalGuard
        ? [
            {
              provide: APP_GUARD,
              useFactory: (service: BunThrottlerService) =>
                new BunThrottlerGuard(service),
              inject: [BunThrottlerService],
            },
          ]
        : []),
    ],
    exports: [BUN_THROTTLER_OPTIONS, BunThrottlerService],
  };
}

/**
 * Request throttling for a Nest application on bun-nest:
 * `@nestjs/throttler` 6's `ThrottlerModule` (https://github.com/nestjs/throttler)
 * over bun-common's `throttle()` and its stores. Global, like
 * `ThrottlerModule`; it provides {@link BunThrottlerService} (the throttlers
 * at run time) and {@link BUN_THROTTLER_OPTIONS}. Install
 * {@link BunThrottlerGuard} to throttle anything (its boot check says so
 * when it is not).
 *
 * ```ts
 * @Module({
 *   imports: [BunThrottlerModule.forRoot({ throttlers: [{ limit: 600, ttl: "1m" }] })],
 *   providers: [{ provide: APP_GUARD, useClass: BunThrottlerGuard }],
 * })
 * export class AppModule {}
 * ```
 *
 * The differences from `@nestjs/throttler` are listed in the package
 * README's "Throttling" section: `ttl` takes a duration (`"1m"`,
 * `seconds(60)`), never a bare number; the sliding window is the default
 * algorithm; no `blockDuration`; headers are off by default
 * (`headers: "legacy"` sends `ThrottlerGuard`'s); a `@Throttle()` name the
 * module lacks declares a throttler for its routes.
 */
export class BunThrottlerModule {
  /**
   * The module with its options given now. Checked at once: a bad option
   * throws a `ConfigError` while the application boots.
   *
   * @param options The throttlers and options (or a bare array of throttlers).
   */
  static forRoot(options: BunThrottlerModuleConfig = []): DynamicModule {
    const globalGuard =
      !Array.isArray(options) &&
      (options as BunThrottlerModuleOptions).globalGuard === true;
    return moduleOf(
      [{ provide: BUN_THROTTLER_OPTIONS, useValue: options }],
      [],
      globalGuard,
    );
  }

  /**
   * The module with its options built while the application boots: by a
   * factory with injected providers (`useFactory` + `inject`), or by a
   * {@link BunThrottlerOptionsFactory} class (`useClass`, or an existing
   * provider with `useExisting`), as `ThrottlerModule.forRootAsync()`.
   *
   * @param options Where the options come from.
   */
  static forRootAsync(options: BunThrottlerModuleAsyncOptions): DynamicModule {
    const providers: Provider[] = [];
    if (options.useFactory !== undefined) {
      providers.push({
        provide: BUN_THROTTLER_OPTIONS,
        useFactory: options.useFactory as (
          ...args: unknown[]
        ) => BunThrottlerModuleConfig | Promise<BunThrottlerModuleConfig>,
        inject: [...(options.inject ?? [])] as never[],
      });
    } else {
      const factory = options.useExisting ?? options.useClass;
      if (factory === undefined) {
        throw new ConfigError(
          "BunThrottlerModule.forRootAsync(): give useFactory, useClass or useExisting",
        );
      }
      if (options.useExisting === undefined) {
        providers.push({ provide: factory, useClass: factory });
      }
      providers.push({
        provide: BUN_THROTTLER_OPTIONS,
        useFactory: async (made: BunThrottlerOptionsFactory) =>
          made.createThrottlerOptions(),
        inject: [factory],
      });
    }
    return moduleOf(providers, options.imports, options.globalGuard === true);
  }
}

Module({})(BunThrottlerModule);
