/**
 * The event ring (README §8.1, control-plane.md §9, the user's caps of
 * 2026-11-17): 10 events a minute per subject and rule, 30 per subject, 600
 * per rule, a daily cap, allows sampled, the ring's bound, and every drop
 * counted under its reason, with the `events.capped` warning rate-limited.
 * Then the keys an event and a counter carry, from a real engine: an API
 * key's HMAC and never its id, no raw user id, with negative controls.
 */
import type { LogEvent } from "@kingsleyweb/bun-common";
import type { Decision } from "../../lib/engine/decision";
import type { CounterRow, SecurityEvent } from "../../lib/store/types";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  analyticsHook,
  createAnalyticsRecorder,
  createEventRing,
  createRedactor,
} from "../../lib/analytics/index";
import { createSecurity } from "../../lib/engine/security";
import { facts, fakeClock } from "../helpers";

const T0 = Date.UTC(2026, 10, 17, 12);

/** A refusal by `rule` of the address `ip`. */
function refusal(
  ip: string,
  rule = "r1",
  extra: Partial<Decision> = {},
): Decision {
  return {
    action: "block",
    hits: [{ layer: "L3", rule, action: "block" }],
    tags: [],
    risk: 1,
    subject: { address: ip, ip },
    ...extra,
  };
}

/** A ring and its recorder on a fixed clock, with its warnings. */
function setup(options: Partial<Parameters<typeof createEventRing>[0]> = {}) {
  let now = T0;
  const recorder = createAnalyticsRecorder({ service: "api", now: () => now });
  const { logger, events: logs } = createTestLogger();
  const ring = createEventRing({
    service: "api",
    recorder,
    now: () => now,
    logger,
    ...options,
  });
  return {
    ring,
    recorder,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
    /** `events.*` counters flushed so far, summed by their dims. */
    drops: (): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const row of recorder.flush({ all: true })) {
        if (!row.metric.startsWith("events.")) continue;
        const key = `${row.metric}:${Object.values(row.dims ?? {}).join(",")}`;
        out[key] = (out[key] ?? 0) + row.value;
      }
      return out;
    },
  };
}

/** How many `events.capped` warnings were logged. */
const warnings = (logs: readonly LogEvent[]): number =>
  logs.filter((log) => log.message === "bun-security: events.capped").length;

