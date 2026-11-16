/**
 * Layer L7 in the engine (layers.md L7): rule actions, dry run, the events
 * and weights hits feed (counted rules and the ladder), the managed probe
 * set, the two stages, allow entries and `explain()`.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type {
  Decision,
  EvaluateOptions,
  RequestFacts,
  RequestRule,
  SecurityPolicy,
} from "../../lib/index";
import { facts, fakeClock } from "../helpers";

/** An engine on a fake clock, quiet. */
function engine(policy: SecurityPolicy) {
  return createSecurity({ policy, now: fakeClock().now, logger: () => {} });
}

/** `evaluate()`, synchronous (the memory store). */
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

/** Facts for a path. */
const at = (path: string, overrides: Partial<RequestFacts> = {}) =>
  facts({ path, rawPath: path, ...overrides });

/** A policy of one rule. */
const one = (
  rule: RequestRule,
  extra: SecurityPolicy = {},
): SecurityPolicy => ({
  ...extra,
  requestRules: { rules: [rule] },
});

describe("L7 request rules: actions", () => {
  it("blocks a matching request with the rule's status and code, and lets others through", () => {
    const security = engine(
      one({
        id: "dotenv",
        when: { path: { glob: "/**/.env*" } },
        status: 404,
        code: "not_found",
      }),
    );
    const refused = decide(security, at("/static/.env.local"));
    expect([refused.action, refused.status, refused.code]).toEqual([
      "block",
      404,
      "not_found",
    ]);
    expect(refused.hits.map((hit) => [hit.layer, hit.rule])).toEqual([
      ["L7", "rule:dotenv"],
    ]);
    expect(decide(security, at("/static/app.js")).action).toBe("allow");
  });

  it("bans the client address for the rule's duration: the next request is refused by the ban", () => {
    const security = engine(
      one({
        id: "sqlmap",
        when: { header: "user-agent", contains: "sqlmap", ignoreCase: true },
        action: "ban",
        duration: "1h",
      }),
    );
    const hit = decide(
      security,
      at("/", { headers: { "user-agent": "SQLMap/1.7" } }),
    );
    expect([hit.action, hit.code]).toEqual(["ban", "banned"]);
    expect(security.bans().map((ban) => [ban.subject.value, ban.rule])).toEqual(
      [["203.0.113.10", "rule:sqlmap"]],
    );
    const next = decide(security, at("/"));
    expect([next.action, next.hits[0]?.rule.startsWith("ban:")]).toEqual([
      "ban",
      true,
    ]);
  });

  it("drops, logs, and falls back from challenge to block", () => {
    const drop = engine(
      one({ id: "x", when: { path: { equals: "/x" } }, action: "drop" }),
    );
    expect(decide(drop, at("/x")).action).toBe("drop");
    const log = engine(
      one({ id: "x", when: { path: { equals: "/x" } }, action: "log" }),
    );
    const logged = decide(log, at("/x"));
    expect([logged.action, logged.hits[0]?.action]).toEqual(["log", "log"]);
    const challenge = engine(
      one({ id: "x", when: { path: { equals: "/x" } }, action: "challenge" }),
    );
    const blocked = decide(challenge, at("/x"));
    expect([blocked.action, blocked.hits[0]?.reason]).toEqual([
      "block",
      'request rule "x" matched; challenge: no challenge provider configured, fell back to block',
    ]);
  });

  it("records a dry-run hit as what it would have done, refusing and counting nothing", () => {
    const security = engine(
      one(
        {
          id: "x",
          when: { path: { equals: "/x" } },
          action: "ban",
          mode: "dryRun",
          weight: 50,
        },
        { ladder: { steps: [{ score: 1, action: "ban", duration: "1h" }] } },
      ),
    );
    const decision = decide(security, at("/x"));
    expect(decision.action).toBe("log");
    expect(decision.hits[0]).toMatchObject({
      layer: "L7",
      action: "log",
      wouldHaveBeen: "ban",
    });
    expect(security.bans()).toEqual([]);
    expect(decide(security, at("/")).action).toBe("allow");
    // The whole policy in dry run does the same.
    const dryPolicy = engine(
      one({ id: "x", when: { path: { equals: "/x" } } }, { mode: "dryRun" }),
    );
    expect(decide(dryPolicy, at("/x")).hits[0]).toMatchObject({
      action: "log",
      wouldHaveBeen: "block",
    });
  });

  it("is skipped by an allow entry, and off rules are not compiled", () => {
    const security = engine(
      one(
        { id: "x", when: { path: { equals: "/x" } } },
        {
          lists: [{ ip: "203.0.113.10", action: "allow" }],
        },
      ),
    );
    expect(decide(security, at("/x")).action).toBe("allow");
    const off = engine(
      one({ id: "x", when: { path: { equals: "/x" } }, mode: "off" }),
    );
    expect(decide(off, at("/x")).hits).toEqual([]);
  });
});

