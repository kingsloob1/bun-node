/**
 * `explain()` is `evaluate()` with state writes off (README §4.1, §11.1):
 * the same decision for the same facts and time, on random requests, with
 * the steps that led to it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createSecurity, requestFacts } from "../../lib/index";
import type {
  Decision,
  ListEntry,
  RequestFacts,
  SecurityPolicy,
} from "../../lib/index";
import { facts, fakeClock, seededRandom } from "../helpers";

const TOKEN = "svc-token";

/** A policy with a bit of everything. */
const POLICY: SecurityPolicy = {
  service: "svc",
  public: true,
  serviceIdentity: {
    services: [
      {
        id: "sib",
        verifier: `sha256:${createHash("sha256").update(TOKEN).digest("hex")}`,
        forwardsClientIp: true,
        exempt: ["bans"],
      },
    ],
  },
  lists: [
    { id: "block-24", ip: "203.0.113.0/24", action: "block" },
    { id: "allow-one", ip: "203.0.113.7", action: "allow", override: true },
    { id: "drop-v6", ip: "2001:db8:bad::/48", action: "drop" },
    { id: "dry", ip: "198.51.100.0/24", action: "block", mode: "dryRun" },
    {
      id: "admin-only",
      ip: "192.0.2.0/24",
      action: "challenge",
      paths: ["/admin"],
    },
    { id: "user", user: "mallory", action: "block" },
    {
      id: "expired",
      ip: "198.18.0.0/15",
      action: "block",
      expiresAt: "2026-11-15T12:30:00Z",
    },
    {
      id: "internal-block",
      ip: "10.9.0.0/16",
      action: "block",
    } satisfies ListEntry,
  ],
};

/** A random request from a pool of interesting ones. */
function randomFacts(random: () => number): RequestFacts {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  const client = pick([
    "203.0.113.7",
    "203.0.113.9",
    "::ffff:203.0.113.20",
    "2001:db8:bad:1::5",
    "198.51.100.3",
    "192.0.2.4",
    "198.18.1.1",
    "10.9.1.1",
    "100.64.0.9",
    "garbage",
    "",
  ]);
  const headers: Record<string, string> = {};
  if (random() < 0.2)
    headers["x-service-token"] = random() < 0.5 ? TOKEN : "nope";
  if (random() < 0.3)
    headers["x-service-client-ip"] = pick([
      "203.0.113.9",
      "198.51.100.3",
      "junk",
    ]);
  const identity =
    random() < 0.2 ? { user: pick(["mallory", "alice"]) } : undefined;
  return requestFacts(
    new Request(
      `http://svc.test${pick(["/", "/admin", "/admin/x", "/login"])}`,
      { headers },
    ),
    {
      peer: client,
      ...(identity ? { identity } : {}),
    },
  );
}

describe("explain() and evaluate() agree", () => {
  for (const seed of [11, 12, 13]) {
    it(`on 500 random requests across time (seed ${seed})`, () => {
      const random = seededRandom(seed);
      const clock = fakeClock();
      const security = createSecurity({
        policy: POLICY,
        now: clock.now,
        logger: () => {},
      });
      const actions = new Set<string>();
      for (let i = 0; i < 500; i++) {
        const request = randomFacts(random);
        const explained = security.explain(request);
        if (explained instanceof Promise) throw new Error("expected sync");
        const decided = security.evaluate(request) as Decision;
        expect(explained.decision).toEqual(decided);
        actions.add(decided.action);
        clock.advance(Math.floor(random() * 20_000));
      }
      // The pool reaches every outcome the policy has.
      expect([...actions].sort()).toEqual(["allow", "block", "drop", "log"]);
    });
  }
});

describe("explain()", () => {
  const security = createSecurity({
    policy: POLICY,
    now: fakeClock().now,
    logger: () => {},
  });

  /** The explanation, synchronously. */
  const explain = (request: RequestFacts, now?: number) => {
    const explanation = security.explain(
      request,
      now === undefined ? {} : { now },
    );
    if (explanation instanceof Promise) throw new Error("expected sync");
    return explanation;
  };

  it("says how the client was resolved", () => {
    const request = requestFacts(
      new Request("http://svc.test/", {
        headers: { "x-forwarded-for": "203.0.113.9" },
      }),
      {
        peer: "10.0.0.1",
        trustProxy: ["10.0.0.0/8"],
      },
    );
    const { client, steps } = explain(request);
    expect(client).toEqual({
      address: "203.0.113.9",
      key: "203.0.113.9",
      source: "trusted-proxy",
      chain: [
        { address: "10.0.0.1", source: "socket", trusted: true },
        { address: "203.0.113.9", source: "x-forwarded-for", trusted: false },
      ],
    });
    expect(steps[0]).toEqual({
      layer: "L2",
      check: "client",
      outcome: "the client is 203.0.113.9 (trusted-proxy)",
    });
  });

  it("names the entry that decided, and every other that matched", () => {
    const { decision, steps } = explain(facts({ client: "203.0.113.7" }));
    expect(decision.action).toBe("allow");
    const listSteps = steps.filter((step) => step.check === "list");
    expect(listSteps.map((step) => [step.rule, step.decided])).toEqual([
      ["block-24", false],
      ["allow-one", true],
    ]);
    expect(listSteps[1]?.outcome).toBe(
      "matched allow-one → allow (override): decided",
    );
  });

  it("shows why an entry was skipped", () => {
    const { steps } = explain(facts({ client: "192.0.2.4", path: "/login" }));
    expect(steps.find((step) => step.rule === "admin-only")?.outcome).toBe(
      "admin-only → challenge (paths /admin) skipped: another path",
    );
  });

  it("evaluates at another time when asked", () => {
    const request = facts({ client: "198.18.1.1" });
    expect(
      explain(request, Date.parse("2026-11-15T12:00:00Z")).decision.action,
    ).toBe("block");
    const later = explain(request, Date.parse("2026-11-15T13:00:00Z"));
    expect(later.decision.action).toBe("allow");
    expect(
      later.steps.find((step) => step.rule === "expired")?.outcome,
    ).toContain("skipped: expired");
  });

  it("explains a service call and its exemption", () => {
    const request = requestFacts(
      new Request("http://svc.test/", {
        headers: { "x-service-token": TOKEN },
      }),
      { peer: "203.0.113.9" },
    );
    const { client, steps } = explain(request);
    expect(client).toMatchObject({ source: "none", service: "sib" });
    expect(steps.map((step) => step.outcome)).toEqual([
      'verified as service "sib"',
      'service "sib" forwarded no usable address in x-service-client-ip: the request counts against nobody',
      "no list entry matched",
    ]);
  });
});
