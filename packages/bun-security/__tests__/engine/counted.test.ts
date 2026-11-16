/**
 * Counted rules (layers.md §0.2, D23): "N occurrences of an event within W
 * for one key → an action for B", counted in the throttle store, cleared on
 * a trip, enforced on the key's later requests until B ends. The events:
 * `request`, `throttled`, `route.notFound` and `server.error` (from
 * `complete()`, layer L14), and the app's own through `signal()`.
 *
 * T-L2-4: a sibling service's proxy flow trips a counted rule; the end user
 * it forwards is counted and banned, the service never is, and with no
 * forwarded address nobody is counted. A property test checks the counters
 * and trips against a reference model on random arrival timelines.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { memoryThrottleStore } from "@kingsleyweb/bun-common";
import type { ThrottleStore } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type {
  CountedRule,
  Decision,
  RequestFacts,
  RuleHit,
  SecurityPolicy,
} from "../../lib/index";
import { facts, fakeClock, seededRandom } from "../helpers";
import type { FakeClock } from "../helpers";

/** An engine on a fake clock, quiet. */
function engine(
  policy: SecurityPolicy,
  clock: FakeClock = fakeClock(),
  store?: ThrottleStore,
) {
  return createSecurity({
    policy,
    now: clock.now,
    logger: () => {},
    ...(store ? { throttleStore: store } : {}),
  });
}
type Engine = ReturnType<typeof engine>;

/** `evaluate()`, required to be synchronous. */
function decide(
  security: Engine,
  request: RequestFacts,
  track = false,
): Decision {
  const decision = security.evaluate(request, { track });
  if (decision instanceof Promise)
    throw new Error("expected a synchronous decision");
  return decision;
}

/** `signal()`, required to be synchronous. */
function signal(
  security: Engine,
  request: RequestFacts,
  event: string,
): readonly RuleHit[] {
  const hits = security.signal(request, event);
  if (hits instanceof Promise) throw new Error("expected synchronous hits");
  return hits;
}

/** `complete()`, required to be synchronous. */
function complete(
  security: Engine,
  request: RequestFacts,
  decision: Decision,
  status: number,
  routeNotFound?: boolean,
): readonly RuleHit[] {
  const hits = security.complete(request, decision, {
    status,
    ...(routeNotFound === undefined ? {} : { routeNotFound }),
  });
  if (hits instanceof Promise) throw new Error("expected synchronous hits");
  return hits;
}

const FAILED_PASSWORD: CountedRule = {
  id: "failed-password",
  event: "auth.failure",
  threshold: 3,
  window: "15m",
  duration: "1h",
};

