/**
 * The offence score and the ladder (layers.md §0.2, plan D10): weights per
 * event and per counted rule, exponential decay, the default steps (3 →
 * challenge 15 min, 10 → ban), escalating ban lengths (`base ×
 * factor^(n-1)` within `memory`, capped at `maxBan`), the score reset after
 * a ban, dry run, and who is scored. A property test checks the scores and
 * bans against a reference model.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type {
  Decision,
  LadderPolicy,
  RequestFacts,
  SecurityPolicy,
} from "../../lib/index";
import { facts, fakeClock, seededRandom } from "../helpers";
import type { FakeClock } from "../helpers";

/** An engine on a fake clock, quiet. */
function engine(policy: SecurityPolicy, clock: FakeClock = fakeClock()) {
  return createSecurity({
    // The managed probe set (on in dry run by default since PR-S12) is
    // left out: these cases are about other layers.
    policy: { requestRules: { managed: false }, ...policy },
    now: clock.now,
    logger: () => {},
  });
}
type Engine = ReturnType<typeof engine>;

/** `signal()`, required to be synchronous. */
function signalNow(security: Engine, request: RequestFacts, event: string) {
  const hits = security.signal(request, event);
  if (hits instanceof Promise) throw new Error("expected synchronous");
  return hits;
}

