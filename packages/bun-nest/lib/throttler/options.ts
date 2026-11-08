import type {
  BunRequest,
  Duration,
  ThrottleAlgorithm,
  ThrottleHeaders,
  ThrottleOptions,
  ThrottleRequestWasSuccessful,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import type {
  ExecutionContext,
  LogLevel,
  ModuleMetadata,
  Type,
} from "@nestjs/common";
import {
  ConfigError,
  memoryThrottleStore,
  throttle,
  toDurationMs,
} from "@kingsleyweb/bun-common";

/**
 * A value, or a function of the request's execution context answering it
 * (`@nestjs/throttler`'s `Resolvable`): `limit: (ctx) => isPremium(ctx) ? 1000 : 100`.
 */
export type Resolvable<T> = T | ((context: ExecutionContext) => T | Promise<T>);

/**
 * Who a request counts against: an address, an account, an API key
 * (`@nestjs/throttler`'s `getTracker`). Default: the client's address
 * (`req.ip`, an IPv6 address reduced to its {@link BunThrottlerModuleOptions.ipv6SubnetPrefix}).
 */
export type BunThrottlerGetTracker = (
  req: BunRequest,
  context: ExecutionContext,
) => string | Promise<string>;

/**
 * The counter key from the tracker (`@nestjs/throttler`'s `generateKey`).
 * Default: the controller and handler names and the tracker, hashed (SHA-256),
 * so one count per route per client and no address or account in the store's
 * keys. Return the tracker alone to count a client across every route.
 */
export type BunThrottlerGenerateKey = (
  context: ExecutionContext,
  tracker: string,
  name: string,
) => string;

/**
 * One named throttler, as `BunThrottlerModule.forRoot({ throttlers: [...] })`
 * takes it (`@nestjs/throttler` 6's `ThrottlerOptions`, with bun-common's
 * extras). Every route the guard covers counts against every throttler it
 * does not skip, once per route per client by default.
 */
export interface BunThrottlerOptions {
  /** The throttler's name: what `@Throttle()`, `@SkipThrottle()` and the header suffixes name. Default `"default"`. Letters, digits, `_`, `.` and `-`. */
  readonly name?: string;
  /** The most requests per {@link ttl}: a positive integer, or a function of the context. */
  readonly limit: Resolvable<number>;
  /**
   * The window: a duration string (`"1m"`, `"30s"`, `"1h"`) or object
   * (`seconds(60)`, `{ minutes: 1 }`), or a function of the context
   * answering one. **Never a bare number**, unlike `@nestjs/throttler`'s
   * milliseconds: `ttl: 60` is a type error and a startup error, since it
   * is ambiguous. Under a second only with {@link allowSubSecond}.
   */
  readonly ttl: Resolvable<Duration>;
  /** Allows a {@link ttl} under one second (usually a unit mistake). Default `false`. */
  readonly allowSubSecond?: boolean;
  /** Requests whose `User-Agent` matches one of these are not counted by this throttler. Default the module's. */
  readonly ignoreUserAgents?: readonly RegExp[];
  /**
   * Requests it answers `true` for are not counted by this throttler (a
   * health check, a trusted service's call). Default the module's. Set it
   * here, on the throttler, to exempt a caller from this throttler while
   * others still apply: a service token that skips `default` only.
   */
  readonly skipIf?: (context: ExecutionContext) => boolean | Promise<boolean>;
  /** Who a request counts against under this throttler; default the module's, then the guard's {@link BunThrottlerGetTracker}. */
  readonly getTracker?: BunThrottlerGetTracker;
  /** The counter key under this throttler; default the module's, then the guard's {@link BunThrottlerGenerateKey}. */
  readonly generateKey?: BunThrottlerGenerateKey;
  /** How this throttler counts; default the module's {@link BunThrottlerModuleOptions.algorithm}. */
  readonly algorithm?: ThrottleAlgorithm;
  /** Which rate-limit headers this throttler sends; default the module's {@link BunThrottlerModuleOptions.headers}. */
  readonly headers?: ThrottleHeaders;
  /**
   * Gives a successful request's count back once its response is sent, so
   * only failures count (a login throttler that counts failed attempts):
   * express-rate-limit's `skipSuccessfulRequests`, through bun-common's
   * `throttle()`. Success is the module's {@link BunThrottlerModuleOptions.requestWasSuccessful}.
   * Default the module's, else `false`.
   */
  readonly skipSuccessfulRequests?: boolean;
  /**
   * Gives a failed request's count back once its response is sent (or the
   * client went away first), so only successes count: express-rate-limit's
   * `skipFailedRequests`. A refusal is a `429`, a failure, so it is given
   * back too. Default the module's, else `false`.
   */
  readonly skipFailedRequests?: boolean;
  /**
   * Not supported: `@nestjs/throttler`'s block after a refusal has no
   * equivalent yet. A type error, and refused at startup.
   */
  readonly blockDuration?: never;
}

/**
 * What `BunThrottlerModule.forRoot()` takes (`@nestjs/throttler` 6's
 * `ThrottlerModuleOptions` object form, with bun-common's extras). A bare
 * array of throttlers is accepted too, as there.
 */
export interface BunThrottlerModuleOptions {
  /** The named throttlers every guarded route counts against (see {@link BunThrottlerOptions}). May be empty when `@Throttle()` declares them per route. */
  readonly throttlers: readonly BunThrottlerOptions[];
  /** Requests whose `User-Agent` matches one of these are counted by no throttler (a throttler's own list wins). Default: none. */
  readonly ignoreUserAgents?: readonly RegExp[];
  /** Requests it answers `true` for are counted by no throttler that lacks a `skipIf` of its own. Default: none. */
  readonly skipIf?: (context: ExecutionContext) => boolean | Promise<boolean>;
  /** Who a request counts against, for every throttler without its own. Default the guard's `getTracker()`: the address. */
  readonly getTracker?: BunThrottlerGetTracker;
  /** The counter key, for every throttler without its own. Default the guard's `generateKey()`: per route per client, hashed. */
  readonly generateKey?: BunThrottlerGenerateKey;
  /**
   * The `ThrottlerException` message: a string, or a function of the
   * context and the refusing throttler's detail. Default
   * `"ThrottlerException: Too Many Requests"`.
   */
  readonly errorMessage?:
    | string
    | ((
        context: ExecutionContext,
        detail: BunThrottlerLimitDetail,
      ) => string | Promise<string>);
  /**
   * Where the counts live: any bun-common `ThrottleStore`. Default one
   * `memoryThrottleStore()` for the module (per process; every guard of the
   * module shares it). For limits across processes and instances, a shared
   * store: `cacheThrottleStore(cache)` from `@kingsleyweb/bun-nest/cache`
   * (or `@kingsleyweb/bun-cache/throttle`) over a Redis or SQL cache.
   */
  readonly store?: ThrottleStore;
  /**
   * The prefix length an IPv6 address is reduced to by the default tracker,
   * since one client usually holds a whole `/64` or `/56`. Default `56`
   * (bun-common's and express-rate-limit 8's; `@nestjs/throttler` 6.5
   * defaults to `64`); `false` keeps the full address.
   */
  readonly ipv6SubnetPrefix?: false | number;
  /** How every throttler counts. Default `"sliding-window"` (bun-common's; `@nestjs/throttler` counts fixed windows). */
  readonly algorithm?: ThrottleAlgorithm;
  /** {@link BunThrottlerOptions.skipSuccessfulRequests} for every throttler without its own. Default `false`. */
  readonly skipSuccessfulRequests?: boolean;
  /** {@link BunThrottlerOptions.skipFailedRequests} for every throttler without its own. Default `false`. */
  readonly skipFailedRequests?: boolean;
  /**
   * What `skipSuccessfulRequests` and `skipFailedRequests` call success.
   * Default `res.statusCode < 400` (express-rate-limit's
   * `requestWasSuccessful`), read once the response has been sent, so an
   * exception Nest answered counts by the status it answered with.
   */
  readonly requestWasSuccessful?: ThrottleRequestWasSuccessful;
  /**
   * Which rate-limit headers a throttled response carries: `false` (the
   * default, as bun-common's `throttle()`), `"legacy"` for
   * `@nestjs/throttler`'s `X-RateLimit-Limit`/`-Remaining`/`-Reset` (with a
   * `-<name>` suffix for a throttler not named `default`), `"ietf"` or
   * `true` for the IETF draft's `RateLimit-Policy`/`RateLimit`, `"both"`.
   * A `429` carries `Retry-After` whatever this says. `@nestjs/throttler`
   * sends its headers by default (`setHeaders: true`).
   */
  readonly headers?: ThrottleHeaders;
  /**
   * What a request gets when the store fails: `"open"` (the default) lets it
   * through, `"closed"` answers `503`, a `ThrottleStore` is counted in
   * instead (degrade to local). bun-common's `throttle()` option.
   */
  readonly failMode?: ThrottleOptions["failMode"];
  /**
   * One log line per refused request, naming the controller, the handler,
   * the throttler and its limit, never the address or the account: `true`
   * logs at `warn`, a level logs at that level. Default `false`.
   */
  readonly logLimited?: boolean | LogLevel;
  /** The namespace of every key the module writes to its store. Default `"throttler"`. */
  readonly prefix?: string;
  /**
   * Checks, once the application has booted, that a `BunThrottlerGuard` is
   * installed somewhere (a global guard, `APP_GUARD` or
   * `app.useGlobalGuards()`, or `@UseGuards()` on a controller or route),
   * since importing the module alone throttles nothing. `"error"` (the
   * default) logs an error when none is; `"throw"` fails the boot; `false`
   * checks nothing. A production application once ran unthrottled because
   * another guard had been registered as its `APP_GUARD` instead.
   */
  readonly guardCheck?: "error" | "throw" | false;
  /**
   * Installs `BunThrottlerGuard` as an `APP_GUARD` from the module itself,
   * so it cannot be forgotten. Default `false`, as `@nestjs/throttler`:
   * global guards run in the order modules provide them, so an application
   * that orders its guards (a block list first, then the throttler, then
   * authentication) registers it itself.
   */
  readonly globalGuard?: boolean;
  /** The clock, epoch milliseconds. Default `Date.now`; tests pass a fake one. */
  readonly now?: () => number;
}

/** {@link BunThrottlerModuleOptions}, or a bare array of throttlers, as `@nestjs/throttler` accepts. */
export type BunThrottlerModuleConfig =
  BunThrottlerModuleOptions | readonly BunThrottlerOptions[];

/** What `BunThrottlerModule.forRootAsync()` takes. */
export interface BunThrottlerModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  /** Builds the options; its arguments are the {@link inject}ed providers. */
  readonly useFactory?: (
    ...args: never[]
  ) => BunThrottlerModuleConfig | Promise<BunThrottlerModuleConfig>;
  /** The providers {@link useFactory} receives, in order. */
  readonly inject?: readonly (string | symbol | Type | object)[];
  /** A class the module instantiates whose `createThrottlerOptions()` builds the options. */
  readonly useClass?: Type<BunThrottlerOptionsFactory>;
  /** An existing provider whose `createThrottlerOptions()` builds the options. */
  readonly useExisting?: Type<BunThrottlerOptionsFactory>;
  /** Installs the guard as an `APP_GUARD`; see {@link BunThrottlerModuleOptions.globalGuard}. Known up front, since it decides the module's providers. */
  readonly globalGuard?: boolean;
}

