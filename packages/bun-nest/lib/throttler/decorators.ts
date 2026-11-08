import type { Duration } from "@kingsleyweb/bun-common";
import type {
  BunThrottlerGenerateKey,
  BunThrottlerGetTracker,
  Resolvable,
} from "./options";

/** Where `@Throttle()` keeps its overrides: one record per target, by throttler name. */
export const THROTTLE_METADATA = "bun-nest:throttle";
/** Where `@SkipThrottle()` keeps its flags: one record per target, by throttler name. */
export const SKIP_THROTTLE_METADATA = "bun-nest:skip-throttle";

/**
 * What `@Throttle()` sets for one named throttler, on a controller or a
 * route: each field given overrides the module's value for that throttler
 * there, each field left out keeps it (`@nestjs/throttler` 6's
 * `@Throttle({ default: { limit, ttl } })`). A route's field wins over its
 * controller's.
 *
 * A name the module does not define declares a throttler for these routes
 * alone; it then needs both {@link limit} and {@link ttl} (from the route,
 * its controller, or the two together), or the application refuses to
 * start. `@nestjs/throttler` ignores an unknown name silently.
 */
export interface ThrottleDecoratorOptions {
  /** The most requests per {@link ttl}: a positive integer, or a function of the request's context. */
  readonly limit?: Resolvable<number>;
  /**
   * The window: a duration string (`"1m"`, `"30s"`) or object
   * (`seconds(30)`, `{ minutes: 1 }`), or a function of the request's
   * context answering one. **Never a bare number**: `ttl: 60_000` is a type
   * error and a startup error.
   */
  readonly ttl?: Resolvable<Duration>;
  /** Allows a {@link ttl} under one second (usually a unit mistake). Default the module throttler's, else `false`. */
  readonly allowSubSecond?: boolean;
  /** Who a request counts against under this throttler here; see `BunThrottlerOptions.getTracker`. */
  readonly getTracker?: BunThrottlerGetTracker;
  /** The counter key under this throttler here; see `BunThrottlerOptions.generateKey`. */
  readonly generateKey?: BunThrottlerGenerateKey;
  /**
   * Not supported: `@nestjs/throttler`'s block after a refusal has no
   * equivalent yet (a refused client is refused only until its count falls
   * back under the limit). A type error, and refused at startup.
   */
  readonly blockDuration?: never;
}

/** The `reflect-metadata` calls this module uses, read structurally: they exist once Nest is loaded. */
interface MetadataReflect {
  getOwnMetadata?: (key: unknown, target: object) => unknown;
  getMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
}

const reflect = Reflect as unknown as MetadataReflect;

/** The `reflect-metadata` define call, or a clear error when it is missing. */
function define(key: string, value: unknown, target: object, who: string) {
  if (reflect.defineMetadata === undefined) {
    throw new TypeError(
      `${who}: reflect-metadata is not loaded — import "reflect-metadata" (Nest applications always do) before the controllers`,
    );
  }
  reflect.defineMetadata(key, value, target);
}

/** The target a decorator writes to: the method itself, or the class. */
function targetOf(
  target: object,
  descriptor: PropertyDescriptor | undefined,
): object {
  return (descriptor?.value as object | undefined) ?? target;
}

/**
 * Sets one or more named throttlers' limit and window on a controller (every
 * route in it) or a route, as `@nestjs/throttler` 6's `@Throttle()`: each
 * field given overrides the module's throttler of that name there.
 *
 * ```ts
 * @Throttle({ default: { limit: 5, ttl: "1m" } })
 * @Post("codes/verify")
 * verify() {}
 * ```
 *
 * A name the module does not define declares a throttler for these routes
 * only (see {@link ThrottleDecoratorOptions}); two names give a route two
 * limits, each with its own tracker if need be:
 *
 * ```ts
 * @Throttle({
 *   account: { limit: 10, ttl: "1m", getTracker: (req) => `${req.ip}|${req.body?.email}` },
 *   address: { limit: 30, ttl: "1m" },
 * })
 * @Post("sign-in")
 * signIn() {}
 * ```
 *
 * Applied twice to one target, the records merge by name and field, the
 * later call winning.
 */
export function Throttle(
  options: Readonly<Record<string, ThrottleDecoratorOptions>>,
): MethodDecorator & ClassDecorator {
  if (options === null || typeof options !== "object") {
    throw new TypeError(
      '@Throttle(): pass a record of throttler names, such as { default: { limit: 5, ttl: "1m" } }',
    );
  }
  return ((target: object, _key?: unknown, descriptor?: PropertyDescriptor) => {
    const on = targetOf(target, descriptor);
    const own = (reflect.getOwnMetadata?.(THROTTLE_METADATA, on) ??
      {}) as Record<string, ThrottleDecoratorOptions>;
    const merged: Record<string, ThrottleDecoratorOptions> = { ...own };
    for (const [name, spec] of Object.entries(options)) {
      merged[name] = { ...own[name], ...spec };
    }
    define(THROTTLE_METADATA, merged, on, "@Throttle()");
    return descriptor ?? target;
  }) as MethodDecorator & ClassDecorator;
}

/**
 * Turns named throttlers off (`true`) or back on (`false`) for a controller
 * or a route, as `@nestjs/throttler` 6's `@SkipThrottle()`. With no argument
 * it skips the throttler named `default` only — not every throttler — as
 * there. A route's flag wins over its controller's, so
 * `@SkipThrottle({ default: false })` on a route re-enables what its
 * controller's `@SkipThrottle()` turned off.
 *
 * ```ts
 * @SkipThrottle()
 * @Controller("health")
 * class HealthController {}
 * ```
 */
export function SkipThrottle(
  skip: Readonly<Record<string, boolean>> = { default: true },
): MethodDecorator & ClassDecorator {
  if (skip === null || typeof skip !== "object") {
    throw new TypeError(
      "@SkipThrottle(): pass a record of throttler names, such as { default: true }",
    );
  }
  return ((target: object, _key?: unknown, descriptor?: PropertyDescriptor) => {
    const on = targetOf(target, descriptor);
    const own = (reflect.getOwnMetadata?.(SKIP_THROTTLE_METADATA, on) ??
      {}) as Record<string, boolean>;
    define(SKIP_THROTTLE_METADATA, { ...own, ...skip }, on, "@SkipThrottle()");
    return descriptor ?? target;
  }) as MethodDecorator & ClassDecorator;
}

/** What `@Throttle()` set on `target` (a method or a class), inherited metadata included. */
export function throttleMetadataOf(
  target: object,
): Readonly<Record<string, ThrottleDecoratorOptions>> {
  return (reflect.getMetadata?.(THROTTLE_METADATA, target) ?? {}) as Readonly<
    Record<string, ThrottleDecoratorOptions>
  >;
}

/** What `@SkipThrottle()` set on `target` (a method or a class), inherited metadata included. */
export function skipThrottleMetadataOf(
  target: object,
): Readonly<Record<string, boolean>> {
  return (reflect.getMetadata?.(SKIP_THROTTLE_METADATA, target) ??
    {}) as Readonly<Record<string, boolean>>;
}
