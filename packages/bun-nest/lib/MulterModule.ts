import type { UploadOptions } from "@kingsleyweb/bun-common/lib/multipart";
import type {
  DynamicModule,
  ModuleMetadata,
  Provider,
  Type,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";

/**
 * The token the module-level upload options are provided under. The same
 * string as `@nestjs/platform-express`'s, so an application that registers
 * platform-express's own `MulterModule` feeds these interceptors too.
 */
export const MULTER_MODULE_OPTIONS = "MULTER_MODULE_OPTIONS";

/**
 * The token of a random id each registration provides, as platform-express
 * does: it makes two `register()` calls distinct modules, whose options would
 * otherwise hash alike (Nest compares a factory by its source).
 */
export const MULTER_MODULE_ID = "MULTER_MODULE_ID";

/**
 * Upload options as a module registers them, or as an interceptor takes them
 * beside the module's: every key optional, `storageType` included. They are
 * merged into one {@link UploadOptions} per interceptor (`mergeUploadOptions`
 * in `interceptors.ts`).
 */
export type MulterModuleOptions = Partial<UploadOptions>;

/** A class that builds the module-level upload options, for `registerAsync`'s `useClass`/`useExisting`. */
export interface MulterOptionsFactory {
  /** Answers the module-level upload options, or a promise of them. */
  createMulterOptions: () => MulterModuleOptions | Promise<MulterModuleOptions>;
}

/** How {@link MulterModule.registerAsync} obtains the module-level upload options. */
export interface MulterModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  /** An existing provider implementing {@link MulterOptionsFactory}, reused as it is. */
  useExisting?: Type<MulterOptionsFactory>;
  /** A class implementing {@link MulterOptionsFactory}, instantiated by the module. */
  useClass?: Type<MulterOptionsFactory>;
  /** A factory answering the options; its arguments are the `inject` tokens' values. */
  useFactory?: (
    // Nest passes the injected providers positionally, as their own types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Nest's factory contract
    ...args: any[]
  ) => MulterModuleOptions | Promise<MulterModuleOptions>;
  /** The tokens whose values `useFactory` receives. Defaults to none. */
  inject?: NonNullable<Extract<Provider, { useFactory: unknown }>["inject"]>;
}

/**
 * Module-level upload options for bun-nest's file interceptors: what
 * `@nestjs/platform-express`'s `MulterModule` is to its interceptors. Each
 * interceptor merges these with its own options, its own winning key by key
 * and `limits` merged key by key (platform-express's `mergeMulterOptions`).
 *
 * ```ts
 * @Module({
 *   imports: [MulterModule.register({ limits: { files: 1 } })],
 *   controllers: [UploadController],
 * })
 * ```
 */
export class MulterModule {
  /** Provides `options` to the interceptors of the importing module. */
  static register(options: MulterModuleOptions = {}): DynamicModule {
    return {
      module: MulterModule,
      providers: [
        { provide: MULTER_MODULE_OPTIONS, useFactory: () => options },
        { provide: MULTER_MODULE_ID, useValue: randomUUID() },
      ],
      exports: [MULTER_MODULE_OPTIONS],
    };
  }

  /** Provides options obtained from a factory, a class or an existing provider. */
  static registerAsync(options: MulterModuleAsyncOptions): DynamicModule {
    return {
      module: MulterModule,
      imports: options.imports,
      providers: [
        ...MulterModule.createAsyncProviders(options),
        { provide: MULTER_MODULE_ID, useValue: randomUUID() },
      ],
      exports: [MULTER_MODULE_OPTIONS],
    };
  }

  /** The options provider, plus the `useClass` class's own provider. */
  private static createAsyncProviders(
    options: MulterModuleAsyncOptions,
  ): Provider[] {
    const optionsProvider = MulterModule.createAsyncOptionsProvider(options);
    if (options.useExisting || options.useFactory || !options.useClass) {
      return [optionsProvider];
    }
    return [
      optionsProvider,
      { provide: options.useClass, useClass: options.useClass },
    ];
  }

  /** The provider of {@link MULTER_MODULE_OPTIONS} for `registerAsync`. */
  private static createAsyncOptionsProvider(
    options: MulterModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: MULTER_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      };
    }
    return {
      provide: MULTER_MODULE_OPTIONS,
      useFactory: async (factory: MulterOptionsFactory) =>
        factory.createMulterOptions(),
      inject: [options.useExisting ?? options.useClass].filter(
        (token): token is Type<MulterOptionsFactory> => token !== undefined,
      ),
    };
  }
}

// Applied by call rather than as `@Module({})`: Bun reads the decorator
// options from the working directory's tsconfig (oven-sh/bun#28605), and
// the call behaves the same under either decorator semantics.
Module({})(MulterModule);