describe("a counted rule", () => {
  it("trips at the threshold, refuses the key until the duration ends, then lets it through", () => {
    const clock = fakeClock();
    const security = engine({ countedRules: [FAILED_PASSWORD] }, clock);
    const client = facts({ client: "203.0.113.20" });
    expect(signal(security, client, "auth.failure")).toEqual([]);
    expect(signal(security, client, "auth.failure")).toEqual([]);
    expect(signal(security, client, "auth.failure")).toEqual([
      {
        layer: "L4",
        rule: "counted:failed-password",
        action: "ban",
        reason: 'counted rule: 3 "auth.failure" in 15m',
      },
    ]);
    const refused = decide(security, client);
    expect(refused).toMatchObject({
      action: "ban",
      status: 403,
      code: "blocked",
      retryAfter: 3600,
    });
    expect(refused.hits[0]?.reason).toBe(
      'tripped by counted rule "failed-password", 3600 s left',
    );
    // Another address is untouched.
    expect(decide(security, facts({ client: "203.0.113.21" })).action).toBe(
      "allow",
    );
    clock.advance(30 * 60_000);
    expect(decide(security, client).retryAfter).toBe(1800);
    clock.advance(30 * 60_000);
    expect(decide(security, client).action).toBe("allow");
    expect(security.status().state.trips).toBe(0);
  });

  it("clears its count on a trip: one burst gives one trip, and the next needs a full threshold again", () => {
    const clock = fakeClock();
    const security = engine(
      { countedRules: [{ ...FAILED_PASSWORD, duration: "1s" }] },
      clock,
    );
    const client = facts();
    const trips = () =>
      Array.from(
        { length: 6 },
        () => signal(security, client, "auth.failure").length,
      );
    expect(trips()).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it("counts in a fixed window from its first occurrence", () => {
    const clock = fakeClock();
    const security = engine({ countedRules: [FAILED_PASSWORD] }, clock);
    const client = facts();
    signal(security, client, "auth.failure");
    signal(security, client, "auth.failure");
    clock.advance(15 * 60_000);
    expect(signal(security, client, "auth.failure")).toEqual([]);
  });

  it("challenge falls back to block until challenge providers exist", () => {
    const security = engine({
      countedRules: [
        { ...FAILED_PASSWORD, action: "challenge", code: "verify" },
      ],
    });
    for (let i = 0; i < 3; i++) signal(security, facts(), "auth.failure");
    expect(decide(security, facts())).toMatchObject({
      action: "block",
      status: 403,
      code: "verify",
    });
  });

  it("a null duration lasts until the rule is removed or turned off", () => {
    const clock = fakeClock();
    const rule: CountedRule = { ...FAILED_PASSWORD, duration: null };
    const security = engine({ countedRules: [rule] }, clock);
    for (let i = 0; i < 3; i++) signal(security, facts(), "auth.failure");
    clock.advance(365 * 24 * 3_600_000);
    const refused = decide(security, facts());
    expect(refused.action).toBe("ban");
    expect(refused.retryAfter).toBeUndefined();
    // Reloading the same rule keeps the trip; turning it off ends it.
    security.load({ countedRules: [rule] });
    expect(decide(security, facts()).action).toBe("ban");
    security.load({ countedRules: [{ ...rule, mode: "off" }] });
    expect(decide(security, facts()).action).toBe("allow");
    expect(security.status().state.trips).toBe(0);
  });

  it("in dry run counts and records the would-be ban, refusing nobody", () => {
    const security = engine({
      countedRules: [{ ...FAILED_PASSWORD, mode: "dryRun" }],
    });
    for (let i = 0; i < 2; i++) signal(security, facts(), "auth.failure");
    expect(signal(security, facts(), "auth.failure")).toEqual([
      {
        layer: "L4",
        rule: "counted:failed-password",
        action: "log",
        wouldHaveBeen: "ban",
        reason: 'dry run: counted rule: 3 "auth.failure" in 15m',
      },
    ]);
    expect(decide(security, facts()).action).toBe("allow");
    expect(security.status().state.trips).toBe(0);
    // A dryRun policy does the same to an enforced rule.
    const dryPolicy = engine({
      mode: "dryRun",
      countedRules: [FAILED_PASSWORD],
    });
    for (let i = 0; i < 3; i++) signal(dryPolicy, facts(), "auth.failure");
    expect(decide(dryPolicy, facts()).action).toBe("allow");
  });

  it("keys on its key: a user across addresses; a composite ip|user", () => {
    const security = engine({
      countedRules: [
        { ...FAILED_PASSWORD, id: "per-user", key: "user" },
        {
          ...FAILED_PASSWORD,
          id: "per-ip-user",
          key: ["ip", "user"],
          threshold: 2,
        },
      ],
    });
    const as = (client: string, user?: string) =>
      facts({ client, ...(user ? { identity: { user } } : {}) });
    expect(signal(security, as("192.0.2.1", "bob"), "auth.failure")).toEqual(
      [],
    );
    expect(
      signal(security, as("192.0.2.1", "bob"), "auth.failure").map(
        (hit) => hit.rule,
      ),
    ).toEqual(["counted:per-ip-user"]);
    // bob from another address: banned for per-ip-user only at the first address.
    expect(decide(security, as("192.0.2.9", "bob")).action).toBe("allow");
    expect(decide(security, as("192.0.2.1", "bob")).action).toBe("ban");
    expect(decide(security, as("192.0.2.1", "carol")).action).toBe("allow");
    expect(
      signal(security, as("192.0.2.9", "bob"), "auth.failure").map(
        (hit) => hit.rule,
      ),
    ).toEqual(["counted:per-user"]);
    expect(decide(security, as("192.0.2.200", "bob")).action).toBe("ban");
    // A request without the key's parts is not counted.
    expect(signal(security, as("192.0.2.50"), "auth.failure")).toEqual([]);
  });

  it("counts only on its routes", () => {
    const security = engine({
      countedRules: [
        { ...FAILED_PASSWORD, routes: ["POST /login"], threshold: 1 },
      ],
    });
    expect(
      signal(
        security,
        facts({ method: "POST", path: "/other" }),
        "auth.failure",
      ),
    ).toEqual([]);
    expect(
      signal(
        security,
        facts({ method: "POST", path: "/login" }),
        "auth.failure",
      ),
    ).toHaveLength(1);
  });

  it("signal() refuses a name outside the event grammar", () => {
    const security = engine({});
    for (const name of ["", "auth failure", "1st", "x".repeat(65)]) {
      expect(() => security.signal(facts(), name)).toThrow(TypeError);
    }
  });
});

describe("the engine's events", () => {
  it("request: ConcaveHR's requests_per_second (here 5 in 1 s → 15 min)", () => {
    const clock = fakeClock();
    const security = engine(
      {
        countedRules: [
          {
            id: "rps",
            event: "request",
            threshold: 5,
            window: "1s",
            duration: "15m",
          },
        ],
      },
      clock,
    );
    const answers = Array.from(
      { length: 7 },
      () => decide(security, facts()).action,
    );
    // The fifth request trips the rule and is refused with the ban.
    expect(answers).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "ban",
      "ban",
      "ban",
    ]);
    // Spread out, the same five never trip.
    const calm = engine(
      {
        countedRules: [
          {
            id: "rps",
            event: "request",
            threshold: 5,
            window: "1s",
            duration: "15m",
          },
        ],
      },
      clock,
    );
    const spread = Array.from({ length: 10 }, () => {
      clock.advance(300);
      return decide(calm, facts({ client: "198.51.100.3" })).action;
    });
    expect(spread.every((action) => action === "allow")).toBe(true);
  });

  it("throttled: repeated 429s turn into a ban, while a 429 alone never bans (weight 0 by default)", () => {
    const security = engine({
      limits: [
        { id: "tight", limit: 1, window: "1m", algorithm: "fixed-window" },
      ],
      countedRules: [
        {
          id: "repeat-429",
          event: "throttled",
          threshold: 3,
          window: "5m",
          duration: "1h",
        },
      ],
    });
    const actions = Array.from({ length: 5 }, () => decide(security, facts()));
    expect(actions.map((d) => d.action)).toEqual([
      "allow",
      "block",
      "block",
      "ban",
      "ban",
    ]);
    expect(actions[3]?.hits.map((hit) => hit.rule)).toEqual([
      "limit:tight",
      "counted:repeat-429",
    ]);
    expect(actions[3]).toMatchObject({ status: 403, retryAfter: 3600 });
    // The ban is enforced at L4, before the limit counts.
    expect(actions[4]?.hits.map((hit) => hit.rule)).toEqual([
      "counted:repeat-429",
    ]);
    // Without a counted rule on `throttled`, 429s stay 429s.
    const plain = engine({
      limits: [
        { id: "tight", limit: 1, window: "1m", algorithm: "fixed-window" },
      ],
    });
    expect(
      Array.from({ length: 6 }, () => decide(plain, facts()).action).slice(1),
    ).toEqual(["block", "block", "block", "block", "block"]);
  });

  it("route.notFound and server.error come from complete(), once per decision", () => {
    const security = engine({
      countedRules: [
        {
          id: "not-found",
          event: "route.notFound",
          threshold: 2,
          window: "1m",
          duration: "1d",
        },
        {
          id: "crashes",
          event: "server.error",
          threshold: 2,
          window: "1m",
          duration: "1h",
          key: ["ip", "route"],
        },
      ],
    });
    const probe = facts({ path: "/.env", rawPath: "/.env" });
    const first = decide(security, probe);
    expect(complete(security, probe, first, 404, true)).toEqual([]);
    // A second complete() for the same decision counts nothing.
    expect(complete(security, probe, first, 404, true)).toEqual([]);
    // An app's own 404 (no routeNotFound) is not counted.
    expect(complete(security, probe, decide(security, probe), 404)).toEqual([]);
    expect(
      complete(security, probe, decide(security, probe), 404, true).map(
        (hit) => hit.rule,
      ),
    ).toEqual(["counted:not-found"]);
    expect(decide(security, probe).action).toBe("ban");
    // Crashes are keyed on the address and route.
    const crash = facts({
      client: "198.51.100.9",
      method: "POST",
      path: "/upload",
    });
    expect(complete(security, crash, decide(security, crash), 500)).toEqual([]);
    expect(
      complete(security, crash, decide(security, crash), 503),
    ).toHaveLength(1);
    expect(decide(security, crash).action).toBe("ban");
    expect(decide(security, { ...crash, path: "/elsewhere" }).action).toBe(
      "allow",
    );
  });

  it("complete() counts nothing for a refused decision or one evaluate() did not make", () => {
    const security = engine({
      lists: [{ ip: "203.0.113.0/24", action: "block" }],
      countedRules: [
        {
          id: "nf",
          event: "route.notFound",
          threshold: 1,
          window: "1m",
          duration: "1h",
        },
      ],
    });
    const blocked = facts();
    expect(
      complete(security, blocked, decide(security, blocked), 404, true),
    ).toEqual([]);
    const other = facts({ client: "198.51.100.1" });
    const explained = security.explain(other);
    if (explained instanceof Promise) throw new Error("expected synchronous");
    expect(complete(security, other, explained.decision, 404, true)).toEqual(
      [],
    );
    expect(decide(security, other).action).toBe("allow");
  });
});