describe("L7 request rules: matchers and targets", () => {
  const rules: RequestRule[] = [
    { id: "trace", when: { method: { in: ["TRACE", "TRACK"] } } },
    {
      id: "admin",
      when: {
        all: [
          { path: { prefix: "/admin" } },
          { not: { client: { cidr: "10.0.0.0/8" } } },
        ],
      },
    },
    {
      id: "sqli",
      when: { queryParam: "id", regex: "'\\s*or\\s+\\d", ignoreCase: true },
    },
    { id: "debug-cookie", when: { cookie: "debug", exists: true } },
    { id: "big", when: { contentLength: { gt: 1000 } } },
    { id: "php", when: { rawPath: { suffix: ".php" } } },
    { id: "hosts", when: { header: "host", equals: "evil.example" } },
    { id: "debug-header", when: { header: "x-debug", exists: true } },
    {
      id: "no-agent",
      when: {
        all: [
          { path: { equals: "/needs-agent" } },
          { header: "user-agent", exists: false },
        ],
      },
    },
  ];
  // A fresh engine per case, with no shape checks (TRACE) and no ladder,
  // so one case's refusals never ban the next's client.
  const ruleOf = (request: RequestFacts) =>
    decide(
      engine({ shape: false, ladder: false, requestRules: { rules } }),
      request,
    ).hits.find((hit) => hit.layer === "L7")?.rule ?? "allow";

  it.each([
    ["TRACE /", at("/", { method: "TRACE" }), "rule:trace"],
    ["GET /admin from outside", at("/admin/users"), "rule:admin"],
    [
      "GET /admin from 10/8",
      at("/admin/users", { client: "10.1.2.3", peer: "10.1.2.3" }),
      "allow",
    ],
    [
      "an injection in ?id",
      at("/item", { query: "id=1%27%20OR%201%3D1" }),
      "rule:sqli",
    ],
    ["a plain ?id", at("/item", { query: "id=17" }), "allow"],
    [
      "the debug cookie",
      at("/", { cookieNames: ["sid", "debug"] }),
      "rule:debug-cookie",
    ],
    ["a big body", at("/", { contentLength: 5000 }), "rule:big"],
    ["a .PHP raw path (case folded)", at("/index.PHP"), "rule:php"],
    [
      "a foreign Host",
      at("/", { headers: { host: "evil.example" } }),
      "rule:hosts",
    ],
    [
      "an x-debug header",
      at("/", { headers: { "x-debug": "1" } }),
      "rule:debug-header",
    ],
    ["no User-Agent where one is needed", at("/needs-agent"), "rule:no-agent"],
    [
      "a User-Agent where one is needed",
      at("/needs-agent", { headers: { "user-agent": "curl/8" } }),
      "allow",
    ],
  ] as const)("%s → %s", (_name, request, expected) => {
    expect(ruleOf(request)).toBe(expected);
  });
});

describe("L7 request rules: events and the ladder", () => {
  it("counts pattern.hit for counted rules", () => {
    const security = engine(
      one(
        { id: "probe", when: { path: { glob: "/**/*.php" } }, action: "log" },
        {
          countedRules: [
            {
              id: "php-probes",
              event: "pattern.hit",
              threshold: 3,
              window: "1m",
              duration: "1h",
            },
          ],
        },
      ),
    );
    const actions = ["/a.php", "/b.php", "/c.php", "/"].map(
      (path) => decide(security, at(path)).action,
    );
    expect(actions).toEqual(["log", "log", "ban", "ban"]);
  });

  it("adds each hit's weight to the address's score, which the ladder bans on", () => {
    const security = engine(
      one(
        { id: "probe", when: { path: { glob: "/**/*.php" } }, weight: 2 },
        { ladder: { steps: [{ score: 6, action: "ban", duration: "1h" }] } },
      ),
    );
    const actions = ["/a.php", "/b.php", "/c.php", "/"].map(
      (path) => decide(security, at(path)).action,
    );
    // 2, 4, then 6: the third hit reaches the step; the next request is banned.
    expect(actions).toEqual(["block", "block", "ban", "ban"]);
    // Negative control: weight 0 never bans.
    const weightless = engine(
      one(
        { id: "probe", when: { path: { glob: "/**/*.php" } }, weight: 0 },
        { ladder: { steps: [{ score: 6, action: "ban", duration: "1h" }] } },
      ),
    );
    expect(
      ["/a.php", "/b.php", "/c.php", "/"].map(
        (p) => decide(weightless, at(p)).action,
      ),
    ).toEqual(["block", "block", "block", "allow"]);
  });
});

