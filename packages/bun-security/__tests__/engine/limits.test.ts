/**
 * Layer L9 on the throttle foundation (layers.md L9.1): limits from policy,
 * keys from identity, several limits per route, dry run, run-time updates,
 * the `429` answer, service identities and the allow and internal lists.
 *
 * T-L9-1 is a differential: the same arrivals (a burst, a steady stream,
 * traffic straddling a window edge) through bun-security and through
 * bun-common's `throttle()` used directly on a `BunRouter`, for each
 * algorithm; the foundation's own tests cover the algorithms, this covers
 * bun-security's wiring, keys and run-time updates. For the fixed window
 * an independent model checks both.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  BunRouter,
  ConfigError,
  memoryThrottleStore,
  throttle,
} from "@kingsleyweb/bun-common";
import type {
  BunRequest,
  BunResponse,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type {
  Decision,
  LimitAlgorithm,
  LimitRule,
  RequestFacts,
  SecurityPolicy,
} from "../../lib/index";
import { facts, fakeClock } from "../helpers";
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

/** `evaluate()`, required to be synchronous (the memory store). */
function decide(
  security: ReturnType<typeof engine>,
  request: RequestFacts,
): Decision {
  const decision = security.evaluate(request);
  if (decision instanceof Promise)
    throw new Error("expected a synchronous decision");
  return decision;
}

/** Whether a decision let the request through. */
const admitted = (decision: Decision): boolean => decision.action !== "block";

/** Arrival offsets (ms from a window's start) for the T-L9-1 shapes. */
const SHAPES: Readonly<Record<string, readonly number[]>> = {
  burst: Array.from({ length: 25 }, () => 1_000),
  steady: Array.from({ length: 40 }, (_, i) => 1_000 + i * 2_500),
  boundary: [
    ...Array.from({ length: 12 }, (_, i) => 50_000 + i * 800),
    ...Array.from({ length: 12 }, (_, i) => 60_100 + i * 800),
    ...Array.from({ length: 12 }, (_, i) => 119_000 + i * 50),
  ],
};

/** What bun-common's throttle answers for `arrivals`, used directly on a router. */
async function foundation(
  algorithm: LimitAlgorithm,
  limit: number,
  arrivals: readonly number[],
  start: number,
): Promise<boolean[]> {
  let time = start;
  const router = new BunRouter();
  router.use(
    throttle({
      limit,
      window: "1m",
      algorithm,
      key: () => "k",
      store: memoryThrottleStore({ now: () => time }),
      now: () => time,
    }),
  );
  router.get("/", (_req: BunRequest, res: BunResponse) => {
    res.send("ok");
  });
  const answers: boolean[] = [];
  for (const offset of arrivals) {
    time = start + offset;
    const response = await router.fetch("/");
    answers.push(response.status === 200);
  }
  return answers;
}

/** The fixed window, modelled independently: refused requests count too. */
function fixedModel(
  limit: number,
  arrivals: readonly number[],
  start: number,
): boolean[] {
  const counts = new Map<number, number>();
  return arrivals.map((offset) => {
    const index = Math.floor((start + offset) / 60_000);
    const count = (counts.get(index) ?? 0) + 1;
    counts.set(index, count);
    return count <= limit;
  });
}