describe("who counted rules count", () => {
  const TOKEN = "pay-api-token";
  const verifier = `sha256:${createHash("sha256").update(TOKEN).digest("hex")}`;
  /** ConcaveHR's pay-api: a sign-in proxy forwarding its end users. */
  const policy = (appliesToServices: boolean): SecurityPolicy => ({
    serviceIdentity: {
      services: [{ id: "pay-api", verifier, forwardsClientIp: true }],
    },
    countedRules: [
      {
        id: "disposable-signup",
        event: "pattern.hit",
        threshold: 2,
        window: "1m",
        duration: "7d",
        appliesToServices,
      },
    ],
  });
  const viaPayApi = (endUser?: string) =>
    facts({
      client: "10.4.0.2",
      headers: {
        "x-service-token": TOKEN,
        ...(endUser ? { "x-service-client-ip": endUser } : {}),
      },
    });

  it("T-L2-4: the end user the service forwards is counted and banned, the service never is", () => {
    const security = engine(policy(true));
    expect(signal(security, viaPayApi("203.0.113.66"), "pattern.hit")).toEqual(
      [],
    );
    expect(
      signal(security, viaPayApi("203.0.113.66"), "pattern.hit").map(
        (hit) => hit.rule,
      ),
    ).toEqual(["counted:disposable-signup"]);
    // The end user is banned, directly and through the proxy.
    expect(decide(security, facts({ client: "203.0.113.66" })).action).toBe(
      "ban",
    );
    expect(decide(security, viaPayApi("203.0.113.66")).action).toBe("ban");
    // The service keeps working for everyone else, and is never refused itself.
    expect(decide(security, viaPayApi("203.0.113.67")).action).toBe("allow");
    expect(decide(security, viaPayApi()).action).toBe("allow");
    expect(decide(security, facts({ client: "10.4.0.2" })).action).toBe(
      "allow",
    );
  });

  it("T-L2-4: a service call forwarding no address counts against nobody", () => {
    const security = engine(policy(true));
    for (let i = 0; i < 10; i++) {
      expect(signal(security, viaPayApi(), "pattern.hit")).toEqual([]);
    }
    expect(security.status().state.trips).toBe(0);
    expect(decide(security, viaPayApi()).action).toBe("allow");
  });

  it("negative control: without appliesToServices the default exemptions skip the forwarded end user", () => {
    const security = engine(policy(false));
    for (let i = 0; i < 4; i++) {
      expect(
        signal(security, viaPayApi("203.0.113.66"), "pattern.hit"),
      ).toEqual([]);
    }
    expect(decide(security, facts({ client: "203.0.113.66" })).action).toBe(
      "allow",
    );
  });

  it("an internal client is never counted by an address-only key, but is by an identity key", () => {
    const security = engine({
      countedRules: [
        { ...FAILED_PASSWORD, id: "by-ip", threshold: 1 },
        { ...FAILED_PASSWORD, id: "by-user", threshold: 1, key: "user" },
      ],
    });
    const internal = facts({ client: "10.0.0.5", identity: { user: "eve" } });
    expect(
      signal(security, internal, "auth.failure").map((hit) => hit.rule),
    ).toEqual(["counted:by-user"]);
    expect(decide(security, facts({ client: "10.0.0.5" })).action).toBe(
      "allow",
    );
    expect(decide(security, internal).action).toBe("ban");
  });

  it("an allow entry is never counted or refused", () => {
    const security = engine({
      lists: [{ ip: "198.51.100.0/24", action: "allow" }],
      countedRules: [{ ...FAILED_PASSWORD, threshold: 1, key: ["ip", "user"] }],
    });
    const allowed = facts({ client: "198.51.100.4", identity: { user: "x" } });
    expect(signal(security, allowed, "auth.failure")).toEqual([]);
    expect(decide(security, allowed).action).toBe("allow");
  });
});

