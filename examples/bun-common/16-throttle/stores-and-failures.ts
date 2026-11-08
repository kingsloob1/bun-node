/**
 * Stores and failures — `memoryThrottleStore`, a custom `ThrottleStore`,
 * `failMode`, `onLimited`, algorithms.
 *
 * ```bash
 * bun 16-throttle/stores-and-failures.ts
 * ```
 *
 * A throttle counts in a `ThrottleStore` (`increment`, `get`, optionally an
 * atomic `consumeGcra`). The default is a per-process memory store capped at
 * `maxKeys` (a client inventing keys cannot grow it past the cap). Any object
 * of that shape is a store — a shared one is how one limit holds across
 * processes.
 *
 * When the store throws, `failMode: "open"` (the default) serves the request
 * unthrottled and warns at most every 10 s; `"closed"` sends a
 * `ThrottleStoreError` (503) to the error handlers.
 */
import type {
  RouterErrorMiddlewareHandler,
  RouterHandler,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  createTestLogger,
  memoryThrottleStore,
  ThrottleStoreError,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Stores and failures");

const T0 = 60_000 * 29_000_000;
let time = T0;
const now = (): number => time;
const ok: RouterHandler = (_req, res) => {
  res.send("ok");
};

step("memoryThrottleStore: bounded by maxKeys");
const memory = memoryThrottleStore({ maxKeys: 50, now });
for (let i = 0; i < 1000; i++) memory.increment(`k-${i}`, 1, 60_000);
checkEqual("size stays at the cap", memory.size, 50);
checkEqual("newest key kept", memory.get("k-999"), 1);
checkEqual("oldest key gone", memory.get("k-0"), undefined);
await checkRejects("maxKeys 0", () => memoryThrottleStore({ maxKeys: 0 }), {
  name: "ConfigError",
});

step("a custom store is shared by two routers");
const store = memoryThrottleStore({ now });
const make = (): BunRouter => {
  const router = new BunRouter({
    throttle: { limit: 2, window: "1m", store, now, key: () => "client" },
  });
  router.get("/", ok);
  return router;
};
const one = make();
const two = make();
checkEqual("router one", (await one.fetch("/")).status, 200);
checkEqual("router two", (await two.fetch("/")).status, 200);
checkEqual("one count between them", (await one.fetch("/")).status, 429);

step("failMode: a broken store");
/** A store whose backend is down. */
const broken: ThrottleStore = {
  name: "broken",
  increment: async () => await Promise.reject(new Error("down")),
  get: () => undefined,
};

const { logger, events } = createTestLogger();
const open = new BunRouter({
  throttle: { limit: 1, window: "1m", store: broken, logger },
});
open.get("/", ok);
const served = await Promise.all(
  [1, 2, 3].map(async () => await open.fetch("/")),
);
checkEqual(
  "open: all served",
  served.map((r) => r.status),
  [200, 200, 200],
);
checkEqual("open: no headers", served[0].headers.get("RateLimit"), null);
const warnings = events.filter((event) => event.level === "warn");
checkEqual("open: one warning for three failures", warnings.length, 1);

let seen: unknown;
const closed = new BunRouter({
  throttle: { limit: 1, window: "1m", store: broken, failMode: "closed" },
});
closed.get("/", ok);
closed.use(((err, _req, res, _next) => {
  seen = err;
  res.status((err as ThrottleStoreError).status).send("unavailable");
}) satisfies RouterErrorMiddlewareHandler);
checkEqual("closed: 503", (await closed.fetch("/")).status, 503);
check("closed: a ThrottleStoreError", seen instanceof ThrottleStoreError, seen);
checkEqual(
  "closed: names the store",
  (seen as ThrottleStoreError).store,
  "broken",
);

step("onLimited answers in place of the 429");
const custom = new BunRouter({
  throttle: {
    limit: 1,
    window: "1m",
    now,
    key: () => "c",
    onLimited: (_req, res, _next, info) => {
      res.status(429).json({ slowDown: true, waitMs: info.retryAfter > 0 });
    },
  },
});
custom.get("/", ok);
await custom.fetch("/");
const limited = await custom.fetch("/");
checkEqual("status", limited.status, 429);
checkEqual("body", await limited.json(), { slowDown: true, waitMs: true });
check(
  "Retry-After is already set",
  limited.headers.get("Retry-After") !== null,
);

step("algorithms");
for (const algorithm of ["sliding-window", "fixed-window", "gcra"] as const) {
  time = T0;
  const router = new BunRouter({
    throttle: { limit: 2, window: "1m", algorithm, now, key: () => "c" },
  });
  router.get("/", ok);
  const out = [];
  for (let i = 0; i < 3; i++) out.push((await router.fetch("/")).status);
  checkEqual(`${algorithm}: 2 allowed, the 3rd refused`, out, [200, 200, 429]);
}
time = T0;
const gcra = new BunRouter({
  throttle: {
    limit: 2,
    window: "10s",
    algorithm: "gcra",
    now,
    key: () => "c",
  },
});
gcra.get("/", ok);
await gcra.fetch("/");
await gcra.fetch("/");
time += 5_000;
checkEqual(
  "gcra: one token back after window/limit",
  (await gcra.fetch("/")).status,
  200,
);
checkEqual("gcra: and no more", (await gcra.fetch("/")).status, 429);

summary();