describe("T-L9-1: policy-driven limits admit exactly the foundation's count", () => {
  for (const algorithm of ["sliding-window", "fixed-window", "gcra"] as const) {
    for (const [shape, arrivals] of Object.entries(SHAPES)) {
      it(`${algorithm}, ${shape}`, async () => {
        const clock = fakeClock();
        const start = clock.now();
        const security = engine(
          { limits: [{ id: "ten", limit: 10, window: "1m", algorithm }] },
          clock,
        );
        const ours: boolean[] = [];
        let at = 0;
        for (const offset of arrivals) {
          clock.advance(offset - at);
          at = offset;
          ours.push(
            admitted(decide(security, facts({ client: "203.0.113.9" }))),
          );
        }
        const theirs = await foundation(algorithm, 10, arrivals, start);
        expect(ours).toEqual(theirs);
        expect(ours.filter(Boolean).length).toBeGreaterThan(0);
        expect(ours.some((ok) => !ok)).toBe(true);
        if (algorithm === "fixed-window") {
          expect(ours).toEqual(fixedModel(10, arrivals, start));
        }
      });
    }
  }

  it("keys each client apart (one /64 is one key), and each named limit apart", () => {
    const security = engine({
      limits: [
        { id: "a", limit: 2, window: "1m", algorithm: "fixed-window" },
        {
          id: "b",
          limit: 3,
          window: "1m",
          algorithm: "fixed-window",
          key: "user",
        },
      ],
    });
    const sequence = (client: string, user?: string) =>
      Array.from({ length: 4 }, () =>
        admitted(
          decide(
            security,
            facts({ client, ...(user ? { identity: { user } } : {}) }),
          ),
        ),
      );
    expect(sequence("203.0.113.1")).toEqual([true, true, false, false]);
    expect(sequence("203.0.113.2")).toEqual([true, true, false, false]);
    // T-L2-3: rotating inside one /64 is one key.
    expect([
      ...sequence("2001:db8:1:2::1").slice(0, 1),
      ...sequence("2001:db8:1:2:ffff::9").slice(0, 2),
    ]).toEqual([true, false, false]);
    // `b` keys on the user, across addresses.
    const security2 = engine({
      limits: [{ id: "b", limit: 3, window: "1m", key: "user" }],
    });
    const byUser = [
      "198.51.100.1",
      "198.51.100.2",
      "198.51.100.3",
      "198.51.100.4",
    ].map((client) =>
      admitted(decide(security2, facts({ client, identity: { user: "u1" } }))),
    );
    expect(byUser).toEqual([true, true, true, false]);
    // No user: the user-keyed limit does not count the request.
    expect(
      Array.from({ length: 5 }, () => admitted(decide(security2, facts()))),
    ).toEqual([true, true, true, true, true]);
  });
});

