/**
 * Compile-time assertions for `throttle()`, `skipThrottle()`, the router and
 * adapter `throttle` option and `Duration`.
 *
 * - A duration always carries its unit: a string or a `DurationObject`
 *   compiles; a bare number does not (ConcaveHR's ms-versus-seconds bug).
 * - The middleware is a `RouterHandler` the router and adapter accept, in a
 *   `use()`, among a route's callbacks and as the `throttle` option, which
 *   also takes plain options.
 * - `failMode` takes `"open"`, `"closed"` or a store; nothing else.
 * - `onLimited`'s `info` and `getThrottleResults()` are typed.
 *
 * Checked by `bun run check`; runtime behaviour is `throttle.test.ts`.
 */
import type {
  Duration,
  ThrottleHandler,
  ThrottleLimitedInfo,
  ThrottleOptions,
  ThrottleResult,
} from "../lib/index";
import type { RouterHandler } from "../lib/types/general";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import {
  getThrottleResults,
  memoryThrottleStore,
  skipThrottle,
  throttle,
} from "../lib/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assert = <T extends true>(): T => true as T;

/* Durations. */
const minute: Duration = "1m";
const object: Duration = { minutes: 1, seconds: 30 };
// @ts-expect-error a bare number has no unit
const bare: Duration = 60_000;
// @ts-expect-error a DurationObject's fields are numbers
const wrong: Duration = { seconds: "30" };
// @ts-expect-error not a unit
const unknownUnit: Duration = { fortnights: 1 };
void [minute, object, bare, wrong, unknownUnit];

/* throttle(). */
const handler: ThrottleHandler = throttle({ limit: 10, window: "1m" });
const asHandler: RouterHandler = handler;
void asHandler;
throttle({
  limits: {
    account: { limit: 10, window: { minutes: 1 }, key: (req) => req.ip },
    address: { limit: 30, window: "1 minute" },
  },
  cost: (req) => (req.method === "POST" ? 2 : 1),
  skip: (req) => req.get("x-service-token") === "secret",
  failMode: memoryThrottleStore(),
  headers: "ietf",
  logLimited: "info",
  onLimited: (_req, res, _next, info) => {
    assert<Equal<typeof info, ThrottleLimitedInfo>>();
    res.status(429).json({ route: info.route });
  },
});
// @ts-expect-error a bare number has no unit
throttle({ limit: 10, window: 60_000 });
// @ts-expect-error a limit's window too
throttle({ limits: { burst: { limit: 1, window: 1000 } } });
// @ts-expect-error failMode is "open", "closed" or a store
throttle({ limit: 1, failMode: "retry" });
// @ts-expect-error an algorithm this module does not have
throttle({ limit: 1, algorithm: "leaky-bucket" });
// @ts-expect-error a log level or a boolean
throttle({ limit: 1, logLimited: "loud" });
handler.update({ limits: { burst: { limit: 5, window: "1s" } } });
// @ts-expect-error update takes limits, with units
handler.update({ limit: 5, window: 1 });

/* The router and adapters. */
const options: ThrottleOptions = { limit: 600, window: "1m" };
const router = new BunRouter({ throttle: options });
const adapters = [
  new BunRouter({ throttle: handler }),
  new BunHttpAdapter(0, { throttle: { limit: 600, window: "1m" } }),
  new BunHttpAdapter(0, { throttle: handler }),
  // @ts-expect-error the option is options or a throttle(), not a number
  new BunHttpAdapter(0, { throttle: 600 }),
];
void adapters;
router.use(throttle({ limit: 5 }));
router.get("/health", skipThrottle(), (_req, res) => res.send("ok"));
router.post("/login", throttle({ limit: 5 }), (req, res) => {
  const results = getThrottleResults(req);
  assert<Equal<typeof results, readonly ThrottleResult[] | undefined>>();
  res.send(String(results?.length));
});
