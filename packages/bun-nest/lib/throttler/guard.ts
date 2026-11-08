/**
 * `BunThrottlerGuard`: `@nestjs/throttler` 6's `ThrottlerGuard` on
 * bun-common's `throttle()` (https://github.com/nestjs/throttler,
 * `src/throttler.guard.ts`). Per request it works out the route's
 * throttlers — the module's, as `@Throttle()` and `@SkipThrottle()` on the
 * route and its controller change them — and counts the request against
 * each in the module's store, through one bun-common `throttle()` per
 * throttler shape (name, limit, window, algorithm, headers), built lazily and
 * kept. The headers are set on the response as bun-common sets them; a
 * refusal is a {@link ThrottlerException} thrown into Nest's exception layer.
 */
import type {
  BunRequest,
  BunResponse,
  ThrottleAlgorithm,
  ThrottleHandler,
  ThrottleHeaders,
  ThrottleLimitedInfo,
  ThrottleResult,
} from "@kingsleyweb/bun-common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { ThrottleDecoratorOptions } from "./decorators";
import type {
  BunThrottlerGenerateKey,
  BunThrottlerGetTracker,
  BunThrottlerLimitDetail,
  BunThrottlerModuleConfig,
  Resolvable,
} from "./options";
import {
  ConfigError,
  throttle,
  throttleAddressKey,
  ThrottleStoreError,
} from "@kingsleyweb/bun-common";
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { skipThrottleMetadataOf, throttleMetadataOf } from "./decorators";
import { throttlerMessage, ThrottlerException } from "./exception";
import { BunThrottlerService, checkLimit, ttlToMs } from "./options";

/** One throttler as it applies to one route. */
export interface ThrottlePlanEntry {
  /** The throttler's name. */
  readonly name: string;
  /** Whether `@SkipThrottle()` turns it off on the route. */
  readonly skipped: boolean;
  /** Its limit (a function is resolved per request). */
  readonly limit: Resolvable<number>;
  /** Its window, ms, or a function resolved per request. */
  readonly ttl: number | ((context: ExecutionContext) => unknown);
  /** Whether a window under a second is allowed. */
  readonly allowSubSecond: boolean;
  /** Its skip test (its own, else the module's). */
  readonly skipIf?: (context: ExecutionContext) => boolean | Promise<boolean>;
  /** Its user-agent list (its own, else the module's). */
  readonly ignoreUserAgents?: readonly RegExp[];
  /** Its tracker (route, controller, throttler, module), if one is set. */
  readonly getTracker?: BunThrottlerGetTracker;
  /** Its key generator (route, controller, throttler, module), if one is set. */
  readonly generateKey?: BunThrottlerGenerateKey;
  /** How it counts. */
  readonly algorithm: ThrottleAlgorithm;
  /** Which headers it sends. */
  readonly headers: ThrottleHeaders;
  /** Whether a successful request's count is given back (only failures count). */
  readonly skipSuccessfulRequests: boolean;
  /** Whether a failed request's count is given back (only successes count). */
  readonly skipFailedRequests: boolean;
}

/** A class or method name for messages, `anonymous` when it has none. */
function nameOf(target: { name?: unknown } | undefined): string {
  return typeof target?.name === "string" && target.name !== ""
    ? target.name
    : "anonymous";
}

/**
 * The throttlers that apply to one route (a controller class and one of its
 * handlers): the module's, then any `@Throttle()` declares that the module
 * does not, each with `@Throttle()`'s fields over the module's (the route's
 * over its controller's) and `@SkipThrottle()`'s flag (the route's over its
 * controller's). Throws a `ConfigError` for a throttler a decorator declares
 * without a limit or a window, or a bad value. `BunThrottlerGuard` and the
 * module's boot check both call it.
 */