/** Builds the module's options, for `forRootAsync({ useClass })` (`@nestjs/throttler`'s `ThrottlerOptionsFactory`). */
export interface BunThrottlerOptionsFactory {
  /** The options, or a promise of them. */
  createThrottlerOptions: () =>
    BunThrottlerModuleConfig | Promise<BunThrottlerModuleConfig>;
}

/** What the `errorMessage` function and `throwThrottlingException()` are told about the refusing throttler (`@nestjs/throttler`'s `ThrottlerLimitDetail`). */
export interface BunThrottlerLimitDetail {
  /** The throttler's name. */
  readonly name: string;
  /** Its limit for this route. */
  readonly limit: number;
  /** Its window for this route, in milliseconds. */
  readonly ttl: number;
  /** The counter key (see {@link BunThrottlerGenerateKey}). */
  readonly key: string;
  /** Who the request counted against (see {@link BunThrottlerGetTracker}). */
  readonly tracker: string;
  /** Requests counted in the window, this one included (an estimate under the sliding window). */
  readonly totalHits: number;
  /** Seconds until the count refills. */
  readonly timeToExpire: number;
  /** Always `true`: the detail is of a refusal. */
  readonly isBlocked: boolean;
  /** Seconds until a request would be let through (`Retry-After`). */
  readonly timeToBlockExpire: number;
}

