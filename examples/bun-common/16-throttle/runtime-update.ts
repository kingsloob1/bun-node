/**
 * Changing a throttle while it serves — `update()`, `peek()`, `reset()` and a
 * fallback store.
 *
 * ```bash
 * bun 16-throttle/runtime-update.ts
 * ```
 *
 * `throttle()` returns a handler with a few controls:
 *
 * - `update({ limits })` replaces the limits in force, with no restart. A
 *   limit that keeps its name, window and size carries its count over; a new
 *   name or window starts fresh. A bad update throws and changes nothing.
 * - `peek(req)` answers what counting the request would give (`used` includes
 *   it), consuming nothing.
 * - `reset(key)` forgets one client's counts (the store needs `delete`).
 * - `failMode` may be a second store: while the primary fails, the fallback
 *   counts, so a Redis outage degrades to per-process limits instead of
 *   none (`"open"`) or a 503 (`"closed"`).
 */
import type { BunRequest, ThrottleStore } from "@kingsleyweb/bun-common";
import {
  BunRouter,
  createTestLogger,
  memoryThrottleStore,
  throttle,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Changing a throttle while it serves");

const T0 = 60_000 * 29_000_000;
let time = T0 + 30_000;
const now = (): number => time;
const byClient = (req: BunRequest): string => req.get("x-client") ?? "anon";
const as = (client: string): RequestInit => ({
  headers: { "x-client": client },
});

/** Requests `/x` `n` times as `client` and answers each status. */
async function hits(router: BunRouter, n: number, client = "a") {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push((await router.fetch("/x", as(client))).status);
  }
  return out;
}

step("update(): raise the limit while serving");
const handler = throttle({
  limit: 2,
  window: "1m",
  headers: "ietf",
  key: byClient,
  now,
});
const router = new BunRouter({ throttle: handler });
router.get("/x", (_req, res) => res.send("ok"));
checkEqual("limit 2", await hits(router, 3), [200, 200, 429]);
handler.update({ limit: 5, window: "1m" });
checkEqual(
  "policies now",
  handler.policies.map((p) => p.limit),
  [5],
);
checkEqual(
  "the count carried over: 3 spent, two more fit",
  await hits(router, 3),
  [200, 200, 429],
);

step("update(): a new name starts fresh");
handler.update({ limits: { burst: { limit: 1, window: "10s" } } });
const policy = (await router.fetch("/x", as("b"))).headers.get(
  "RateLimit-Policy",
);
checkEqual("only burst is in force", policy, '"burst";q=1;w=10');
checkEqual(
  "second request refused",
  (await router.fetch("/x", as("b"))).status,
  429,
);

step("update(): a bad update changes nothing");
await checkRejects("limit 0", () => handler.update({ limit: 0 }), {
  name: "ConfigError",
});
checkEqual(
  "still burst",
  handler.policies.map((p) => p.name),
  ["burst"],
);

step("reset(): forget one client");
checkEqual(
  "a spends its one burst, then is refused",
  await hits(router, 2),
  [200, 429],
);
await handler.reset("a");
checkEqual(
  "a is served again",
  (await router.fetch("/x", as("a"))).status,
  200,
);
checkEqual(
  "b is still refused",
  (await router.fetch("/x", as("b"))).status,
  429,
);
await checkRejects(
  "a store without delete()",
  () =>
    throttle({
      limit: 1,
      window: "1m",
      store: { name: "plain", increment: () => 1, get: () => 0 },
    }).reset("a"),
  { message: /delete/ },
);

step("peek(): look without counting");
const peeker = throttle({ limit: 2, window: "1m", key: byClient, now });
let peeked: unknown;
const peekRouter = new BunRouter({ throttle: peeker });
peekRouter.get("/x", async (req, res) => {
  peeked = await peeker.peek(req);
  res.send("ok");
});
await peekRouter.fetch("/x", as("p"));
show("peek during the first request", peeked);
checkEqual(
  "peek counts the request it is asked about once, not twice",
  (peeked as { used: number }[])[0].used,
  2,
);
await peekRouter.fetch("/x", as("p"));
check(
  "a third would be refused",
  (peeked as { limited: boolean }[])[0].limited,
);
checkEqual(
  "peeking took nothing: the counts are what two requests made",
  (await peekRouter.fetch("/x", as("p"))).status,
  429,
);

step("failMode: a fallback store while the primary is down");
const primary = memoryThrottleStore({ now });
let down = true;
const flaky: ThrottleStore = {
  name: "flaky",
  increment: (key, cost, ttl) => {
    if (down) throw new Error("down");
    return primary.increment(key, cost, ttl);
  },
  get: (key) => primary.get(key),
};
const { logger, events } = createTestLogger();
const failing = new BunRouter({
  throttle: {
    limit: 1,
    window: "1m",
    key: byClient,
    now,
    store: flaky,
    failMode: memoryThrottleStore({ now }),
    logger,
  },
});
failing.get("/x", (_req, res) => res.send("ok"));
checkEqual(
  "limit still enforced while down",
  await hits(failing, 2, "f"),
  [200, 429],
);
check(
  "a warning was logged",
  events.some((event) => event.level === "warn"),
);
down = false;
time += 120_000;
checkEqual("primary back", await hits(failing, 2, "f"), [200, 429]);

summary();