export function throttlePlanFor(
  service: BunThrottlerService,
  controller: object,
  handler: object,
): ThrottlePlanEntry[] {
  const options = service.options;
  const where = `${nameOf(controller)}.${nameOf(handler)}`;
  const onMethod = throttleMetadataOf(handler);
  const onClass = throttleMetadataOf(controller);
  const skipMethod = skipThrottleMetadataOf(handler);
  const skipClass = skipThrottleMetadataOf(controller);
  const names = service.throttlers.map((t) => t.name);
  for (const name of [...Object.keys(onMethod), ...Object.keys(onClass)]) {
    if (!names.includes(name)) names.push(name);
  }
  return names.map((name): ThrottlePlanEntry => {
    const base = service.throttlers.find((t) => t.name === name);
    const method: ThrottleDecoratorOptions = onMethod[name] ?? {};
    const cls: ThrottleDecoratorOptions = onClass[name] ?? {};
    const at = `@Throttle({ ${name}: … }) on ${where}`;
    if (method.blockDuration !== undefined || cls.blockDuration !== undefined) {
      throw new ConfigError(
        `${at}: blockDuration is not supported (a refused client is refused only until its count falls under the limit again)`,
      );
    }
    const allowSubSecond =
      method.allowSubSecond ??
      cls.allowSubSecond ??
      base?.allowSubSecond ??
      false;
    const givenLimit = method.limit ?? cls.limit;
    const givenTtl = method.ttl ?? cls.ttl;
    const limit =
      givenLimit === undefined
        ? base?.limit
        : typeof givenLimit === "function"
          ? givenLimit
          : checkLimit(givenLimit, `${at}: limit`);
    const ttl =
      givenTtl === undefined
        ? base?.ttl
        : typeof givenTtl === "function"
          ? (givenTtl as (context: ExecutionContext) => unknown)
          : ttlToMs(givenTtl, `${at}: ttl`, allowSubSecond);
    if (limit === undefined || ttl === undefined) {
      throw new ConfigError(
        `${at}: BunThrottlerModule defines no throttler "${name}", so @Throttle() declares one for this route and must give both limit and ttl (on the route or its controller); it gives no ${limit === undefined ? "limit" : "ttl"}`,
        { name, route: where },
      );
    }
    const skipIf = base?.skipIf ?? options.skipIf;
    const ignoreUserAgents = base?.ignoreUserAgents ?? options.ignoreUserAgents;
    const getTracker =
      method.getTracker ??
      cls.getTracker ??
      base?.getTracker ??
      options.getTracker;
    const generateKey =
      method.generateKey ??
      cls.generateKey ??
      base?.generateKey ??
      options.generateKey;
    return {
      name,
      skipped: skipMethod[name] ?? skipClass[name] ?? false,
      limit,
      ttl,
      allowSubSecond,
      ...(skipIf === undefined ? {} : { skipIf }),
      ...(ignoreUserAgents === undefined ? {} : { ignoreUserAgents }),
      ...(getTracker === undefined ? {} : { getTracker }),
      ...(generateKey === undefined ? {} : { generateKey }),
      algorithm: base?.algorithm ?? options.algorithm,
      headers: base?.headers ?? options.headers,
      skipSuccessfulRequests: flag(
        method.skipSuccessfulRequests ??
          cls.skipSuccessfulRequests ??
          base?.skipSuccessfulRequests ??
          options.skipSuccessfulRequests,
        `${at}: skipSuccessfulRequests`,
      ),
      skipFailedRequests: flag(
        method.skipFailedRequests ??
          cls.skipFailedRequests ??
          base?.skipFailedRequests ??
          options.skipFailedRequests,
        `${at}: skipFailedRequests`,
      ),
    };
  });
}