describe("L7 request rules: the managed probe set", () => {
  it("is off unless the policy turns it on, then in dry run", () => {
    expect(decide(engine({}), at("/.env")).hits).toEqual([]);
    const dry = decide(
      engine({ requestRules: { managed: true } }),
      at("/.env"),
    );
    expect(dry.action).toBe("log");
    expect(dry.hits[0]).toMatchObject({
      layer: "L7",
      rule: "probe:dotenv",
      wouldHaveBeen: "block",
    });
  });

  it("enforced, answers path probes 404 and scanners 403, and leaves out what it is told", () => {
    const security = engine({
      requestRules: { managed: { mode: "enforce", exclude: ["wordpress"] } },
    });
    const cases: [string, Partial<RequestFacts>, string][] = [
      ["/.env", {}, "404 probe:dotenv"],
      ["/app/.git/config", {}, "404 probe:vcs"],
      ["/phpMyAdmin/index.php", {}, "404 probe:phpmyadmin"],
      ["/cgi-bin/test.cgi", {}, "404 probe:cgi-bin"],
      ["/actuator/env", {}, "404 probe:actuator"],
      [
        "/",
        {
          headers: {
            "user-agent": "Mozilla/5.0 (compatible; Nmap Scripting Engine)",
          },
        },
        "403 probe:scanner-agents",
      ],
      [
        "/",
        { headers: { "x-a": "a\u0000b" } },
        "400 probe:header-control-chars",
      ],
      [
        "/",
        { headers: { cookie: "a=b" }, headerLengths: { cookie: 9000 } },
        "431 probe:oversized-cookie",
      ],
      ["/wp-admin/", {}, "allow"],
      ["/", { headers: { "user-agent": "Mozilla/5.0 Firefox/130" } }, "allow"],
    ];
    for (const [path, overrides, expected] of cases) {
      const decision = decide(
        security,
        at(path, {
          client: `198.51.100.${cases.findIndex((c) => c[0] === path && c[1] === overrides) + 1}`,
          ...overrides,
        }),
      );
      expect([
        path,
        decision.action === "allow"
          ? "allow"
          : `${decision.status} ${decision.hits[0]?.rule}`,
      ]).toEqual([path, expected]);
    }
  });
});

describe("L7 request rules: the stages", () => {
  it("runs a rule on the caller in the route stage only, and a rule on the path in the early stage only", () => {
    const security = engine({
      requestRules: {
        rules: [
          {
            id: "svc-only",
            when: {
              all: [
                { path: { prefix: "/admin" } },
                { not: { user: { prefix: "svc_" } } },
              ],
            },
          },
          { id: "dotenv", when: { path: { glob: "/**/.env" } } },
        ],
      },
    });
    const admin = at("/admin", { identity: { user: "alice" } });
    expect(decide(security, admin, { stage: "early" }).action).toBe("allow");
    const route = decide(
      security,
      { ...admin, routeKey: "GET /admin" },
      { stage: "route" },
    );
    expect(route.hits.map((hit) => hit.rule)).toEqual(["rule:svc-only"]);
    expect(
      decide(security, at("/admin", { identity: { user: "svc_billing" } }), {
        stage: "route",
      }).action,
    ).toBe("allow");
    const env = at("/.env", { client: "198.51.100.9", peer: "198.51.100.9" });
    expect(
      decide(security, env, { stage: "early" }).hits.map((hit) => hit.rule),
    ).toEqual(["rule:dotenv"]);
    expect(decide(security, env, { stage: "route" }).hits).toEqual([]);
  });

  it("explains a hit", async () => {
    const security = engine(
      one({ id: "dotenv", when: { path: { glob: "/**/.env" } } }),
    );
    const explanation = await security.explain(at("/.env"));
    expect(explanation.steps.filter((step) => step.layer === "L7")).toEqual([
      {
        layer: "L7",
        check: "rule",
        rule: "rule:dotenv",
        outcome: 'request rule "dotenv" matched: refused: block',
      },
    ]);
  });
});
