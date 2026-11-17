/**
 * PR-AN's analytics data at the enforcement point: the engine's `onSignal`
 * and the recorder's `recordSignal` count challenge answers, sign-in
 * outcomes (a success after recent failures, distinct usernames per
 * address), identifier-pattern hits and the addresses they tripped; exact
 * refusals per subject at an hour tier too; a kept event carries the
 * decision's offence score. Never a raw account id. Each with its negative
 * control.
 */
import type { CounterRow } from "../../lib/store/types";
import { describe, expect, it } from "bun:test";
import {
  analyticsHook,
  analyticsSignalHook,
  createAnalyticsRecorder,
  createEventRing,
  LOGIN_FAILURE_MEMORY_MS,
} from "../../lib/analytics/index";
import { requestFacts } from "../../lib/engine/facts";
import { createSecurity } from "../../lib/index";

const T0 = Date.UTC(2026, 10, 17, 10, 0, 0);
const SECRET = "an-engine-secret-of-at-least-32-bytes!!";

/** Rows of `metric`, summed by their dims. */
function sums(
  rows: readonly CounterRow[],
  metric: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.metric !== metric) continue;
    const key = Object.entries(row.dims ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join(",");
    out[key] = (out[key] ?? 0) + row.value;
  }
  return out;
}

/** A recorder on a fixed clock. */
function recorderAt() {
  let now = T0;
  const recorder = createAnalyticsRecorder({ service: "api", now: () => now });
  return {
    recorder,
    advance: (ms: number) => {
      now += ms;
    },
    rows: () => recorder.flush({ all: true }),
  };
}

describe("recordSignal", () => {
  it("counts challenge answers by outcome; other events are not counted", () => {
    const { recorder, rows } = recorderAt();
    recorder.recordSignal("challenge.passed");
    recorder.recordSignal("challenge.passed");
    recorder.recordSignal("challenge.failed");
    recorder.recordSignal("route.notFound");
    const out = rows();
    expect(sums(out, "challenges")).toEqual({
      "outcome=passed": 2,
      "outcome=failed": 1,
    });
    expect(out.every((row) => row.metric !== "route.notFound")).toBe(true);
  });

  it("counts sign-in outcomes by route, a success after recent failures, and distinct usernames per address", () => {
    const { recorder, advance, rows } = recorderAt();
    const ip = "192.0.2.1";
    for (const username of ["k1", "k2", "k3"]) {
      recorder.recordSignal("auth.failure", {
        route: "POST /login",
        subject: { ip, username },
      });
    }
    recorder.recordSignal("auth.success", {
      route: "POST /login",
      subject: { ip, username: "k3" },
    });
    // The control: a success with no failure before it is not "after failures".
    recorder.recordSignal("auth.success", {
      route: "POST /login",
      subject: { ip: "192.0.2.9", username: "k9" },
    });
    const out = rows();
    expect(sums(out, "login")).toEqual({
      "outcome=failure,route=POST /login": 3,
      "outcome=success,route=POST /login": 2,
    });
    expect(sums(out, "login.success-after-failures")).toEqual({
      "route=POST /login": 1,
    });
    expect(sums(out, "top.usernames-per-ip")).toEqual({
      [`kind=ip,subject=${ip}`]: 3,
      "kind=ip,subject=192.0.2.9": 1,
    });
    // A failure past the memory is forgotten.
    recorder.recordSignal("auth.failure", {
      route: "POST /login",
      subject: { ip },
    });
    advance(LOGIN_FAILURE_MEMORY_MS + 1);
    recorder.recordSignal("auth.success", {
      route: "POST /login",
      subject: { ip },
    });
    expect(sums(rows(), "login.success-after-failures")).toEqual({});
  });

  it("counts identifier-pattern hits and the addresses each tripped", () => {
    const { recorder, rows } = recorderAt();
    recorder.recordSignal("pattern.hit", {
      pattern: "disposable",
      subject: { ip: "192.0.2.1" },
    });
    recorder.recordSignal("pattern.hit", {
      pattern: "disposable",
      subject: { ip: "192.0.2.1" },
    });
    recorder.recordSignal("pattern.hit", {
      pattern: "admin-names",
      subject: { ip: "192.0.2.2" },
    });
    // The control: a pattern.hit without its pattern counts nothing here.
    recorder.recordSignal("pattern.hit", { subject: { ip: "192.0.2.3" } });
    const out = rows();
    expect(sums(out, "patterns")).toEqual({
      "pattern=disposable": 2,
      "pattern=admin-names": 1,
    });
    expect(sums(out, "top.pattern")).toEqual({
      "kind=ip,pattern=disposable,subject=192.0.2.1": 2,
      "kind=ip,pattern=admin-names,subject=192.0.2.2": 1,
    });
  });
});