/** A throttler as the module holds it. */
export interface ResolvedThrottler {
  /** Its name. */
  readonly name: string;
  /** Its limit (a function is resolved per request). */
  readonly limit: Resolvable<number>;
  /** Its window in milliseconds, or a function resolved per request. */
  readonly ttl: number | ((context: ExecutionContext) => unknown);
  /** Whether a window under a second is allowed. */
  readonly allowSubSecond: boolean;
  /** Its own user-agent list, if any. */
  readonly ignoreUserAgents?: readonly RegExp[];
  /** Its own skip test, if any. */
  readonly skipIf?: (context: ExecutionContext) => boolean | Promise<boolean>;
  /** Its own tracker, if any. */
  readonly getTracker?: BunThrottlerGetTracker;
  /** Its own key generator, if any. */
  readonly generateKey?: BunThrottlerGenerateKey;
  /** Its own algorithm, if any. */
  readonly algorithm?: ThrottleAlgorithm;
  /** Its own headers, if any. */
  readonly headers?: ThrottleHeaders;
  /** Its own `skipSuccessfulRequests`, if any. */
  readonly skipSuccessfulRequests?: boolean;
  /** Its own `skipFailedRequests`, if any. */
  readonly skipFailedRequests?: boolean;
}

/** The module's options, checked and with their defaults. */
export interface ResolvedThrottlerOptions {
  /** The module's throttlers. */
  readonly throttlers: readonly ResolvedThrottler[];
  /** See {@link BunThrottlerModuleOptions.ignoreUserAgents}. */
  readonly ignoreUserAgents?: readonly RegExp[];
  /** See {@link BunThrottlerModuleOptions.skipIf}. */
  readonly skipIf?: (context: ExecutionContext) => boolean | Promise<boolean>;
  /** See {@link BunThrottlerModuleOptions.getTracker}. */
  readonly getTracker?: BunThrottlerGetTracker;
  /** See {@link BunThrottlerModuleOptions.generateKey}. */
  readonly generateKey?: BunThrottlerGenerateKey;
  /** See {@link BunThrottlerModuleOptions.errorMessage}. */
  readonly errorMessage?: BunThrottlerModuleOptions["errorMessage"];
  /** The store every guard of the module counts in. */
  readonly store: ThrottleStore;
  /** The IPv6 prefix of the default tracker. */
  readonly ipv6SubnetPrefix: false | number;
  /** The default algorithm. */
  readonly algorithm: ThrottleAlgorithm;
  /** The default headers. */
  readonly headers: ThrottleHeaders;
  /** The default `skipSuccessfulRequests`. */
  readonly skipSuccessfulRequests: boolean;
  /** The default `skipFailedRequests`. */
  readonly skipFailedRequests: boolean;
  /** See {@link BunThrottlerModuleOptions.requestWasSuccessful}. */
  readonly requestWasSuccessful?: ThrottleRequestWasSuccessful;
  /** The store failure policy. */
  readonly failMode: NonNullable<ThrottleOptions["failMode"]>;
  /** The level refusals are logged at, or `false`. */
  readonly logLimited: false | LogLevel;
  /** The key namespace. */
  readonly prefix: string;
  /** The boot check. */
  readonly guardCheck: "error" | "throw" | false;
  /** The clock. */
  readonly now?: () => number;
}

