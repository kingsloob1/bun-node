/**
 * `explain()` and `evaluate()` agree with state in play (README §11.1): on
 * random requests across time through limits (every algorithm, composite
 * keys, routes, dry run), counted rules on `request` and `throttled`, their
 * trips, and L1's in-flight counts, `explain(f).decision` equals the
 * tracked `evaluate(f)` that follows it, and explaining writes nothing.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type { Decision, RequestFacts, SecurityPolicy } from "../../lib/index";
import { facts, fakeClock, seededRandom } from "../helpers";

const POLICY: SecurityPolicy = {
  concurrency: { perIp: 3, total: 6 },
  ladder: {
    halfLife: "10s",
    steps: [
      { score: 12, action: "challenge", duration: "2s" },
      { score: 25, action: "ban" },
    ],
    base: "3s",
    memory: "1m",
  },
  deception: {
    honeypots: { paths: ["/.env"], answer: "not-found" },
    canaries: [{ id: "leaked", user: "canary" }],
  },
  lists: [{ ip: "198.51.100.0/24", action: "allow" }],
  limits: [
    { id: "sliding", limit: 8, window: "10s" },
    {
      id: "fixed",
      limit: 2,
      window: "5s",
      algorithm: "fixed-window",
      key: ["ip", "route"],
      routes: ["POST /login"],
    },
    { id: "bucket", limit: 4, window: "4s", algorithm: "gcra", key: "user" },
    {
      id: "watch",
      limit: 2,
      window: "2s",
      mode: "dryRun",
      evenWhenAllowed: true,
    },
  ],
  countedRules: [
    {
      id: "flood",
      event: "request",
      threshold: 6,
      window: "3s",
      duration: "20s",
    },
    {
      id: "repeat",
      event: "throttled",
      threshold: 3,
      window: "10s",
      duration: "15s",
      key: ["ip", "user"],
    },
    {
      id: "dry",
      event: "throttled",
      threshold: 2,
      window: "10s",
      duration: "1m",
      mode: "dryRun",
    },
  ],
};

/** A random request from a small pool, so limits and rules trip. */
function randomFacts(random: () => number): RequestFacts {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  const client = pick([
    "203.0.113.1",
    "203.0.113.2",
    "2001:db8::1",
    "198.51.100.5",
    "10.0.0.2",
  ]);
  const user =
    random() < 0.5
      ? random() < 0.02
        ? "canary"
        : pick(["ann", "ben"])
      : undefined;
  const [method, path] = pick([
    ["GET", "/"],
    ["POST", "/login"],
    ["GET", "/login"],
    ["GET", "/"],
    ["POST", "/login"],
    ["GET", "/login"],
    ["GET", "/.env"],
    ["GET", "/a%2Fb"],
    ["TRACE", "/"],
  ] as const);
  return facts({
    client,
    method,
    path,
    rawPath: path,
    ...(user ? { identity: { user } } : {}),
  });
}

describe("explain() and evaluate() agree with state in play", () => {
  it("on 600 random requests across time, for each of three seeds", () => {
    const rules = new Set<string>();
    for (const seed of [21, 22, 23]) {
      const random = seededRandom(seed);
      const clock = fakeClock();
      const security = createSecurity({
        // Without the managed set (on in dry run by default since PR-S12).
        policy: { requestRules: { managed: false }, ...POLICY },
        now: clock.now,
        logger: () => {},
      });
      const open: [RequestFacts, Decision][] = [];
      for (let i = 0; i < 600; i++) {
        const request = randomFacts(random);
        const before = security.status().state;
        const explained = security.explain(request);
        if (explained instanceof Promise) throw new Error("expected sync");
        // Explaining writes nothing: a second explanation is the same.
        const again = security.explain(request);
        if (again instanceof Promise) throw new Error("expected sync");
        expect(again.decision).toEqual(explained.decision);
        expect(security.status().state).toEqual(before);
        const decided = security.evaluate(request, { track: true });
        if (decided instanceof Promise) throw new Error("expected sync");
        expect({ seed, i, decision: explained.decision }).toEqual({
          seed,
          i,
          decision: decided,
        });
        for (const hit of decided.hits) {
          // Bans are named by subject; count them by kind.
          const rule = hit.rule.startsWith("ban:") ? "ban" : hit.rule;
          rules.add(`${rule}:${hit.action}`);
        }
        open.push([request, decided]);
        // Answer some of the requests in flight.
        while (open.length > 0 && random() < 0.6) {
          const index = Math.floor(random() * open.length);
          const [done] = open.splice(index, 1);
          if (done) {
            const hits = security.complete(done[0], done[1], { status: 200 });
            if (hits instanceof Promise) throw new Error("expected sync");
          }
        }
        clock.advance(Math.floor(random() * 500));
      }
    }
    // The pool reaches every layer in the policy.
    expect([...rules].sort()).toEqual(
      [
        "concurrency:per-ip:block",
        "concurrency:total:block",
        "limit:sliding:block",
        "limit:fixed:block",
        "limit:bucket:block",
        "limit:watch:log",
        "ban:ban",
        "ban:block",
        "ladder:block",
        "ladder:ban",
        "ladder:log",
        "honeypot:block",
        "canary:leaked:ban",
        "shape.path:block",
        "shape.method:block",
        "counted:flood:ban",
        "counted:repeat:ban",
        "counted:dry:log",
        "internal:10.0.0.0/8:allow",
        "ip:198.51.100.0/24:allow",
      ].sort(),
    );
  });
});