describe("exact refusals per subject per hour", () => {
  it("are flushed at the hour tier beside the day tier, under the same bound", () => {
    let now = T0;
    const recorder = createAnalyticsRecorder({
      service: "api",
      now: () => now,
      maxRefusedSubjects: 2,
    });
    for (const ip of ["192.0.2.1", "192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      recorder.record({ action: "block", subject: { ip } });
    }
    now += 3_600_000;
    recorder.record({ action: "block", subject: { ip: "192.0.2.1" } });
    const out = recorder.flush({ all: true });
    const hourly = out.filter((row) => row.metric === "refused.hourly");
    expect(hourly.every((row) => row.tier === "hour")).toBe(true);
    expect(
      hourly.map((row) => [row.at - T0, row.dims?.subject, row.value]).sort(),
    ).toEqual([
      [0, "(other)", 1],
      [0, "192.0.2.1", 2],
      [0, "192.0.2.2", 1],
      // The bound holds between flushes, across hours, as the day's does.
      [3_600_000, "(other)", 1],
    ]);
    const overflow = sums(out, "analytics.overflow");
    expect(overflow["what=refused.hourly"]).toBe(2);
  });
});

describe("the engine's onSignal, through analyticsSignalHook", () => {
  it("counts a challenge answer, a sign-in with its keyed username, and check()'s pattern hit; never a raw id", async () => {
    const { recorder, rows } = recorderAt();
    const security = createSecurity({
      policy: {
        identifiers: {
          patterns: [
            { id: "disposable", kind: "email", pattern: "*@mailinator.com" },
          ],
        },
      },
      secret: SECRET,
      logger: () => {},
      onSignal: analyticsSignalHook({ recorder }),
    });
    const facts = requestFacts(
      new Request("http://x/login", { method: "POST" }),
      {
        peer: "192.0.2.1",
        routeKey: "POST /login",
        identity: { username: "alice@example.com" },
      },
    );
    await security.signal(facts, "auth.failure");
    await security.signal(facts, "challenge.passed");
    // check() refuses the value (it throws); its hit is counted first.
    expect(() => security.check(facts, "email", "x@mailinator.com")).toThrow();
    const out = rows();
    expect(sums(out, "login")).toEqual({
      "outcome=failure,route=POST /login": 1,
    });
    expect(sums(out, "challenges")).toEqual({ "outcome=passed": 1 });
    expect(sums(out, "patterns")).toEqual({ "pattern=disposable": 1 });
    const text = JSON.stringify(out);
    expect(text).not.toContain("alice@example.com");
    expect(text).toContain("192.0.2.1");
    security.close();
  });
});

describe("a kept event carries the offence score", () => {
  it("the decision's score after a honeypot's weight; none when nothing added", async () => {
    let now = T0;
    const recorder = createAnalyticsRecorder({
      service: "api",
      now: () => now,
    });
    const ring = createEventRing({
      service: "api",
      recorder,
      now: () => now,
      logger: () => {},
    });
    const security = createSecurity({
      policy: {
        ladder: {
          weights: { "honeypot.hit": 4 },
          steps: [{ score: 100, action: "ban" }],
        },
        deception: { honeypots: { paths: ["/.env"], answer: "not-found" } },
        lists: [{ ip: "198.51.100.1", action: "block" }],
      },
      logger: () => {},
      now: () => now,
      onDecision: analyticsHook({ recorder, ring }),
    });
    const probe = await security.evaluate(
      requestFacts(new Request("http://x/.env"), { peer: "192.0.2.1" }),
    );
    expect(probe.score).toBe(4);
    await security.evaluate(
      requestFacts(new Request("http://x/"), { peer: "198.51.100.1" }),
    );
    const [kept, listed] = ring.take(10);
    expect(kept?.score).toBe(4);
    // The control: a list block adds no offence, so no score.
    expect(listed?.score).toBeUndefined();
    now += 1;
    security.close();
  });
});