describe("stores", () => {
  it("counts in the throttle store, and works over an asynchronous one", async () => {
    const inner = memoryThrottleStore();
    const keys: string[] = [];
    const store: ThrottleStore = {
      name: "async",
      increment: async (key, cost, ttl) => {
        keys.push(key);
        return inner.increment(key, cost, ttl);
      },
      get: async (key) => inner.get(key),
      delete: async (key) => inner.delete(key),
    };
    const security = engine(
      { service: "checkout", countedRules: [FAILED_PASSWORD] },
      fakeClock(),
      store,
    );
    for (let i = 0; i < 2; i++) {
      expect(await security.signal(facts(), "auth.failure")).toEqual([]);
    }
    expect(await security.signal(facts(), "auth.failure")).toHaveLength(1);
    expect(keys[0]).toBe(
      "bun-security:checkout:counted:failed-password:900000:203.0.113.10",
    );
    // Cleared on the trip.
    expect(inner.get(keys[0] ?? "")).toBeUndefined();
    expect((await security.evaluate(facts())).action).toBe("ban");
  });

  it("takes the count back on a store without delete", () => {
    const inner = memoryThrottleStore();
    const store: ThrottleStore = {
      name: "no-delete",
      increment: (key, cost, ttl) => inner.increment(key, cost, ttl),
      get: (key) => inner.get(key),
    };
    const security = engine(
      { countedRules: [{ ...FAILED_PASSWORD, duration: "1s" }] },
      fakeClock(),
      store,
    );
    const trips = Array.from(
      { length: 6 },
      () => signal(security, facts(), "auth.failure").length,
    );
    expect(trips).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it("a failing store counts nothing (fail open) and logs it at most every 10 s", () => {
    const lines: string[] = [];
    const security = createSecurity({
      policy: { countedRules: [{ ...FAILED_PASSWORD, threshold: 1 }] },
      throttleStore: {
        name: "down",
        increment: () => {
          throw new Error("refused");
        },
        get: () => {
          throw new Error("refused");
        },
      },
      logger: (event) => {
        lines.push(event.message);
      },
    });
    for (let i = 0; i < 3; i++)
      expect(security.signal(facts(), "auth.failure")).toEqual([]);
    expect(lines.filter((line) => line.includes('"down" failed'))).toHaveLength(
      1,
    );
  });
});

describe("property: counters and trips against a reference model", () => {
  /**
   * The reference: per key, a fixed window that starts at the first
   * occurrence and lasts W; at the threshold the count is cleared and the
   * key refused for B. Checked with occurrences (signals) and requests on a
   * random timeline across a few keys.
   */
  it("agrees on random arrival timelines", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = seededRandom(seed);
      const clock = fakeClock();
      const threshold = 1 + Math.floor(random() * 4);
      const windowMs = 1000 * (1 + Math.floor(random() * 30));
      const durationMs = 1000 * (1 + Math.floor(random() * 60));
      const security = engine(
        {
          countedRules: [
            {
              id: "r",
              event: "auth.failure",
              threshold,
              window: { ms: windowMs },
              duration: { ms: durationMs },
            },
          ],
        },
        clock,
      );
      const model = new Map<
        string,
        { count: number; ends: number; banned: number }
      >();
      const clients = [
        "203.0.113.1",
        "203.0.113.2",
        "2001:db8::1",
        "2001:db8::2:1",
      ];
      for (let step = 0; step < 300; step++) {
        clock.advance(Math.floor(random() * 4000));
        const now = clock.now();
        const client =
          clients[Math.floor(random() * clients.length)] ?? "203.0.113.1";
        // Both IPv6 clients share one /64, so one key.
        const key = client.includes(":") ? "2001:db8::/64" : client;
        const state = model.get(key) ?? { count: 0, ends: 0, banned: 0 };
        model.set(key, state);
        const request = facts({ client });
        if (random() < 0.6) {
          if (state.ends <= now) {
            state.count = 0;
            state.ends = now + windowMs;
          }
          state.count++;
          const tripped = state.count >= threshold;
          if (tripped) {
            state.count = 0;
            state.ends = 0;
            state.banned = now + durationMs;
          }
          const hits = signal(security, request, "auth.failure");
          expect({ seed, step, tripped: hits.length > 0 }).toEqual({
            seed,
            step,
            tripped,
          });
        } else {
          const refused = state.banned > now;
          const action = decide(security, request).action;
          expect({ seed, step, refused: action === "ban" }).toEqual({
            seed,
            step,
            refused,
          });
        }
      }
    }
  });
});
