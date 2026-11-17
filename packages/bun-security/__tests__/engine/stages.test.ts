/**
 * Two-stage evaluation (plan §3.3, PR-S5): `evaluate(facts, { stage })`
 * splits the engine between an early stage (before the request is read or
 * routed) and a route stage (the matched route and the caller known), each
 * limit and counted rule counted in exactly one of them.
 */
import { PRESETS } from "../../lib/policy/presets";
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type {
  Decision,
  EvaluateOptions,
  RequestFacts,
  SecurityPolicy,
} from "../../lib/index";
import { compilePolicy, policyInternals } from "../../lib/policy/compile";
import { stageOf } from "../../lib/engine/stages";
import { facts, fakeClock } from "../helpers";

/** An engine on a fake clock, quiet. */
function engine(policy: SecurityPolicy) {
  return createSecurity({
    // The managed probe set (on in dry run by default since PR-S12) is
    // left out: these cases are about other layers.
    policy: { requestRules: { managed: false }, ...policy },
    now: fakeClock().now,
    logger: () => {},
  });
}

/** `evaluate()`, required to be synchronous (the memory store). */
function decide(
  security: ReturnType<typeof engine>,
  request: RequestFacts,
  options?: EvaluateOptions,
): Decision {
  const decision = security.evaluate(request, options);
  if (decision instanceof Promise)
    throw new Error("expected a synchronous decision");
  return decision;
}

/** One request through both stages, as the bun-common integration runs it. */
function twoStages(
  security: ReturnType<typeof engine>,
  early: RequestFacts,
  route: RequestFacts,
): { early: Decision; route: Decision | undefined } {
  const first = decide(security, early, { track: true, stage: "early" });
  if (first.action === "block" || first.action === "ban") {
    return { early: first, route: undefined };
  }
  return { early: first, route: decide(security, route, { stage: "route" }) };
}

describe("stageOf: which stage counts a rule", () => {
  it("puts address-only rules on paths early, and caller- or route-keyed rules and parameter patterns in the route stage", () => {
    const internals = policyInternals(
      compilePolicy({
        limits: [
          { id: "ip", limit: 1, window: "1m" },
          { id: "login", limit: 1, window: "1m", routes: ["POST /login"] },
          { id: "auth", limit: 1, window: "1m", routes: ["/auth/*"] },
          { id: "user", limit: 1, window: "1m", key: ["ip", "user"] },
          { id: "api", limit: 1, window: "1m", key: "apiKey" },
          { id: "per-route", limit: 1, window: "1m", key: ["ip", "route"] },
          { id: "param", limit: 1, window: "1m", routes: ["GET /users/:id"] },
        ],
        countedRules: [
          {
            id: "nf",
            event: "route.notFound",
            threshold: 1,
            window: "1m",
            duration: "1h",
          },
          {
            id: "fail",
            event: "auth.failure",
            threshold: 1,
            window: "1m",
            key: "user",
            duration: "1h",
          },
        ],
      }),
    );
    expect(
      Object.fromEntries(
        internals.limits
          .filter(
            (limit) =>
              !Object.hasOwn(PRESETS, limit.id) && limit.id !== "crawler",
          )
          .map((limit) => [limit.id, stageOf(limit)]),
      ),
    ).toEqual({
      ip: "early",
      login: "early",
      auth: "early",
      user: "route",
      api: "route",
      "per-route": "route",
      param: "route",
    });
    expect(
      internals.countedRules
        .filter((rule) => !Object.hasOwn(PRESETS, rule.id))
        .map((rule) => stageOf(rule)),
    ).toEqual(["early", "route"]);
  });
});

