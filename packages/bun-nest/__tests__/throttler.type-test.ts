/**
 * Compile-time checks for the throttling API: `BunThrottlerModule.forRoot()`'s
 * and `forRootAsync()`'s options, `@Throttle()` and `@SkipThrottle()`, the
 * duration helpers and the adapter's `throttle` option. Above all, `ttl`
 * takes a duration (`"1m"`, `seconds(60)`, `{ minutes: 1 }`), never a bare
 * number (a `THROTTLE_TTL=60` read as 60 ms). Checked by `bun run check`
 * (`bun test`, even with `--check`, never reads a `*.type-test.ts`); each
 * `@ts-expect-error` is a negative control — an unused one is an error.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { ExecutionContext } from "@nestjs/common";
import type {
  BunThrottlerLimitDetail,
  BunThrottlerModuleOptions,
  BunThrottlerOptions,
} from "../lib/index";
import { memoryThrottleStore } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunThrottlerGuard,
  BunThrottlerModule,
  BunThrottlerService,
  minutes,
  seconds,
  SkipThrottle,
  Throttle,
  ThrottlerException,
} from "../lib/index";

/** `true` when `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// ---- module options ----------------------------------------------------

export const ok: BunThrottlerModuleOptions = {
  throttlers: [
    { limit: 600, ttl: "1m" },
    { name: "strict", limit: 5, ttl: seconds(60), skipIf: () => false },
    {
      name: "fn",
      limit: (ctx) => (ctx.getType() === "http" ? 1 : 2),
      ttl: async () => minutes(1),
    },
    { name: "obj", limit: 1, ttl: { minutes: 1, seconds: 30 } },
    { name: "sub", limit: 1, ttl: "500ms", allowSubSecond: true },
  ],
  store: memoryThrottleStore(),
  headers: "legacy",
  algorithm: "fixed-window",
  failMode: "closed",
  logLimited: "warn",
  getTracker: (req: BunRequest) => req.ip ?? "none",
  errorMessage: (_ctx: ExecutionContext, detail: BunThrottlerLimitDetail) =>
    `${detail.name} ${detail.limit}`,
  guardCheck: "throw",
  ipv6SubnetPrefix: 64,
};

// A bare number is refused: is 60 a minute or 60 ms?
// @ts-expect-error ttl takes a duration, never a bare number
export const bareTtl: BunThrottlerOptions = { limit: 1, ttl: 60_000 };
// @ts-expect-error a function answering a bare number is refused too
export const bareTtlFn: BunThrottlerOptions = { limit: 1, ttl: () => 60 };
// @ts-expect-error ttl is required
export const noTtl: BunThrottlerOptions = { limit: 1 };
export const block: BunThrottlerOptions = {
  limit: 1,
  ttl: "1m",
  // @ts-expect-error blockDuration is not supported
  blockDuration: 1,
};
// @ts-expect-error a limit is a number
export const stringLimit: BunThrottlerOptions = { limit: "5", ttl: "1m" };
export const setHeaders: BunThrottlerModuleOptions = {
  throttlers: [],
  // @ts-expect-error headers are spelled `headers`, not @nestjs/throttler's setHeaders
  setHeaders: true,
};
export const badCheck: BunThrottlerModuleOptions = {
  throttlers: [],
  // @ts-expect-error guardCheck takes "error", "throw" or false
  guardCheck: true,
};

export const forRoot = BunThrottlerModule.forRoot([{ limit: 1, ttl: "1m" }]);
export const forRootAsync = BunThrottlerModule.forRootAsync({
  inject: ["CONFIG"],
  useFactory: (config: { limit: number }) => ({
    throttlers: [{ limit: config.limit, ttl: "1m" }],
  }),
  globalGuard: true,
});

// ---- helpers -----------------------------------------------------------

export const _seconds: Equal<
  ReturnType<typeof seconds>,
  { readonly seconds: number }
> = true;
// @ts-expect-error the helpers answer a duration object, not milliseconds
export const _notNumber: number = seconds(60);

// ---- decorators --------------------------------------------------------

@Throttle({ default: { limit: 10 } })
@SkipThrottle({ burst: true })
export class Controllerish {
  @Throttle({
    default: { ttl: "5m" },
    account: { limit: 10, ttl: minutes(1), getTracker: (req) => `${req.ip}|x` },
  })
  @SkipThrottle()
  method() {}

  @SkipThrottle({ default: false })
  other() {}
}

// @ts-expect-error a decorator's ttl is a duration too
Throttle({ default: { ttl: 1000 } });
// @ts-expect-error @Throttle takes a record of throttler names
Throttle({ limit: 1, ttl: "1m" });
// @ts-expect-error @SkipThrottle's flags are booleans
SkipThrottle({ default: "yes" });

// ---- guard, service, exception ----------------------------------------

export class ByUser extends BunThrottlerGuard {
  protected override async getTracker(req: BunRequest): Promise<string> {
    return String(req.headers["x-user"] ?? "anon");
  }
}
export const _guard = new BunThrottlerGuard({
  throttlers: [{ limit: 1, ttl: "1m" }],
});
declare const service: BunThrottlerService;
service.update("default", { limit: 5, ttl: "2m" });
// @ts-expect-error update's ttl is a duration too
service.update("default", { ttl: 120_000 });
export const _status: number = new ThrottlerException().getStatus();

// ---- the adapter option ------------------------------------------------

export const _adapter = new BunHttpAdapter(0, {
  throttle: { limit: 600, window: "1m" },
});
export const _badAdapter = new BunHttpAdapter(0, {
  // @ts-expect-error the adapter's throttle option takes bun-common's options, whose window is a duration
  throttle: { limit: 1, window: 60_000 },
});