describe("caps", () => {
  it("10 a minute per subject and rule; the rest counted; the next minute starts again", () => {
    const { ring, drops, advance, logs } = setup();
    const results = Array.from({ length: 15 }, () =>
      ring.offer(refusal("203.0.113.7")),
    );
    expect(results.filter((r) => r === "kept")).toHaveLength(10);
    expect(results.at(-1)).toBe("capped:subject-rule");
    // Another rule for the same subject is not capped by this one.
    expect(ring.offer(refusal("203.0.113.7", "r2"))).toBe("kept");
    expect(drops()).toEqual({ "events.capped:subject-rule": 5 });
    expect(warnings(logs)).toBe(1);
    advance(60_000);
    expect(ring.offer(refusal("203.0.113.7"))).toBe("kept");
    expect(ring.size()).toBe(12);
  });

  it("30 a minute per subject, across its rules", () => {
    const { ring, drops } = setup();
    let kept = 0;
    for (let rule = 0; rule < 10; rule++) {
      for (let i = 0; i < 5; i++)
        if (ring.offer(refusal("203.0.113.7", `r${rule}`)) === "kept")
          kept += 1;
    }
    expect(kept).toBe(30);
    expect(drops()).toEqual({ "events.capped:subject": 20 });
    // The control: another subject is unaffected.
    expect(ring.offer(refusal("198.51.100.1", "r0"))).toBe("kept");
  });

  it("600 a minute per rule, whatever the subjects: a rotated flood is bounded", () => {
    const { ring, drops, logs } = setup();
    let kept = 0;
    for (let i = 0; i < 2_000; i++) {
      if (
        ring.offer(
          refusal(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`),
        ) === "kept"
      )
        kept += 1;
    }
    expect(kept).toBe(600);
    expect(drops()).toEqual({ "events.capped:rule": 1_400 });
    expect(warnings(logs)).toBe(1);
  });

  it("a daily cap, counted past it", () => {
    const { ring, drops, advance } = setup({ caps: { day: 5 } });
    for (let i = 0; i < 8; i++) {
      ring.offer(refusal(`192.0.2.${i}`));
      advance(1);
    }
    expect(ring.size()).toBe(5);
    expect(drops()).toEqual({ "events.capped:day": 3 });
  });

  it("allows are sampled; refusals never are", () => {
    let draws = 0;
    const { ring } = setup({ random: () => (draws++ % 1_000) / 1_000 });
    const allow: Decision = {
      ...refusal("192.0.2.1"),
      action: "allow",
      hits: [],
    };
    const results = Array.from({ length: 2_000 }, () => ring.offer(allow));
    expect(results.filter((r) => r === "kept")).toHaveLength(2);
    expect(results.filter((r) => r === "sampled-out")).toHaveLength(1_998);
  });

  it("the ring's bound drops the oldest, counted", () => {
    const { ring, drops } = setup({ capacity: 3 });
    for (let i = 0; i < 5; i++) ring.offer(refusal(`192.0.2.${i}`));
    expect(ring.take(10).map((e) => e.subjects?.ip)).toEqual([
      "192.0.2.2",
      "192.0.2.3",
      "192.0.2.4",
    ]);
    expect(drops()).toEqual({ "events.dropped:ring": 2 });
  });
});

describe("what an event keeps of the subject", () => {
  const SECRET = "the-analytics-test-secret-of-32-bytes!!";
  const RAW_KEY = "key_live_RAWID123";
  const RAW_USER = "alice@example.com";

  /** A real engine blocking `RAW_KEY` by a list entry, feeding a ring and a recorder. */
  const run = async (
    lists: readonly ({ apiKey: string } | { user: string })[],
  ) => {
    const clock = fakeClock(T0);
    const recorder = createAnalyticsRecorder({
      service: "api",
      now: clock.now,
      subjects: ["ip", "apiKey", "username", "user"],
    });
    const ring = createEventRing({
      service: "api",
      recorder,
      now: clock.now,
      logger: () => {},
    });
    const security = createSecurity({
      policy: {
        lists: lists.map((entry) => ({ ...entry, action: "block" as const })),
      },
      secret: SECRET,
      now: clock.now,
      logger: () => {},
      onDecision: analyticsHook({ recorder, ring, redactor: createRedactor() }),
    });
    const decision = await security.evaluate(
      facts({
        client: "203.0.113.7",
        identity: { apiKey: RAW_KEY, user: RAW_USER },
      }),
    );
    await security.close();
    const events: SecurityEvent[] = ring.take(10);
    const counters: CounterRow[] = recorder.flush({ all: true });
    return { decision, events, counters };
  };

  it("an API key's HMAC, never its id; no raw user id; in events and counters alike", async () => {
    const { decision, events, counters } = await run([{ apiKey: RAW_KEY }]);
    expect(decision.action).toBe("block");
    expect(events).toHaveLength(1);
    const key = decision.subject.apiKey!;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(events[0]?.subjects).toEqual({
      ip: "203.0.113.7",
      apiKey: key,
      user: decision.subject.user,
    });
    // The list entry's default id names the raw key: rewritten to the HMAC.
    expect(events[0]?.rule).toBe(`apiKey:${key}`);
    const refused = counters.filter(
      (row) => row.metric === "top.refused" && row.dims?.kind === "apiKey",
    );
    expect(refused.map((row) => row.dims?.subject)).toEqual([key]);
    const all = JSON.stringify({ events, counters });
    expect(all).not.toContain("RAWID123");
    expect(all).not.toContain(RAW_USER);
  });

  it("a user id only as its HMAC, as the engine keys it (#842)", async () => {
    const { decision, events, counters } = await run([{ user: RAW_USER }]);
    const user = decision.subject.user!;
    expect(user).toMatch(/^[0-9a-f]{32}$/);
    expect(events[0]?.subjects?.user).toBe(user);
    expect(events[0]?.rule).toBe(`user:${user}`);
    const refused = counters.filter(
      (row) => row.metric === "top.refused" && row.dims?.kind === "user",
    );
    expect(refused.map((row) => row.dims?.subject)).toEqual([user]);
    expect(JSON.stringify({ events, counters })).not.toContain(RAW_USER);
    // The user kind needs nothing of the app now.
    expect(() =>
      createAnalyticsRecorder({ service: "api", subjects: ["user"] }),
    ).not.toThrow();
  });

  it("negative control: a decision carrying raw ids would show them, so the checks above can see one", () => {
    const { ring, recorder } = setup();
    ring.offer(
      refusal("203.0.113.7", `apiKey:${RAW_KEY}`, {
        subject: { ip: "203.0.113.7", apiKey: RAW_KEY },
      }),
    );
    recorder.recordDecision(
      refusal("203.0.113.7", "r1", {
        subject: { ip: "203.0.113.7", apiKey: RAW_KEY },
      }),
    );
    const all = JSON.stringify({
      events: ring.take(10),
      counters: recorder.flush({ all: true }),
    });
    expect(all).toContain("RAWID123");
  });
});