describe("evaluate(facts, { stage })", () => {
  it("counts an address limit once across both stages", () => {
    const policy: SecurityPolicy = {
      limits: [{ id: "ip", limit: 2, window: "1m" }],
    };
    const staged = engine(policy);
    const results = [1, 2, 3].map(() => {
      const { early, route } = twoStages(
        staged,
        facts(),
        facts({ routeKey: "GET /" }),
      );
      return [early.action, route?.action];
    });
    expect(results).toEqual([
      ["allow", "allow"],
      ["allow", "allow"],
      ["block", undefined],
    ]);
    // Negative control: both stages each counting every rule counts twice.
    const unstaged = engine(policy);
    const twice = [1, 2].map(() => {
      decide(unstaged, facts());
      return decide(unstaged, facts({ routeKey: "GET /" })).action;
    });
    expect(twice).toEqual(["allow", "block"]);
  });

  it("counts a caller-keyed limit in the route stage only, with the caller known", () => {
    const security = engine({
      limits: [{ id: "user", limit: 1, window: "1m", key: "user" }],
    });
    // The early stage ignores it even with an identity in the facts.
    for (let i = 0; i < 3; i++) {
      expect(
        decide(security, facts({ identity: { user: "u1" } }), {
          stage: "early",
        }).action,
      ).toBe("allow");
    }
    const routeFacts = facts({ identity: { user: "u1" }, routeKey: "GET /" });
    expect(decide(security, routeFacts, { stage: "route" }).action).toBe(
      "allow",
    );
    const second = decide(security, routeFacts, { stage: "route" });
    expect([second.action, second.status, second.hits[0]?.rule]).toEqual([
      "block",
      429,
      "limit:user",
    ]);
  });

  it("matches a parameter pattern on the matched route in the route stage", () => {
    const security = engine({
      limits: [
        { id: "user-page", limit: 1, window: "1m", routes: ["GET /users/:id"] },
      ],
    });
    const early = facts({ path: "/users/7", rawPath: "/users/7" });
    const route = { ...early, routeKey: "GET /users/:id" };
    expect(twoStages(security, early, route).route?.action).toBe("allow");
    expect(twoStages(security, early, route).route?.action).toBe("block");
  });

  it("applies the in-flight limits in the early stage only", () => {
    const security = engine({ concurrency: { perIp: 1 } });
    const route = decide(security, facts(), { track: true, stage: "route" });
    expect(route.action).toBe("allow");
    expect(security.status().state.inFlight).toBe(0);
    const early = decide(security, facts(), { track: true, stage: "early" });
    expect(security.status().state.inFlight).toBe(1);
    expect(
      decide(security, facts(), { track: true, stage: "early" }).action,
    ).toBe("block");
    void security.complete(facts(), early, { status: 200 });
    expect(security.status().state.inFlight).toBe(0);
  });

  it("refuses a user entry in the route stage and an address entry in the early stage, each once", () => {
    const security = engine({
      lists: [
        { ip: "203.0.113.66", action: "block" },
        { user: "mallory", action: "block" },
        { ip: "203.0.113.10", action: "allow" },
      ],
    });
    expect(
      decide(security, facts({ client: "203.0.113.66" }), { stage: "early" })
        .action,
    ).toBe("block");
    const mallory = facts({
      client: "198.51.100.1",
      identity: { user: "mallory" },
    });
    expect(decide(security, mallory, { stage: "early" }).action).toBe("allow");
    const refused = decide(security, mallory, { stage: "route" });
    // The entry's default id is keyed, as the subject is (#842).
    expect([refused.action, refused.hits.map((hit) => hit.rule)]).toEqual([
      "block",
      [`user:${refused.subject.user}`],
    ]);
    // An address allow is recorded once, early; the route stage keeps its effect.
    const allowed = facts({ identity: { user: "alice" } });
    expect(
      decide(security, allowed, { stage: "early" }).hits.map((hit) => hit.rule),
    ).toEqual(["ip:203.0.113.10/32"]);
    expect(decide(security, allowed, { stage: "route" }).hits).toEqual([]);
  });

  it("lets an address allow entry shield the route stage's limits", () => {
    const security = engine({
      lists: [{ ip: "203.0.113.10", action: "allow" }],
      limits: [{ id: "user", limit: 1, window: "1m", key: "user" }],
    });
    const route = facts({ identity: { user: "u1" }, routeKey: "GET /" });
    expect(decide(security, route, { stage: "route" }).action).toBe("allow");
    expect(decide(security, route, { stage: "route" }).action).toBe("allow");
  });

  it("counts outcome events under each decision's own stage at complete()", () => {
    const security = engine({
      countedRules: [
        {
          id: "nf-ip",
          event: "route.notFound",
          threshold: 2,
          window: "1m",
          duration: "1h",
        },
        {
          id: "nf-user",
          event: "route.notFound",
          threshold: 2,
          window: "1m",
          key: "user",
          duration: "1h",
        },
      ],
    });
    const early = facts();
    const route = facts({ identity: { user: "u1" }, routeKey: "GET /" });
    const tripped: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const { early: first, route: second } = twoStages(security, early, route);
      const hits = [
        ...(security.complete(early, first, {
          status: 404,
          routeNotFound: true,
        }) as readonly {
          rule: string;
        }[]),
        ...(security.complete(route, second!, {
          status: 404,
          routeNotFound: true,
        }) as readonly {
          rule: string;
        }[]),
      ];
      tripped.push(hits.map((hit) => hit.rule));
    }
    // Each rule counted once per request: both trip on the second.
    expect(tripped).toEqual([[], ["counted:nf-ip", "counted:nf-user"]]);
  });

  it("leaves an unstaged evaluation as it was: every rule, every layer", () => {
    const security = engine({
      limits: [
        { id: "ip", limit: 5, window: "1m" },
        { id: "user", limit: 1, window: "1m", key: "user" },
      ],
    });
    const request = facts({ identity: { user: "u1" } });
    expect(decide(security, request).action).toBe("allow");
    expect(decide(security, request).hits.map((hit) => hit.rule)).toEqual([
      "limit:user",
    ]);
  });
});

