/**
 * `DevTypesModule` (typed-client plan `nest-typed-routes.md` §6, N-D6,
 * PR-N2): the dev type sync in a Nest application — bun-common's
 * `devTypes()` mounted on the adapter, with the app's controllers (through
 * `generateOpenApi(adapter.instance)`) and its gateways (through
 * `gatewayAsyncApi`) as the documents it serves. One implementation of the
 * protocol and its fail-closed rules (the token, loopback peers, 404 for
 * anything refused, the token file), the router app's.
 *
 * ```ts
 * @Module({
 *   imports: [DevTypesModule.forRoot({ enabled: process.env.NODE_ENV !== "production" })],
 * })
 * export class AppModule {}
 * ```
 *
 * Then `bun-client watch --out src/api.gen.ts` beside the running app keeps
 * the client's types in step with the controllers. With `documents`, one
 * server keeps several filtered clients live, one per frontend (issue #768):
 * `bun-client watch --document customer --out customer.gen.ts --document
 * backoffice --out backoffice.gen.ts`.
 */
import type {
  DynamicModule,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import type {
  AsyncApiDocument,
  DevTypesRouter,
  OpenApi31Document,
  OpenApiOptions,
} from "@kingsleyweb/bun-common/lib/docs";
import type { GatewayAsyncApiOptions } from "./gateway-docs";
import process from "node:process";
import { Inject, Injectable, Module } from "@nestjs/common";
import { HttpAdapterHost, ModulesContainer } from "@nestjs/core";
import { ConfigError } from "@kingsleyweb/bun-common";
import { devTypes, generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { BunHttpAdapter } from "./BunHttpAdapter";
import { gatewayAsyncApiOf } from "./gateway-docs";

/** One named document of {@link DevTypesModuleOptions.documents}. */
export interface DevTypesModuleDocument {
  /**
   * Its OpenAPI document: `generateOpenApi(adapter.instance, options)`'s
   * options (most often `{ filter }`, the routes one frontend calls), or a
   * function returning the document. Default: the module's
   * {@link DevTypesModuleOptions.openapi}.
   */
  openapi?:
    | (Omit<OpenApiOptions, "title" | "version"> &
        Partial<Pick<OpenApiOptions, "title" | "version">>)
    | (() => OpenApi31Document | Promise<OpenApi31Document>);
  /**
   * Its AsyncAPI document: `gatewayAsyncApi(app, options)`'s options, or a
   * function returning the document. Default: the module's
   * {@link DevTypesModuleOptions.asyncapi}.
   */
  asyncapi?:
    | GatewayAsyncApiOptions
    | (() => AsyncApiDocument | Promise<AsyncApiDocument>);
}

/** What {@link DevTypesModule.forRoot} accepts. */
export interface DevTypesModuleOptions {
  /**
   * Must be exactly `true`, or the module registers nothing (there is no
   * implicit on). With `true` under `NODE_ENV=production`, `forRoot` throws a
   * `ConfigError`: write `enabled: process.env.NODE_ENV !== "production"`.
   */
  enabled: boolean;
  /**
   * Where the endpoint is served: the documents at `path`, each alone at
   * `path/openapi.json` and `path/asyncapi.json`, the change channel at
   * `path/ws`. An absolute path with no parameters and no trailing slash,
   * outside any global prefix (it is mounted on the adapter, not in a
   * controller). Default: `"/__bun/types"`.
   */
  path?: string;
  /**
   * The bearer token every request must carry (`Authorization: Bearer
   * <token>`, or a `token.<token>` subprotocol on the channel). At least 16
   * characters of `A–Z a–z 0–9 . _ ~ -`. Default: a random one per process,
   * written to the token file for `bun-client watch`.
   */
  token?: string;
  /**
   * Accept peers that are not loopback. Default: `false`, so only this
   * machine is answered; the token is required either way.
   */
  allowRemote?: boolean;
  /**
   * The OpenAPI document: `generateOpenApi(adapter.instance, options)`'s
   * options (`title` and `version` optional), or a function returning the
   * document (sync or async). Default: `generateOpenApi(adapter.instance, {
   * title: "API", version: "dev" })` — every controller route, with its
   * `@Validate` schemas and `@Describe` prose, and every route registered on
   * the adapter itself.
   */
  openapi?:
    | (Omit<OpenApiOptions, "title" | "version"> &
        Partial<Pick<OpenApiOptions, "title" | "version">>)
    | (() => OpenApi31Document | Promise<OpenApi31Document>);
  /**
   * The AsyncAPI document: `gatewayAsyncApi(app, options)`'s options (title
   * and version optional), or a function returning the document. Default:
   * the app's gateways, `{ title: "API", version: "dev" }`. The adapter's own
   * bun-common channels (`defineChannel`) are not in it; pass a function
   * combining `generateAsyncApi(adapter.instance)` for those.
   */
  asyncapi?:
    | GatewayAsyncApiOptions
    | (() => AsyncApiDocument | Promise<AsyncApiDocument>);
  /**
   * Where the token file is written once the server listens, relative to
   * the working directory (`<port>` replaced by the port), or `false` for
   * none. Default: `"node_modules/.cache/bun-types/<port>.json"`, where
   * `bun-client watch` looks. Removed when the application closes.
   */
  tokenFile?: string | false;
  /**
   * Named documents served beside the unnamed one, each at `<path>/<name>`
   * with a hash of its own (bun-common's `devTypes()` `documents`): one typed
   * client per frontend, each from a filtered document, kept live by one
   * watcher (`bun-client watch --document <name> --out <file>`, repeated).
   * A name is letters, digits, `_` and `-`, starting with a letter or digit,
   * and not `ws`. Default: none.
   *
   * ```ts
   * DevTypesModule.forRoot({
   *   enabled: process.env.NODE_ENV !== "production",
   *   documents: {
   *     customer: { openapi: { filter: (route) => !route.path.startsWith("/api/admin") } },
   *     backoffice: { openapi: { filter: (route) => route.path.startsWith("/api/admin") } },
   *   },
   * })
   * ```
   */
  documents?: Record<string, DevTypesModuleDocument>;
}

/** The injection token of the enabled module's options. Internal. */
const DEV_TYPES_OPTIONS = Symbol("@kingsleyweb/bun-nest:devTypesOptions");

/**
 * The adapter, which must be this package's. `instanceof` first, then a
 * capability probe: a package shipping raw `.ts` can be loaded twice, and two
 * copies of one class fail `instanceof` while being the same adapter.
 */
function requireBunAdapter(host: HttpAdapterHost): BunHttpAdapter {
  const adapter: unknown = host.httpAdapter;
  const candidate = adapter as Partial<BunHttpAdapter> | undefined;
  if (
    adapter instanceof BunHttpAdapter ||
    (typeof candidate?.use === "function" &&
      typeof candidate.getInstance === "function" &&
      candidate.webSocketAdapter !== undefined)
  ) {
    return adapter as BunHttpAdapter;
  }
  const got =
    adapter === undefined || adapter === null
      ? "no HTTP adapter (the application was not created with one)"
      : (adapter.constructor?.name ?? typeof adapter);
  throw new TypeError(
    `DevTypesModule requires @kingsleyweb/bun-nest's BunHttpAdapter: expected BunHttpAdapter, got ${got}. Create the application with \`NestFactory.create(AppModule, new BunHttpAdapter())\`.`,
  );
}

/**
 * The enabled module's worker: mounts the sync at bootstrap and follows the
 * adapter's server. Internal.
 */
class DevTypesMount implements OnApplicationBootstrap, OnApplicationShutdown {
  /** The mounted sync, once bootstrapped. */
  #dev: DevTypesRouter | undefined;
  /** Stops following the adapter's `listening` and `close` events. */
  #unfollow: (() => void) | undefined;

  /**
   * @param options   The module's options (enabled).
   * @param host      Where the application's HTTP adapter is found.
   * @param container The application's modules, for the gateways' document.
   */
  constructor(
    private readonly options: DevTypesModuleOptions,
    private readonly host: HttpAdapterHost,
    private readonly container: ModulesContainer,
  ) {}

  /**
   * Mounts the sync, at bootstrap: as late as Nest allows, so every
   * controller route is registered and the adapter's `BunWebSocket` is the
   * final one (`app.useWebSocketAdapter()` swaps it before then), which the
   * change channel is a socket route of.
   */
  onApplicationBootstrap(): void {
    const adapter = requireBunAdapter(this.host);
    const app = adapter.getInstance();
    const { openapi, asyncapi, tokenFile, documents } = this.options;
    /** A source in Nest's terms, as `devTypes()` takes it: the controllers' routes and the gateways. */
    const openApiSource = (
      option: DevTypesModuleOptions["openapi"],
    ): (() => OpenApi31Document | Promise<OpenApi31Document>) =>
      typeof option === "function"
        ? option
        : () =>
            generateOpenApi(app, { title: "API", version: "dev", ...option })
              .document;
    const asyncApiSource = (
      option: DevTypesModuleOptions["asyncapi"],
    ): (() => AsyncApiDocument | Promise<AsyncApiDocument>) =>
      typeof option === "function"
        ? option
        : () =>
            gatewayAsyncApiOf(this.container, {
              title: "API",
              version: "dev",
              ...option,
            }).document;
    const dev = devTypes(app, {
      enabled: true,
      ...(this.options.path === undefined ? {} : { path: this.options.path }),
      ...(this.options.token === undefined
        ? {}
        : { token: this.options.token }),
      ...(this.options.allowRemote === undefined
        ? {}
        : { allowRemote: this.options.allowRemote }),
      ...(tokenFile === undefined ? {} : { tokenFile }),
      openapi: openApiSource(openapi),
      asyncapi: asyncApiSource(asyncapi),
      // An omitted side is left out, so `devTypes()` uses the unnamed
      // document's source: the module's own, in Nest's terms, above.
      ...(documents === undefined
        ? {}
        : {
            documents: Object.fromEntries(
              Object.entries(documents).map(([name, document]) => [
                name,
                {
                  ...(document?.openapi === undefined
                    ? {}
                    : { openapi: openApiSource(document.openapi) }),
                  ...(document?.asyncapi === undefined
                    ? {}
                    : { asyncapi: asyncApiSource(document.asyncapi) }),
                },
              ]),
            ),
          }),
    });
    adapter.use(dev);
    this.#dev = dev;

    // The adapter's router is not the adapter: follow the Nest adapter's own
    // server, which is what `app.listen()` binds.
    const onListening = (server: unknown): void => {
      dev.listening(server as Parameters<DevTypesRouter["listening"]>[0]);
    };
    const onClose = (): void => {
      dev.close();
    };
    adapter.eventEmitter.on("listening", onListening);
    adapter.eventEmitter.on("close", onClose);
    this.#unfollow = () => {
      adapter.eventEmitter.off("listening", onListening);
      adapter.eventEmitter.off("close", onClose);
    };
    const server = adapter.getBunServer();
    if (server !== undefined) dev.listening(server);
  }

  /** Removes the token file and closes the watchers' sockets. */
  onApplicationShutdown(): void {
    this.#unfollow?.();
    this.#unfollow = undefined;
    this.#dev?.close();
  }
}

// `@Injectable()` and `@Inject(...)` on the constructor's parameters, by call:
// Bun reads the decorator options from the working directory's tsconfig
// (oven-sh/bun#28605), and the call behaves the same under either decorator
// semantics (validation.ts has the same pattern).
Injectable()(DevTypesMount);
Inject(DEV_TYPES_OPTIONS)(DevTypesMount, undefined, 0);
Inject(HttpAdapterHost)(DevTypesMount, undefined, 1);
Inject(ModulesContainer)(DevTypesMount, undefined, 2);

/**
 * The dev type sync as a Nest module (typed-client plan `nest-typed-routes.md`
 * §6): bun-common's `devTypes()` mounted on the `BunHttpAdapter` at
 * bootstrap, below Nest's pipeline (no guard or interceptor runs there, so
 * an app's global `AuthGuard` never decides whether the dev channel is
 * reachable, and the endpoint does its own: the token, loopback peers, and
 * the app's own 404 for anything refused). Its documents are the app's:
 * `generateOpenApi(adapter.instance)` for the controllers and
 * `gatewayAsyncApi` for the gateways; the token file follows the adapter's
 * server (`app.listen()`, `app.close()`).
 */
export class DevTypesModule {
  /**
   * The module, for `imports`. Disabled (`enabled` not exactly `true`) it
   * is an empty module that registers nothing.
   *
   * @param options See {@link DevTypesModuleOptions}.
   * @throws ConfigError when enabled under `NODE_ENV=production`.
   */
  static forRoot(options: DevTypesModuleOptions): DynamicModule {
    if (options?.enabled !== true) {
      return { module: DevTypesModule };
    }
    if (process.env.NODE_ENV === "production") {
      throw new ConfigError(
        'DevTypesModule.forRoot(): refused under NODE_ENV=production — the dev type sync is for development only; pass enabled: process.env.NODE_ENV !== "production"',
      );
    }
    return {
      module: DevTypesModule,
      providers: [
        { provide: DEV_TYPES_OPTIONS, useValue: options },
        DevTypesMount,
      ],
    };
  }
}

// `@Module({})` by call, as above.
Module({})(DevTypesModule);
