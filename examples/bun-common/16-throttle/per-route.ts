/**
 * Per-route throttling — overrides, `skipThrottle()`, several named limits.
 *
 * ```bash
 * bun 16-throttle/per-route.ts
 * ```
 *
 * Under a router-wide throttle (the `throttle` option), a route adjusts what
 * it inherits by **name**:
 *
 * - a `throttle()` among its callbacks with a limit of the same name
 *   (`default`) *replaces* that limit for the route;
 * - a limit with another name *adds* to the outer ones;
 * - `skipThrottle()` turns every outer limit off there, `skipThrottle("burst")`
 *   only that one.
 *
 * Several named limits count at once; a request is refused when any is over,
 * and the headers list one item per limit. `scope: "route"` counts each route
 * on its own, `"global"` one budget across the routes.
 */
import type { BunRequest, RouterHandler } from "@kingsleyweb/bun-common";
import {
  BunRouter,
  memoryThrottleStore,
  skipThrottle,
  throttle,
} from "@kingsleyweb/bun-common";
import { checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Per-route throttling");

const T0 = 60_000 * 29_000_000;
let time = T0;
const now = (): number => time;
const byClient = (req: BunRequest): string => req.get("x-client") ?? "anon";

/** Requests `path` `n` times and answers each status. */
async function statuses(
  router: BunRouter,
  path: string,
  n: number,
  init?: RequestInit,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await router.fetch(path, init)).status);
  return out;
}

/** One store behind both `/a` and `/b`: two throttles share a count only through one. */
const sharedStore = memoryThrottleStore({ now });

const router = new BunRouter({
  throttle: {
    limits: {
      default: { limit: 100, window: "1m" },
      burst: { limit: 5, window: "1s" },
    },
    headers: "ietf",
    key: byClient,
    now,
  },
});
const ok: RouterHandler = (_req, res) => {
  res.send("ok");
};

router.get("/health", skipThrottle(), ok);
router.get("/report", skipThrottle("burst"), ok);
router.post(
  "/verify",
  throttle({ limit: 2, window: "1m", headers: "ietf", key: byClient, now }),
  ok,
);
router.post(
  "/login",
  throttle({
    limits: {
      // One account, tried from one address.
      account: {
        limit: 2,
        window: "1m",
        key: (req) => `${byClient(req)}|${req.get("x-account") ?? ""}`,
      },
      // Any account, from one address.
      address: { limit: 3, window: "1m", key: byClient },
    },
    headers: "ietf",
    now,
  }),
  ok,
);
router.get(
  "/a",
  throttle({
    limit: 1,
    window: "1m",
    key: byClient,
    now,
    scope: "global",
    store: sharedStore,
    prefix: "shared",
  }),
  ok,
);
router.get(
  "/b",
  throttle({
    limit: 1,
    window: "1m",
    key: byClient,
    now,
    scope: "global",
    store: sharedStore,
    prefix: "shared",
  }),
  ok,
);
router.get("/", ok);

step("skipThrottle(): a health route is never counted");
const health = await router.fetch("/health");
checkEqual("no headers", health.headers.get("RateLimit"), null);
checkEqual(
  "burst of 20",
  (await statuses(router, "/health", 20)).every((s) => s === 200),
  true,
);

step("skipThrottle('burst'): only the named limit is off");
checkEqual(
  "policy lists default alone",
  (await router.fetch("/report")).headers.get("RateLimit-Policy"),
  '"default";q=100;w=60',
);
checkEqual(
  "six in one second",
  (await statuses(router, "/report", 6)).at(-1),
  200,
);

step("the router's own burst limit applies elsewhere");
time += 5_000;
checkEqual(
  "6 on / : the sixth is refused",
  (await statuses(router, "/", 6)).at(-1),
  429,
);
time += 5_000;

step("a same-named limit replaces: /verify allows 2, not 100");
const verify = await router.fetch("/verify", { method: "POST" });
checkEqual(
  "policy: the route's default, plus the outer burst",
  verify.headers.get("RateLimit-Policy"),
  '"burst";q=5;w=1, "default";q=2;w=60',
);
checkEqual(
  "second ok, third refused",
  await statuses(router, "/verify", 2, { method: "POST" }),
  [200, 429],
);

step("other names add: /login has four limits");
time += 60_000;
const login = (account: string): RequestInit => ({
  method: "POST",
  headers: { "x-account": account },
});
checkEqual(
  "policy lists them all",
  (await router.fetch("/login", login("a"))).headers.get("RateLimit-Policy"),
  '"default";q=100;w=60, "burst";q=5;w=1, "account";q=2;w=60, "address";q=3;w=60',
);
checkEqual(
  "account a, second try",
  (await router.fetch("/login", login("a"))).status,
  200,
);
checkEqual(
  "account a, third: the account limit",
  (await router.fetch("/login", login("a"))).status,
  429,
);
checkEqual(
  "account b: the address limit (4th from this client)",
  (await router.fetch("/login", login("b"))).status,
  429,
);
time += 180_000;
checkEqual(
  "three minutes on, account c",
  (await router.fetch("/login", login("c"))).status,
  200,
);

step("scope: 'global' shares one budget across routes");
time += 60_000;
checkEqual("/a", (await router.fetch("/a")).status, 200);
checkEqual("/b spends the same count", (await router.fetch("/b")).status, 429);

summary();