describe("stages meet PR-S3's layers: bans, the ladder, shape, deception", () => {
  it("enforces a user ban in the route stage only, and an address ban in the early stage only", () => {
    const security = engine({});
    security.ban({ user: "mallory", duration: "1h", reason: "fraud" });
    security.ban({ ip: "203.0.113.66", duration: "1h", reason: "scanner" });
    const mallory = facts({ identity: { user: "mallory" }, routeKey: "GET /" });
    expect(decide(security, mallory, { stage: "early" }).action).toBe("allow");
    const user = decide(security, mallory, { stage: "route" });
    expect([user.action, user.code]).toEqual(["ban", "banned"]);
    const scanner = facts({ client: "203.0.113.66" });
    expect(decide(security, scanner, { stage: "early" }).action).toBe("ban");
    expect(decide(security, scanner, { stage: "route" }).hits).toEqual([]);
    // Negative control: unstaged, both apply at once.
    expect(decide(security, mallory).action).toBe("ban");
  });

  it("refuses a honeypot in the early stage, and checks a canary in the route stage", () => {
    const security = engine({
      deception: {
        honeypots: { paths: ["/.env"], answer: "not-found" },
        canaries: [{ id: "backup", user: "svc_backup" }],
      },
    });
    const trap = facts({ path: "/.env", rawPath: "/.env" });
    const early = decide(security, trap, { stage: "early" });
    expect([early.action, early.status, early.hits[0]?.rule]).toEqual([
      "block",
      404,
      "honeypot",
    ]);
    expect(
      decide(
        security,
        { ...trap, client: "198.51.100.20", peer: "198.51.100.20" },
        { stage: "route" },
      ).hits,
    ).toEqual([]);
    const canary = facts({
      client: "198.51.100.21",
      peer: "198.51.100.21",
      identity: { user: "svc_backup" },
    });
    expect(decide(security, canary, { stage: "early" }).action).toBe("allow");
    const used = decide(
      security,
      { ...canary, routeKey: "GET /" },
      { stage: "route" },
    );
    expect([used.action, used.hits[0]?.rule]).toEqual(["ban", "canary:backup"]);
  });

  it("checks the request's shape in the early stage only", () => {
    const security = engine({ shape: { methods: ["GET"] } });
    const post = facts({ method: "POST" });
    const early = decide(security, post, { stage: "early" });
    expect([early.action, early.code]).toEqual(["block", "rejected"]);
    expect(
      decide(
        security,
        { ...post, client: "198.51.100.30", peer: "198.51.100.30" },
        { stage: "route" },
      ).action,
    ).toBe("allow");
  });

  it("adds the weight of an event both stages see once, in the early stage", () => {
    const policy: SecurityPolicy = {
      ladder: {
        steps: [{ score: 3, action: "ban", duration: "1h" }],
        weights: { request: 1, "route.notFound": 1 },
      },
    };
    const staged = engine(policy);
    const actions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { early, route } = twoStages(
        staged,
        facts(),
        facts({ routeKey: "GET /" }),
      );
      actions.push(route?.action ?? early.action);
    }
    // Weight 1 per request: the third reaches 3.
    expect(actions).toEqual(["allow", "allow", "ban"]);
    // Negative control: each request evaluated unstaged twice (both stages
    // counting it) weighs 2, and the second request is banned.
    const doubled = engine(policy);
    decide(doubled, facts());
    decide(doubled, facts({ routeKey: "GET /" }));
    expect(decide(doubled, facts()).action).toBe("ban");
    // complete(): route-not-found weighs once across both decisions.
    const outcomes = engine({
      ladder: {
        steps: [{ score: 2, action: "ban", duration: "1h" }],
        weights: { "route.notFound": 1 },
      },
    });
    const { early, route } = twoStages(
      outcomes,
      facts(),
      facts({ routeKey: "GET /x" }),
    );
    const hits = [
      ...(outcomes.complete(facts(), early, {
        status: 404,
        routeNotFound: true,
      }) as readonly unknown[]),
      ...(outcomes.complete(facts({ routeKey: "GET /x" }), route!, {
        status: 404,
        routeNotFound: true,
      }) as readonly unknown[]),
    ];
    expect(hits).toEqual([]);
    expect(outcomes.status().state.scores).toBeGreaterThanOrEqual(1);
    expect(decide(outcomes, facts(), { stage: "early" }).action).toBe("allow");
  });
});