/** A boolean option, checked: anything else is a `ConfigError` at startup. */
function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${what} must be a boolean`);
  }
  return value;
}

/** Carries a refusal out of a bun-common `throttle()` through its `next`. */
class Limited extends Error {
  constructor(readonly info: ThrottleLimitedInfo) {
    super("throttled");
  }
}

/** A bun-common throttle the guard built, and the key each request counts under. */
interface BuiltThrottle {
  /** The middleware. */
  readonly handler: ThrottleHandler;
  /** Each in-flight request's counter key. */
  readonly keys: WeakMap<object, string>;
}

/** One throttler's count for one request. */
interface Counted {
  readonly entry: ThrottlePlanEntry;
  readonly limit: number;
  readonly ttl: number;
  readonly tracker: string;
  readonly key: string;
  /** The refusing result, when the throttler refused the request. */
  readonly refused: ThrottleResult | undefined;
}

/** A plan cached for one route, and the service version it was made for. */
interface CachedPlan {
  readonly version: number;
  readonly entries: readonly ThrottlePlanEntry[];
}

/** Most throttle shapes one guard keeps before starting over (resolvable limits can make many). */
const MAX_THROTTLES = 1_000;

/**
 * Counts each request a route receives against the route's throttlers and
 * refuses it with a {@link ThrottlerException} (`429`) past any of them:
 * `@nestjs/throttler` 6's `ThrottlerGuard` (https://github.com/nestjs/throttler)
 * over bun-common's `throttle()`. Install it once, globally, after the
 * guards that should run before it:
 *
 * ```ts
 * providers: [{ provide: APP_GUARD, useClass: BunThrottlerGuard }]
 * ```
 *
 * or on a controller or route with `@UseGuards(BunThrottlerGuard)`, or with
 * `BunThrottlerModule.forRoot({ globalGuard: true, … })`. Only HTTP
 * requests are counted (`context.getType() === "http"`); a gateway or
 * microservice context passes.
 *
 * Its one dependency, the module's {@link BunThrottlerService}, is declared
 * explicitly (`@Inject(BunThrottlerService)`), never through emitted
 * `design:paramtypes`, so it resolves whatever the compiler emits — and so a
 * subclass without a constructor of its own resolves too. A subclass that
 * declares a constructor must declare its parameters the same way:
 * `constructor(@Inject(BunThrottlerService) t: BunThrottlerService) { super(t); }`.
 *
 * Override {@link getTracker}, {@link generateKey}, {@link shouldSkip},
 * {@link getErrorMessage} or {@link throwThrottlingException} to change
 * those steps, as with `ThrottlerGuard`.
 */
export class BunThrottlerGuard implements CanActivate {
  /** The module's throttlers and options. */
  protected readonly throttler: BunThrottlerService;
  /** Where refusals are logged (the module's `logLimited`) and store failures warned. */
  protected logger: Logger = new Logger("BunThrottlerGuard");
  /** The default exception message. */
  protected errorMessage: string = throttlerMessage;
  /** Each route's plan, by controller then handler. */
  readonly #plans = new WeakMap<object, WeakMap<object, CachedPlan>>();
  /** The throttles built, by shape. */
  readonly #throttles = new Map<string, BuiltThrottle>();

  constructor(
    /** The module's {@link BunThrottlerService} (injected), or module options for a guard built by hand. */
    throttler: BunThrottlerService | BunThrottlerModuleConfig,
  ) {
    this.throttler =
      throttler instanceof BunThrottlerService
        ? throttler
        : new BunThrottlerService(throttler);
  }

  /** Counts the request against the route's throttlers; throws a {@link ThrottlerException} past any. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    if (await this.shouldSkip(context)) return true;
    const entries = this.#planFor(context);
    const { req, res } = this.getRequestResponse(context);
    const agent = userAgentOf(req);
    const runs: Promise<Counted>[] = [];
    for (const entry of entries) {
      if (entry.skipped) continue;
      if (entry.skipIf !== undefined && (await entry.skipIf(context))) continue;
      if (
        entry.ignoreUserAgents?.some((pattern) => {
          pattern.lastIndex = 0;
          return pattern.test(agent);
        })
      ) {
        continue;
      }
      runs.push(this.#count(entry, context, req, res));
    }
    if (runs.length === 0) return true;
    const counted = await Promise.all(runs);
    const refused = counted.filter((c) => c.refused !== undefined);
    if (refused.length === 0) return true;
    // Each refusing throttle set `Retry-After` for itself; the request may
    // come back only once every one of them lets it.
    const wait = Math.max(...refused.map((c) => c.refused!.retryAfter));
    const waitSeconds = Math.max(1, Math.ceil(wait / 1000));
    if (!res.headersSent) res.setHeader("Retry-After", String(waitSeconds));
    const first = refused[0];
    const level = this.throttler.options.logLimited;
    if (level !== false) {
      for (const c of refused) {
        // The route, the throttler and its limit; never the tracker or the key.
        this.logger[level](
          `${nameOf(context.getClass())}.${nameOf(context.getHandler())}: throttler "${c.entry.name}" refused a request (limit ${c.limit} per ${c.ttl} ms)`,
        );
      }
    }
    const result = first.refused!;
    await this.throwThrottlingException(context, {
      name: first.entry.name,
      limit: first.limit,
      ttl: first.ttl,
      key: first.key,
      tracker: first.tracker,
      totalHits: result.used,
      timeToExpire: Math.ceil(result.resetAfter / 1000),
      isBlocked: true,
      timeToBlockExpire: waitSeconds,
    });
    return false;
  }

  /** Whether to let the request through uncounted, before any throttler: `false`. Override it (`ThrottlerGuard.shouldSkip`). */
  protected shouldSkip(_context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Who a request counts against when no tracker is configured: the
   * client's address (`req.ip`), an IPv6 one reduced to the module's
   * `ipv6SubnetPrefix`, `"unknown"` when the request has none.
   * `req.ip` is the client's only when the adapter trusts the proxies in
   * front of it. Override it (`ThrottlerGuard.getTracker`).
   */
  protected getTracker(
    req: BunRequest,
    _context: ExecutionContext,
  ): Promise<string> {
    const ip = req.ip;
    return Promise.resolve(
      ip === "" || ip === undefined || ip === null
        ? "unknown"
        : throttleAddressKey(ip, this.throttler.options.ipv6SubnetPrefix),
    );
  }

  /**
   * The counter key when no generator is configured: the controller, the
   * handler, the throttler and the tracker, hashed (SHA-256, as
   * `ThrottlerGuard.generateKey`), so each route counts on its own and the
   * store's keys hold no address or account. Override it.
   */
  protected generateKey(
    context: ExecutionContext,
    tracker: string,
    name: string,
  ): string {
    return new Bun.CryptoHasher("sha256")
      .update(
        `${nameOf(context.getClass())}-${nameOf(context.getHandler())}-${name}-${tracker}`,
      )
      .digest("hex");
  }

  /** The request and response, as Nest's HTTP context gives them. */
  protected getRequestResponse(context: ExecutionContext): {
    req: BunRequest;
    res: BunResponse;
  } {
    const http = context.switchToHttp();
    return {
      req: http.getRequest<BunRequest>(),
      res: http.getResponse<BunResponse>(),
    };
  }

  /** Throws the {@link ThrottlerException} for a refusal. Override it to throw something else. */
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: BunThrottlerLimitDetail,
  ): Promise<void> {
    throw new ThrottlerException(await this.getErrorMessage(context, detail));
  }

  /** The exception's message: the module's `errorMessage`, else {@link errorMessage}. */
  protected async getErrorMessage(
    context: ExecutionContext,
    detail: BunThrottlerLimitDetail,
  ): Promise<string> {
    const given = this.throttler.options.errorMessage;
    if (given === undefined) return this.errorMessage;
    return typeof given === "function" ? given(context, detail) : given;
  }

  /** The route's plan, cached until the service's throttlers change. */
  #planFor(context: ExecutionContext): readonly ThrottlePlanEntry[] {
    const controller = context.getClass() as object;
    const handler = context.getHandler() as object;
    let byHandler = this.#plans.get(controller);
    if (byHandler === undefined) {
      byHandler = new WeakMap();
      this.#plans.set(controller, byHandler);
    }
    const version = this.throttler.version;
    const cached = byHandler.get(handler);
    if (cached !== undefined && cached.version === version) {
      return cached.entries;
    }
    const entries = throttlePlanFor(this.throttler, controller, handler);
    byHandler.set(handler, { version, entries });
    return entries;
  }

  /** Counts the request against one throttler. */
  async #count(
    entry: ThrottlePlanEntry,
    context: ExecutionContext,
    req: BunRequest,
    res: BunResponse,
  ): Promise<Counted> {
    const where = `throttler "${entry.name}" on ${nameOf(context.getClass())}.${nameOf(context.getHandler())}`;
    const limit =
      typeof entry.limit === "function"
        ? checkLimit(await entry.limit(context), `${where}: limit`)
        : entry.limit;
    const ttl =
      typeof entry.ttl === "function"
        ? ttlToMs(
            await entry.ttl(context),
            `${where}: ttl`,
            entry.allowSubSecond,
          )
        : entry.ttl;
    const tracker = String(
      entry.getTracker === undefined
        ? await this.getTracker(req, context)
        : await entry.getTracker(req, context),
    );
    const key =
      entry.generateKey === undefined
        ? this.generateKey(context, tracker, entry.name)
        : entry.generateKey(context, tracker, entry.name);
    const built = this.#throttleFor(entry, limit, ttl);
    const refused = await run(built, req, res, key);
    return { entry, limit, ttl, tracker, key, refused };
  }

  /** The bun-common throttle for one throttler shape, built on first use. */
  #throttleFor(
    entry: ThrottlePlanEntry,
    limit: number,
    ttl: number,
  ): BuiltThrottle {
    const shape = `${entry.name}|${limit}|${ttl}|${entry.algorithm}|${String(entry.headers)}|${entry.skipSuccessfulRequests ? "s" : ""}${entry.skipFailedRequests ? "f" : ""}`;
    let built = this.#throttles.get(shape);
    if (built !== undefined) return built;
    if (this.#throttles.size >= MAX_THROTTLES) this.#throttles.clear();
    const options = this.throttler.options;
    const keys = new WeakMap<object, string>();
    const handler = throttle({
      limits: {
        [entry.name]: {
          limit,
          window: { ms: ttl },
          key: (req) => keys.get(req) ?? "unknown",
          ...(entry.allowSubSecond ? { allowSubSecond: true } : {}),
        },
      },
      store: options.store,
      prefix: options.prefix,
      scope: "global",
      algorithm: entry.algorithm,
      headers: entry.headers,
      skipSuccessfulRequests: entry.skipSuccessfulRequests,
      skipFailedRequests: entry.skipFailedRequests,
      ...(options.requestWasSuccessful === undefined
        ? {}
        : { requestWasSuccessful: options.requestWasSuccessful }),
      failMode: options.failMode,
      logger: this.logger,
      onLimited: (_req, _res, next, info) => next(new Limited(info)),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    built = { handler, keys };
    this.#throttles.set(shape, built);
    return built;
  }
}

/** Runs a built throttle for one request: the refusing result, or `undefined` when it let the request through. */
function run(
  built: BuiltThrottle,
  req: BunRequest,
  res: BunResponse,
  key: string,
): Promise<ThrottleResult | undefined> {
  return new Promise<ThrottleResult | undefined>((resolve, reject) => {
    built.keys.set(req, key);
    const settle = (error?: unknown) => {
      built.keys.delete(req);
      if (error instanceof Limited) resolve(error.info.limited[0]);
      else if (error instanceof ThrottleStoreError) {
        // `failMode: "closed"`: the limit cannot be checked, so the request
        // is not served — as a `503` Nest's exception layer answers.
        reject(
          new ServiceUnavailableException("Rate limit unavailable", {
            cause: error,
          }),
        );
      } else if (error !== undefined && error !== null && error !== "") {
        reject(
          error instanceof Error
            ? error
            : new Error("throttle failed", { cause: error }),
        );
      } else resolve(undefined);
    };
    try {
      const outcome: unknown = built.handler(req, res, (error) => {
        settle(error);
        return undefined;
      });
      if (
        typeof outcome === "object" &&
        outcome !== null &&
        typeof (outcome as Promise<unknown>).then === "function"
      ) {
        (outcome as Promise<unknown>).then(undefined, settle);
      }
    } catch (error) {
      settle(error);
    }
  });
}

/** The request's `User-Agent`, `""` when it has none. */
function userAgentOf(req: BunRequest): string {
  const value = req.headers["user-agent"];
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

// Declared by call, not by syntax: Bun reads decorator options from the
// working directory's tsconfig (oven-sh/bun#28605), so a parameter decorator
// written as syntax can be dropped silently in an application compiled
// without them. Declared this way, the dependency never depends on emitted
// `design:paramtypes` either.
Injectable()(BunThrottlerGuard);
Inject(BunThrottlerService)(BunThrottlerGuard, undefined, 0);