/** `evaluate()`, synchronously. */
function decide(security: Engine, request: RequestFacts = facts()): Decision {
  const decision = security.evaluate(request);
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

/** `signal()` of an event weighing `weight` under `weights`. */
function offend(security: Engine, request: RequestFacts = facts()) {
  const hits = security.signal(request, "probe");
  if (hits instanceof Promise) throw new Error("expected synchronous");
  return hits;
}

const HOUR = 3_600_000;

describe("the default ladder", () => {
  it("challenges at 3 for 15 minutes, bans at 10 for an hour, and starts the score again", () => {
    const clock = fakeClock();
    const security = engine({ ladder: { weights: { probe: 1 } } }, clock);
    expect(offend(security)).toEqual([]);
    expect(offend(security)).toEqual([]);
    expect(offend(security)).toEqual([
      {
        layer: "L4",
        rule: "ladder",
        action: "block",
        reason:
          "ladder: score 3.00 reached 3 (probe); challenge: no challenge provider configured, fell back to block",
      },
    ]);
    expect(security.bans()).toMatchObject([
      {
        id: "ip:203.0.113.10",
        action: "challenge",
        rule: "ladder",
        expiresAt: clock.now() + 15 * 60_000,
      },
    ]);
    expect(decide(security)).toMatchObject({ action: "block", code: "banned" });
    for (let i = 4; i < 10; i++) offend(security);
    expect(offend(security)).toMatchObject([{ rule: "ladder", action: "ban" }]);
    expect(security.bans()).toMatchObject([
      { action: "ban", expiresAt: clock.now() + HOUR },
    ]);
    expect(decide(security).action).toBe("ban");
    // The score started again: one more offence reaches nothing.
    expect(offend(security)).toEqual([]);
  });

  it("escalates ban lengths: 1 h, 6 h, 36 h within a week, capped at 30 days", () => {
    const clock = fakeClock();
    const ladder: LadderPolicy = { weights: { probe: 10 } };
    const security = engine({ ladder }, clock);
    const lengths: number[] = [];
    for (let i = 0; i < 5; i++) {
      offend(security);
      const ban = security.bans()[0];
      lengths.push((ban?.expiresAt ?? 0) - clock.now());
      security.unban("ip:203.0.113.10");
      clock.advance(60_000);
    }
    expect(lengths).toEqual([
      HOUR,
      6 * HOUR,
      36 * HOUR,
      216 * HOUR,
      720 * HOUR,
    ]);
    // Past the memory (7 days), the next ban is short again.
    clock.advance(8 * 24 * HOUR);
    offend(security);
    expect((security.bans()[0]?.expiresAt ?? 0) - clock.now()).toBe(HOUR);
  });

  it("lets a score decay by its half-life", () => {
    const clock = fakeClock();
    const security = engine(
      {
        ladder: {
          weights: { probe: 2 },
          halfLife: "10m",
          steps: [{ score: 3, action: "ban" }],
        },
      },
      clock,
    );
    offend(security);
    clock.advance(20 * 60_000); // 2 halves twice → 0.5
    expect(offend(security)).toEqual([]); // 2.5 < 3
    expect(offend(security)).toHaveLength(1); // 4.5 ≥ 3
    // Negative control: without the wait, the second offence reaches 4.
    const other = facts({ client: "203.0.113.50" });
    offend(security, other);
    expect(offend(security, other)).toHaveLength(1);
  });
});

describe("offences", () => {
  it("weigh as the policy says: L8's events by default, a counted rule's trip by its weight", () => {
    const security = engine({
      ladder: { steps: [{ score: 2, action: "ban" }] },
      countedRules: [
        {
          id: "heavy",
          event: "auth.failure",
          threshold: 1,
          window: "1m",
          duration: "1m",
          weight: 2,
        },
        {
          id: "light",
          event: "signup",
          threshold: 1,
          window: "1m",
          duration: "1m",
          weight: 0,
        },
      ],
    });
    const a = facts({ client: "192.0.2.1" });
    expect(security.signal(a, "signup")).toMatchObject([
      { rule: "counted:light" },
    ]);
    const b = facts({ client: "192.0.2.2" });
    expect(security.signal(b, "auth.failure")).toMatchObject([
      { rule: "counted:heavy" },
      { rule: "ladder", action: "ban" },
    ]);
    expect(
      signalNow(security, facts({ client: "192.0.2.3" }), "trap.filled"),
    ).toMatchObject([{ rule: "ladder", action: "ban" }]);
    // An event with no weight scores nothing.
    expect(security.signal(facts({ client: "192.0.2.4" }), "anything")).toEqual(
      [],
    );
  });

  it('a counted rule with action "ladder" bans its key for the escalating length', () => {
    const clock = fakeClock();
    const security = engine(
      {
        ladder: { weights: {}, steps: [{ score: 1_000, action: "ban" }] },
        countedRules: [
          {
            id: "l",
            event: "auth.failure",
            threshold: 1,
            window: "1m",
            action: "ladder",
            weight: 0,
          },
        ],
      },
      clock,
    );
    signalNow(security, facts(), "auth.failure");
    expect((security.bans()[0]?.expiresAt ?? 0) - clock.now()).toBe(HOUR);
    security.unban("ip:203.0.113.10");
    signalNow(security, facts(), "auth.failure");
    expect((security.bans()[0]?.expiresAt ?? 0) - clock.now()).toBe(6 * HOUR);
  });

  it("never score an allow-listed or internal client, nor a request with no address", () => {
    const security = engine({
      ladder: { weights: { probe: 100 } },
      lists: [{ ip: "198.51.100.0/24", action: "allow" }],
    });
    for (const client of ["198.51.100.1", "10.0.0.1", ""]) {
      expect(offend(security, facts({ client, peer: client }))).toEqual([]);
    }
    expect(security.status().state.scores).toBe(0);
  });

  it("in dry run score and log the would-be ban, banning nobody", () => {
    for (const policy of [
      { ladder: { weights: { probe: 10 }, mode: "dryRun" } },
      { mode: "dryRun", ladder: { weights: { probe: 10 } } },
    ] satisfies SecurityPolicy[]) {
      const security = engine(policy);
      expect(offend(security)).toMatchObject([
        { rule: "ladder", action: "log", wouldHaveBeen: "ban" },
      ]);
      expect(security.bans()).toEqual([]);
    }
  });

  it("are off with ladder: false", () => {
    const security = engine({ ladder: false, deception: { honeypots: true } });
    for (let i = 0; i < 5; i++) {
      decide(security, facts({ path: "/.env", rawPath: "/.env" }));
    }
    expect(security.bans()).toEqual([]);
  });
});

describe("explain", () => {
  it("adds up one request's offences without writing them", () => {
    const security = engine({
      ladder: {
        weights: { "honeypot.hit": 6 },
        steps: [{ score: 10, action: "ban" }],
      },
      deception: { honeypots: { paths: ["/.env"], answer: "not-found" } },
    });
    const probe = facts({ path: "/.env", rawPath: "/.env" });
    const explained = security.explain(probe);
    if (explained instanceof Promise) throw new Error("expected synchronous");
    expect(security.status().state.scores).toBe(0);
    expect(explained.decision).toEqual(decide(security, probe));
    // The second probe takes the score past 10: the ban applies from the next request.
    const second = security.explain(probe);
    if (second instanceof Promise) throw new Error("expected synchronous");
    expect(second.decision).toEqual(decide(security, probe));
    expect(second.decision.hits.map((hit) => [hit.rule, hit.action])).toEqual([
      ["honeypot", "block"],
      ["ladder", "log"],
    ]);
    expect(decide(security).action).toBe("ban");
  });
});

describe("property: scores and bans against a reference model", () => {
  it("agrees on random offence timelines", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const random = seededRandom(seed);
      const clock = fakeClock();
      const halfLife = 60_000 * (1 + Math.floor(random() * 30));
      const weight = 1 + Math.floor(random() * 4);
      const security = engine(
        {
          ladder: {
            halfLife: { ms: halfLife },
            weights: { probe: weight },
            steps: [{ score: 10, action: "ban" }],
          },
        },
        clock,
      );
      let score = 0;
      let at = clock.now();
      let banned = 0;
      let bans: number[] = [];
      for (let step = 0; step < 200; step++) {
        clock.advance(Math.floor(random() * 10 * 60_000));
        const now = clock.now();
        if (random() < 0.7) {
          score = score * 0.5 ** ((now - at) / halfLife) + weight;
          at = now;
          let length = 0;
          if (score >= 10) {
            bans = bans.filter((t) => now - t < 7 * 24 * HOUR);
            length = Math.min(30 * 24 * HOUR, HOUR * 6 ** bans.length);
            bans.push(now);
            banned = Math.max(banned, now + length);
            score = 0;
          }
          const hits = offend(security);
          expect({ seed, step, ban: hits.length > 0 }).toEqual({
            seed,
            step,
            ban: length > 0,
          });
        } else {
          const refused = decide(security).action === "ban";
          expect({ seed, step, refused }).toEqual({
            seed,
            step,
            refused: banned > now,
          });
        }
      }
    }
  });
});