describe("several limits per route, composite keys and routes", () => {
  /** ConcaveHR's sign-in: 10/min per ip|account, 30/min per ip (password spraying). */
  const SIGN_IN: SecurityPolicy = {
    limits: [
      {
        id: "signin-account",
        limit: 10,
        window: "1m",
        key: ["ip", "user"],
        routes: ["POST /auth/signin"],
        algorithm: "fixed-window",
      },
      {
        id: "signin-ip",
        limit: 30,
        window: "1m",
        routes: ["POST /auth/signin"],
        algorithm: "fixed-window",
      },
    ],
  };
  const signIn = (user: string, extra: Partial<RequestFacts> = {}) =>
    facts({
      method: "POST",
      path: "/auth/signin",
      rawPath: "/auth/signin",
      identity: { user },
      ...extra,
    });

  it("one account: the ip|account limit trips at 10", () => {
    const security = engine(SIGN_IN);
    const answers = Array.from({ length: 12 }, () =>
      decide(security, signIn("alice")),
    );
    expect(answers.map(admitted)).toEqual([
      ...Array.from({ length: 10 }, () => true),
      false,
      false,
    ]);
    expect(answers[10]?.hits.map((hit) => hit.rule)).toEqual([
      "limit:signin-account",
    ]);
    expect(answers[10]).toMatchObject({ status: 429, code: "rate_limited" });
    expect(answers[10]?.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("password spraying: many accounts from one address trip the per-ip limit at 30", () => {
    const security = engine(SIGN_IN);
    const answers = Array.from({ length: 32 }, (_, i) =>
      decide(security, signIn(`user${i}`)),
    );
    expect(answers.map(admitted)).toEqual([
      ...Array.from({ length: 30 }, () => true),
      false,
      false,
    ]);
    expect(answers[30]?.hits.map((hit) => hit.rule)).toEqual([
      "limit:signin-ip",
    ]);
  });

  it("both limits refusing record both hits", () => {
    const security = engine({
      limits: [
        { id: "x", limit: 1, window: "1m", algorithm: "fixed-window" },
        {
          id: "y",
          limit: 1,
          window: "1m",
          algorithm: "fixed-window",
          key: ["ip", "route"],
        },
      ],
    });
    decide(security, facts());
    const second = decide(security, facts());
    expect(second.hits.map((hit) => hit.rule)).toEqual(["limit:x", "limit:y"]);
    expect(second.risk).toBe(2);
  });

  it("applies only on its routes: method, HEAD for GET, case, trailing slash, prefix", () => {
    const security = engine({
      limits: [
        {
          id: "login",
          limit: 1,
          window: "1m",
          routes: ["POST /login"],
          algorithm: "fixed-window",
        },
        {
          id: "page",
          limit: 1,
          window: "1m",
          routes: ["GET /page"],
          algorithm: "fixed-window",
        },
        {
          id: "auth",
          limit: 1,
          window: "1m",
          routes: ["/auth/*"],
          algorithm: "fixed-window",
        },
      ],
    });
    const at = (method: string, path: string, client: string) =>
      admitted(
        decide(security, facts({ method, path, rawPath: path, client })),
      );
    // Another method, another path: not limited.
    expect([
      at("GET", "/login", "192.0.2.1"),
      at("GET", "/login", "192.0.2.1"),
    ]).toEqual([true, true]);
    expect([
      at("POST", "/login", "192.0.2.2"),
      at("POST", "/LOGIN/", "192.0.2.2"),
    ]).toEqual([true, false]);
    expect([
      at("GET", "/page", "192.0.2.3"),
      at("HEAD", "/page", "192.0.2.3"),
    ]).toEqual([true, false]);
    expect([
      at("GET", "/auth", "192.0.2.4"),
      at("PUT", "/auth/x/y", "192.0.2.4"),
    ]).toEqual([true, false]);
    expect([
      at("GET", "/authx", "192.0.2.5"),
      at("GET", "/authx", "192.0.2.5"),
    ]).toEqual([true, true]);
  });

  it("matches the matched route's pattern once routing has run, and keys on it", () => {
    const security = engine({
      limits: [
        {
          id: "user-page",
          limit: 2,
          window: "1m",
          routes: ["GET /users/:id"],
          key: ["ip", "route"],
          algorithm: "fixed-window",
        },
      ],
    });
    const visit = (id: number) =>
      admitted(
        decide(
          security,
          facts({
            path: `/users/${id}`,
            rawPath: `/users/${id}`,
            routeKey: "GET /users/:id",
          }),
        ),
      );
    // Three different ids, one route: one count, so ids cannot multiply counters.
    expect([visit(1), visit(2), visit(3)]).toEqual([true, true, false]);
  });
});

describe("dry run", () => {
  it("a dryRun limit counts and records the would-be 429, never refusing", () => {
    const security = engine({
      limits: [
        {
          id: "d",
          limit: 2,
          window: "1m",
          mode: "dryRun",
          algorithm: "fixed-window",
        },
      ],
    });
    const answers = Array.from({ length: 4 }, () => decide(security, facts()));
    expect(answers.map((d) => d.action)).toEqual([
      "allow",
      "allow",
      "log",
      "log",
    ]);
    expect(answers[2]?.hits).toEqual([
      {
        layer: "L9",
        rule: "limit:d",
        action: "log",
        wouldHaveBeen: "block",
        reason: "dry run: rate limit: 2 per 1m",
      },
    ]);
    expect(answers[2]?.status).toBeUndefined();
  });

  it("a dryRun policy makes every limit dry", () => {
    const security = engine({
      mode: "dryRun",
      limits: [{ id: "e", limit: 1, window: "1m" }],
    });
    decide(security, facts());
    expect(decide(security, facts()).action).toBe("log");
  });
});

describe("run-time updates (load)", () => {
  it("keeps counts when the window and algorithm stay, enforcing the new limit at once", () => {
    const security = engine({
      limits: [{ id: "u", limit: 5, window: "1m", algorithm: "fixed-window" }],
    });
    for (let i = 0; i < 3; i++)
      expect(admitted(decide(security, facts()))).toBe(true);
    security.load({
      limits: [{ id: "u", limit: 4, window: "1m", algorithm: "fixed-window" }],
    });
    expect([
      admitted(decide(security, facts())),
      admitted(decide(security, facts())),
    ]).toEqual([true, false]);
    security.load({
      limits: [{ id: "u", limit: 10, window: "1m", algorithm: "fixed-window" }],
    });
    expect(admitted(decide(security, facts()))).toBe(true);
  });

  it("starts a new count for a new window, drops a removed limit, and builds anew for a new algorithm", () => {
    const security = engine({
      limits: [{ id: "u", limit: 1, window: "1m", algorithm: "fixed-window" }],
    });
    decide(security, facts());
    expect(admitted(decide(security, facts()))).toBe(false);
    security.load({
      limits: [{ id: "u", limit: 1, window: "2m", algorithm: "fixed-window" }],
    });
    expect(admitted(decide(security, facts()))).toBe(true);
    security.load({ limits: [] });
    expect(admitted(decide(security, facts()))).toBe(true);
    security.load({
      limits: [{ id: "u", limit: 1, window: "2m", algorithm: "gcra" }],
    });
    expect([
      admitted(decide(security, facts())),
      admitted(decide(security, facts())),
    ]).toEqual([true, false]);
  });

  it("refuses a gcra limit on a store without consumeGcra, at creation and on load (keeping the old policy)", () => {
    const store = memoryThrottleStore();
    const plain: ThrottleStore = {
      name: "plain",
      increment: (key, cost, ttl) => store.increment(key, cost, ttl),
      get: (key) => store.get(key),
    };
    expect(() =>
      engine(
        { limits: [{ id: "g", limit: 1, window: "1m", algorithm: "gcra" }] },
        fakeClock(),
        plain,
      ),
    ).toThrow(ConfigError);
    const security = engine(
      { limits: [{ id: "s", limit: 1, window: "1m" }] },
      fakeClock(),
      plain,
    );
    const before = security.policy;
    expect(() =>
      security.load({
        limits: [{ id: "g", limit: 1, window: "1m", algorithm: "gcra" }],
      }),
    ).toThrow(/consumeGcra/);
    expect(security.policy).toBe(before);
    decide(security, facts());
    expect(admitted(decide(security, facts()))).toBe(false);
  });
});

describe("who limits apply to", () => {
  const TOKEN = "pay-api-token";
  const verifier = `sha256:${createHash("sha256").update(TOKEN).digest("hex")}`;
  const policy = (
    limits: LimitRule[],
    exempt?: ("lists" | "bans" | "countedRules" | "globalLimits")[],
  ): SecurityPolicy => ({
    serviceIdentity: {
      services: [
        {
          id: "pay-api",
          verifier,
          forwardsClientIp: true,
          ...(exempt ? { exempt } : {}),
        },
      ],
    },
    lists: [{ ip: "198.51.100.0/24", action: "allow" }],
    limits,
  });
  const viaService = (forwarded?: string) =>
    facts({
      client: "10.1.2.3",
      headers: {
        "x-service-token": TOKEN,
        ...(forwarded ? { "x-service-client-ip": forwarded } : {}),
      },
    });
  const twice = (
    security: ReturnType<typeof engine>,
    request: RequestFacts,
  ) => [
    admitted(decide(security, request)),
    admitted(decide(security, request)),
  ];

  it("a verified service exempt from global limits skips them; appliesToServices limits key on the forwarded end user", () => {
    const security = engine(
      policy([
        { id: "global", limit: 1, window: "1m" },
        {
          id: "strict",
          limit: 1,
          window: "1m",
          appliesToServices: true,
          key: ["ip"],
        },
      ]),
    );
    // The end user 203.0.113.5 is counted by the strict limit only.
    expect(twice(security, viaService("203.0.113.5"))).toEqual([true, false]);
    const refused = decide(security, viaService("203.0.113.5"));
    expect(refused.hits.map((hit) => hit.rule)).toEqual([
      "service:pay-api",
      "limit:strict",
    ]);
    // Another end user through the same service: its own count.
    expect(admitted(decide(security, viaService("203.0.113.6")))).toBe(true);
    // No forwarded address: counted against nobody, never the service.
    expect(
      Array.from({ length: 5 }, () => admitted(decide(security, viaService()))),
    ).toEqual([true, true, true, true, true]);
  });

  it("a service not exempt from global limits is limited on the end user it forwards", () => {
    const security = engine(
      policy([{ id: "global", limit: 1, window: "1m" }], ["lists"]),
    );
    expect(twice(security, viaService("203.0.113.5"))).toEqual([true, false]);
  });

  it("an allow entry skips limits, except evenWhenAllowed ones", () => {
    const security = engine(
      policy([
        { id: "plain", limit: 1, window: "1m" },
        { id: "always", limit: 2, window: "1m", evenWhenAllowed: true },
      ]),
    );
    const allowed = facts({ client: "198.51.100.7" });
    expect([
      ...twice(security, allowed),
      admitted(decide(security, allowed)),
    ]).toEqual([true, true, false]);
    expect(decide(security, allowed).hits.map((hit) => hit.rule)).toEqual([
      "ip:198.51.100.0/24",
      "limit:always",
    ]);
  });

  it("an internal client is never limited by an address-only key, but is by an identity key", () => {
    const security = engine({
      limits: [
        { id: "by-ip", limit: 1, window: "1m", evenWhenAllowed: true },
        { id: "by-user", limit: 1, window: "1m", key: ["ip", "user"] },
      ],
    });
    const internal = facts({ client: "10.0.0.8" });
    expect(twice(security, internal)).toEqual([true, true]);
    const withUser = facts({ client: "10.0.0.8", identity: { user: "u" } });
    expect(twice(security, withUser)).toEqual([true, false]);
    expect(decide(security, withUser).hits.map((hit) => hit.rule)).toEqual([
      "internal:10.0.0.0/8",
      "limit:by-user",
    ]);
  });

  it("a list refusal ends the request before any limit counts", () => {
    const security = engine({
      lists: [{ ip: "203.0.113.0/24", action: "block" }],
      limits: [{ id: "l", limit: 1, window: "1m", algorithm: "fixed-window" }],
    });
    for (let i = 0; i < 3; i++) {
      expect(decide(security, facts()).hits.map((hit) => hit.rule)).toEqual([
        "ip:203.0.113.0/24",
      ]);
    }
    security.load({
      limits: [{ id: "l", limit: 1, window: "1m", algorithm: "fixed-window" }],
    });
    expect(admitted(decide(security, facts()))).toBe(true);
  });
});

describe("stores", () => {
  /** A memory store answering every call a tick later. */
  function asyncStore(): ThrottleStore {
    const inner = memoryThrottleStore();
    return {
      name: "async",
      increment: async (key, cost, ttl) => inner.increment(key, cost, ttl),
      get: async (key) => inner.get(key),
      delete: async (key) => inner.delete(key),
    };
  }

  it("an asynchronous store makes evaluate() a promise with the same answers", async () => {
    const security = engine(
      {
        limits: [
          { id: "a", limit: 2, window: "1m", algorithm: "fixed-window" },
        ],
      },
      fakeClock(),
      asyncStore(),
    );
    const outcome = security.evaluate(facts());
    expect(outcome).toBeInstanceOf(Promise);
    const answers = [
      await outcome,
      await security.evaluate(facts()),
      await security.evaluate(facts()),
    ];
    expect(answers.map(admitted)).toEqual([true, true, false]);
  });

  it("a failing store lets the request through (the foundation's fail open) and logs it", async () => {
    const lines: string[] = [];
    const failing: ThrottleStore = {
      name: "down",
      increment: () => {
        throw new Error("connection refused");
      },
      get: () => Promise.reject(new Error("connection refused")),
    };
    const security = createSecurity({
      policy: { limits: [{ id: "a", limit: 1, window: "1m" }] },
      throttleStore: failing,
      logger: (event) => {
        lines.push(event.message);
      },
    });
    const answers = await Promise.all([
      security.evaluate(facts()),
      security.evaluate(facts()),
    ]);
    expect(answers.map(admitted)).toEqual([true, true]);
    expect(
      lines.some((line) => line.includes('throttle store "down" failed')),
    ).toBe(true);
    const explained = await security.explain(facts());
    expect(explained.decision.action).toBe("allow");
    expect(
      explained.steps.some((step) => step.outcome.includes("store failed")),
    ).toBe(true);
  });
});

describe("explain", () => {
  it("reads the limits without consuming them, and agrees with evaluate", () => {
    const security = engine({
      limits: [{ id: "x", limit: 2, window: "1m", algorithm: "fixed-window" }],
    });
    for (let i = 0; i < 5; i++) {
      const explained = security.explain(facts());
      if (explained instanceof Promise) throw new Error("expected synchronous");
      expect(explained.decision.action).toBe("allow");
    }
    decide(security, facts());
    const explained = security.explain(facts());
    if (explained instanceof Promise) throw new Error("expected synchronous");
    const decided = decide(security, facts());
    expect(explained.decision).toEqual(decided);
    expect(
      explained.steps.find((step) => step.rule === "limit:x")?.outcome,
    ).toBe("2 of 2 in 1m");
    const refused = security.explain(facts());
    if (refused instanceof Promise) throw new Error("expected synchronous");
    expect(refused.decision).toEqual(decide(security, facts()));
    expect(refused.decision.action).toBe("block");
  });
});

describe("counting by key (lib/engine/limits.ts, kingsloob1/bun-node#791)", () => {
  it("counts in the entries a throttle's count() with the same prefix and scope reads", () => {
    const clock = fakeClock();
    const store = memoryThrottleStore({ now: clock.now });
    const security = engine(
      { limits: [{ id: "only", limit: 3, window: "1m" }] },
      clock,
      store,
    );
    decide(security, facts({ client: "203.0.113.9" }));
    decide(security, facts({ client: "203.0.113.9" }));
    const direct = throttle({
      limits: { only: { limit: 3, window: "1m" } },
      store,
      prefix: "bun-security:-",
      scope: "global",
      now: clock.now,
    });
    const peeked = direct.peekCount("203.0.113.9");
    if (peeked instanceof Promise) throw new Error("expected synchronous");
    // Two counted by the engine, plus the one peeked.
    expect(peeked[0]?.used).toBe(3);
    // Negative control: another key shares nothing.
    const other = direct.peekCount("203.0.113.10");
    if (other instanceof Promise) throw new Error("expected synchronous");
    expect(other[0]?.used).toBe(1);
  });
});