/** The throttler-name grammar: bun-common's limit names. */
const NAME = /^[a-z0-9][\w.-]*$/i;

/**
 * A window as milliseconds, checked: a duration string or object, never a
 * bare number, under a second only when allowed.
 *
 * @param value The `ttl` given.
 * @param what  The option's name, for the error.
 * @param allowSubSecond Whether a window under one second is allowed.
 */
export function ttlToMs(
  value: unknown,
  what: string,
  allowSubSecond = false,
): number {
  if (typeof value === "number") {
    throw new ConfigError(
      `${what}: a bare number is ambiguous (@nestjs/throttler reads milliseconds, so ttl: 60 is 60 ms); write the unit: "1m", "60s" or seconds(60)`,
      { value },
    );
  }
  const ms = toDurationMs(value as Duration, what);
  if (ms < 1000 && !allowSubSecond) {
    throw new ConfigError(
      `${what} is ${ms} ms, under a second; that is usually a unit mistake. Set allowSubSecond: true on the throttler if it is meant`,
      { value },
    );
  }
  return ms;
}

/** A positive integer limit, checked. */
export function checkLimit(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(
      `${what} must be a positive integer; got ${JSON.stringify(value)}`,
      { value },
    );
  }
  return value;
}

/** Throws when an `@nestjs/throttler` option this module spells differently, or lacks, is given. */
function refuseForeign(given: object, where: string): void {
  const foreign: Record<string, string> = {
    blockDuration:
      "blockDuration is not supported (a refused client is refused only until its count falls under the limit again)",
    setHeaders:
      'setHeaders is spelled headers here: headers: "legacy" sends @nestjs/throttler\'s X-RateLimit-* headers, false none',
    storage:
      "storage is spelled store here, and takes a bun-common ThrottleStore (memoryThrottleStore(), or cacheThrottleStore(cache) from @kingsleyweb/bun-nest/cache)",
  };
  for (const [key, why] of Object.entries(foreign)) {
    if (key in given && (given as Record<string, unknown>)[key] !== undefined) {
      throw new ConfigError(`${where}: ${why}`, { option: key });
    }
  }
}

/**
 * Checks the module's options and fills in their defaults, so a bad option
 * fails at startup rather than on the first request.
 */
export function resolveThrottlerOptions(
  config: BunThrottlerModuleConfig,
): ResolvedThrottlerOptions {
  const where = "BunThrottlerModule";
  if (config === null || typeof config !== "object") {
    throw new ConfigError(
      `${where}: options must be an object with throttlers, or an array of throttlers`,
    );
  }
  const options: BunThrottlerModuleOptions = Array.isArray(config)
    ? { throttlers: config as readonly BunThrottlerOptions[] }
    : (config as BunThrottlerModuleOptions);
  refuseForeign(options, where);
  if (!Array.isArray(options.throttlers)) {
    throw new ConfigError(`${where}: throttlers must be an array`);
  }
  const names = new Set<string>();
  const given: readonly BunThrottlerOptions[] = options.throttlers;
  const throttlers = given.map(
    (spec: BunThrottlerOptions, index): ResolvedThrottler => {
      if (spec === null || typeof spec !== "object") {
        throw new ConfigError(
          `${where}: throttlers[${index}] must be an object`,
        );
      }
      const name = spec.name ?? "default";
      const at = `${where}: throttler "${name}"`;
      refuseForeign(spec, at);
      if (typeof name !== "string" || !NAME.test(name)) {
        throw new ConfigError(
          `${where}: throttler name ${JSON.stringify(name)} must start with a letter or digit and hold only letters, digits, "_", "." and "-"`,
        );
      }
      if (names.has(name)) {
        throw new ConfigError(
          `${where}: two throttlers are named "${name}"; give each its own name`,
        );
      }
      names.add(name);
      const allowSubSecond = spec.allowSubSecond === true;
      const limit =
        typeof spec.limit === "function"
          ? spec.limit
          : checkLimit(spec.limit, `${at}: limit`);
      const ttl =
        typeof spec.ttl === "function"
          ? (spec.ttl as (context: ExecutionContext) => unknown)
          : ttlToMs(spec.ttl, `${at}: ttl`, allowSubSecond);
      return {
        name,
        limit,
        ttl,
        allowSubSecond,
        ...(spec.ignoreUserAgents === undefined
          ? {}
          : { ignoreUserAgents: spec.ignoreUserAgents }),
        ...(spec.skipIf === undefined ? {} : { skipIf: spec.skipIf }),
        ...(spec.getTracker === undefined
          ? {}
          : { getTracker: spec.getTracker }),
        ...(spec.generateKey === undefined
          ? {}
          : { generateKey: spec.generateKey }),
        ...(spec.algorithm === undefined ? {} : { algorithm: spec.algorithm }),
        ...(spec.headers === undefined ? {} : { headers: spec.headers }),
        ...(spec.skipSuccessfulRequests === undefined
          ? {}
          : { skipSuccessfulRequests: spec.skipSuccessfulRequests }),
        ...(spec.skipFailedRequests === undefined
          ? {}
          : { skipFailedRequests: spec.skipFailedRequests }),
      };
    },
  );
  const subnet = options.ipv6SubnetPrefix ?? 56;
  if (
    subnet !== false &&
    (!Number.isInteger(subnet) || subnet < 1 || subnet > 128)
  ) {
    throw new ConfigError(
      `${where}: ipv6SubnetPrefix must be an integer from 1 to 128, or false`,
    );
  }
  const prefix = options.prefix ?? "throttler";
  if (typeof prefix !== "string" || prefix === "") {
    throw new ConfigError(`${where}: prefix must be a non-empty string`);
  }
  const guardCheck = options.guardCheck ?? "error";
  if (
    guardCheck !== "error" &&
    guardCheck !== "throw" &&
    guardCheck !== false
  ) {
    throw new ConfigError(
      `${where}: guardCheck must be "error", "throw" or false`,
    );
  }
  const logLimited =
    options.logLimited === true
      ? "warn"
      : options.logLimited === undefined
        ? false
        : options.logLimited;
  const store =
    options.store ??
    memoryThrottleStore(options.now === undefined ? {} : { now: options.now });
  const algorithm = options.algorithm ?? "sliding-window";
  const headers = options.headers ?? false;
  const failMode = options.failMode ?? "open";
  const skipSuccessfulRequests = options.skipSuccessfulRequests ?? false;
  const skipFailedRequests = options.skipFailedRequests ?? false;
  // bun-common checks the store, the algorithm, the headers and the fail
  // mode when a throttle is built; build one now so a bad value fails here,
  // at startup, not on the first request a guard counts. Each throttler's
  // own algorithm and headers are checked the same way.
  for (const probe of [
    {
      algorithm,
      headers,
      skipSuccessfulRequests,
      skipFailedRequests,
      ...(options.requestWasSuccessful === undefined
        ? {}
        : { requestWasSuccessful: options.requestWasSuccessful }),
    },
    ...throttlers.map((t) => ({
      algorithm: t.algorithm ?? algorithm,
      headers: t.headers ?? headers,
      skipSuccessfulRequests:
        t.skipSuccessfulRequests ?? skipSuccessfulRequests,
      skipFailedRequests: t.skipFailedRequests ?? skipFailedRequests,
    })),
  ]) {
    throttle({
      limit: 1,
      window: "1m",
      store,
      failMode,
      ...probe,
    });
  }
  return {
    throttlers,
    ...(options.ignoreUserAgents === undefined
      ? {}
      : { ignoreUserAgents: options.ignoreUserAgents }),
    ...(options.skipIf === undefined ? {} : { skipIf: options.skipIf }),
    ...(options.getTracker === undefined
      ? {}
      : { getTracker: options.getTracker }),
    ...(options.generateKey === undefined
      ? {}
      : { generateKey: options.generateKey }),
    ...(options.errorMessage === undefined
      ? {}
      : { errorMessage: options.errorMessage }),
    store,
    ipv6SubnetPrefix: subnet,
    algorithm,
    headers,
    skipSuccessfulRequests,
    skipFailedRequests,
    ...(options.requestWasSuccessful === undefined
      ? {}
      : { requestWasSuccessful: options.requestWasSuccessful }),
    failMode,
    logLimited,
    prefix,
    guardCheck,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

/**
 * The module's throttlers at run time, injectable anywhere once
 * `BunThrottlerModule` is imported (it is global): every `BunThrottlerGuard`
 * reads them per request, so {@link update} changes a limit or a window
 * everywhere at once, without a restart. Counts already made carry over a
 * limit change; a window change starts fresh counts.
 *
 * ```ts
 * constructor(@Inject(BunThrottlerService) private readonly throttler: BunThrottlerService) {}
 * raise() { this.throttler.update("default", { limit: 1200 }); }
 * ```
 */
export class BunThrottlerService {
  /** The module's options, checked, with their defaults. */
  readonly options: ResolvedThrottlerOptions;
  /** The module's throttlers, as {@link update} leaves them. */
  #throttlers: readonly ResolvedThrottler[];
  /** Bumped by every {@link update}, so guards rebuild what they cached. */
  #version = 0;

  constructor(
    /** The module's options as given to `forRoot()` (or built by `forRootAsync()`). */
    config: BunThrottlerModuleConfig,
  ) {
    this.options = resolveThrottlerOptions(config);
    this.#throttlers = this.options.throttlers;
  }

  /** The store every guard of the module counts in. */
  get store(): ThrottleStore {
    return this.options.store;
  }

  /** The module's throttlers, in the order they were given. */
  get throttlers(): readonly ResolvedThrottler[] {
    return this.#throttlers;
  }

  /** How many times {@link update} has run: guards compare it to what they cached. */
  get version(): number {
    return this.#version;
  }

  /**
   * Changes a module throttler's limit or window (or both) for every guard,
   * from the next request on. A route's `@Throttle()` still wins where it
   * sets the same field. Throws a `ConfigError` for an unknown name or a bad
   * value, changing nothing.
   *
   * @param name  The throttler's name.
   * @param patch The fields to change: `limit` and `ttl`, as the module takes them.
   */
  update(
    name: string,
    patch: {
      /** The new limit. */
      readonly limit?: Resolvable<number>;
      /** The new window. */
      readonly ttl?: Resolvable<Duration>;
    },
  ): void {
    const index = this.#throttlers.findIndex((t) => t.name === name);
    if (index === -1) {
      throw new ConfigError(
        `BunThrottlerService.update(): no throttler is named "${name}"`,
        { name },
      );
    }
    const current = this.#throttlers[index];
    const at = `BunThrottlerService.update(): throttler "${name}"`;
    const next: ResolvedThrottler = {
      ...current,
      ...(patch.limit === undefined
        ? {}
        : {
            limit:
              typeof patch.limit === "function"
                ? patch.limit
                : checkLimit(patch.limit, `${at}: limit`),
          }),
      ...(patch.ttl === undefined
        ? {}
        : {
            ttl:
              typeof patch.ttl === "function"
                ? patch.ttl
                : ttlToMs(patch.ttl, `${at}: ttl`, current.allowSubSecond),
          }),
    };
    const list = [...this.#throttlers];
    list[index] = next;
    this.#throttlers = list;
    this.#version++;
  }
}
