/**
 * The enforcement point's counters (README §8.1): each metric of a minute,
 * exact refusals per subject per day, each minute's top-K by space-saving,
 * flushing closed minutes only, and every bound folding into `(other)` with
 * the overflow counted, never silently. Then space-saving's own guarantee.
 */
import type { CounterRow } from "../../lib/store/types";
import { describe, expect, it } from "bun:test";
import {
  createAnalyticsRecorder,
  OTHER,
  SpaceSaving,
} from "../../lib/analytics/index";
import { seededRandom } from "../helpers";

const T0 = Date.UTC(2026, 10, 17, 12);

/** The rows of `metric`, as `dims → value`. */
function byDims(
  rows: readonly CounterRow[],
  metric: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.metric !== metric) continue;
    const key = Object.entries(row.dims ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    out[key] = (out[key] ?? 0) + row.value;
  }
  return out;
}

describe("createAnalyticsRecorder", () => {
  it("counts a minute by action, route, rule, country, ASN, status class and latency", () => {
    let now = T0;
    const recorder = createAnalyticsRecorder({
      service: "api",
      now: () => now,
    });
    recorder.record({
      action: "block",
      route: "POST /login",
      hits: [
        { rule: "r1", action: "block" },
        { rule: "r2", action: "challenge", dryRun: true },
      ],
      subject: { ip: "203.0.113.7" },
      country: "NG",
      asn: 64_500,
      status: 403,
      latencyMs: 0.3,
    });
    recorder.record({ action: "allow", status: 200, latencyMs: 400 });
    // The open minute is not flushed (the exact refusals, day and hour tiers, are at once).
    expect(
      recorder
        .flush()
        .filter((row) => row.tier !== "day" && row.tier !== "hour"),
    ).toEqual([]);
    now += 60_000;
    const rows = recorder.flush();
    expect(byDims(rows, "requests")).toEqual({
      "action=allow": 1,
      "action=block": 1,
    });
    expect(byDims(rows, "requests.route")).toEqual({
      "action=block,route=POST /login": 1,
    });
    expect(byDims(rows, "rules")).toEqual({
      "action=block,dryRun=false,rule=r1": 1,
      "action=challenge,dryRun=true,rule=r2": 1,
    });
    expect(byDims(rows, "requests.country")).toEqual({
      "action=block,country=NG": 1,
    });
    expect(byDims(rows, "requests.asn")).toEqual({
      "action=block,asn=64500": 1,
    });
    expect(byDims(rows, "responses")).toEqual({
      "class=2xx": 1,
      "class=4xx": 1,
    });
    expect(byDims(rows, "latency")).toEqual({ "le=+Inf": 1, "le=0.5": 1 });
    expect(rows.every((row) => row.service === "api")).toBe(true);
    expect(recorder.stats()).toEqual({
      pendingMinutes: 0,
      pendingRows: 0,
      pendingRefused: 0,
    });
  });

  it("counts refusals exactly per subject per day, and the minute's top-K", () => {
    let now = T0;
    const recorder = createAnalyticsRecorder({
      service: "api",
      now: () => now,
      topK: 2,
    });
    for (let i = 0; i < 5; i++)
      recorder.record({ action: "block", subject: { ip: "1.1.1.1" } });
    for (let i = 0; i < 3; i++)
      recorder.record({
        action: "ban",
        subject: { ip: "2.2.2.2", apiKey: "hmac-k" },
      });
    recorder.record({ action: "drop", subject: { ip: "3.3.3.3" } });
    recorder.record({ action: "challenge", subject: { ip: "4.4.4.4" } });
    now += 60_000;
    const rows = recorder.flush();
    const refused = rows.filter((row) => row.metric === "refused");
    expect(
      refused.every(
        (row) => row.tier === "day" && row.at === Date.UTC(2026, 10, 17),
      ),
    ).toBe(true);
    expect(byDims(refused, "refused")).toEqual({
      "kind=ip,subject=1.1.1.1": 5,
      "kind=ip,subject=2.2.2.2": 3,
      "kind=ip,subject=3.3.3.3": 1,
      "kind=apiKey,subject=hmac-k": 3,
    });
    // Space-saving with room for two: 3.3.3.3 took 2.2.2.2's place and
    // inherited its 3 as error (an overestimate, never an underestimate).
    expect(byDims(rows, "top.refused")).toEqual({
      "kind=ip,subject=1.1.1.1": 5,
      "kind=ip,subject=3.3.3.3": 4,
      "kind=apiKey,subject=hmac-k": 3,
    });
    // Deltas: the next flush starts again.
    recorder.record({ action: "block", subject: { ip: "1.1.1.1" } });
    expect(byDims(recorder.flush(), "refused")).toEqual({
      "kind=ip,subject=1.1.1.1": 1,
    });
  });

  it("folds past its bounds into (other), and counts the overflow", () => {
    let now = T0;
    const recorder = createAnalyticsRecorder({
      service: "api",
      now: () => now,
      maxRowsPerMinute: 5,
      maxAsns: 2,
      maxRefusedSubjects: 2,
    });
    for (let i = 0; i < 4; i++)
      recorder.record({
        action: "block",
        asn: i,
        subject: { ip: `10.0.0.${i}` },
      });
    for (let i = 0; i < 10; i++)
      recorder.record({ action: "allow", route: `GET /r${i}` });
    now += 60_000;
    const rows = recorder.flush();
    expect(byDims(rows, "requests.asn")).toEqual({
      "action=block,asn=0": 1,
      "action=block,asn=1": 1,
      [`action=block,asn=${OTHER}`]: 2,
    });
    expect(
      byDims(rows, "requests.route")[`action=${OTHER},route=${OTHER}`],
    ).toBeGreaterThan(0);
    expect(byDims(rows, "refused")).toEqual({
      "kind=ip,subject=10.0.0.0": 1,
      "kind=ip,subject=10.0.0.1": 1,
      [`kind=ip,subject=${OTHER}`]: 2,
    });
    const overflow = byDims(rows, "analytics.overflow");
    expect(overflow["what=asns"]).toBe(2);
    expect(overflow["what=refused"]).toBe(2);
    expect(
      Object.keys(overflow).some((key) => key.startsWith("what=rows:")),
    ).toBe(true);
    // The bound holds: 5 rows, plus one (other) row per metric that overflowed.
    const counted = rows.filter(
      (row) =>
        row.tier !== "day" &&
        row.tier !== "hour" &&
        row.metric !== "analytics.overflow" &&
        !row.metric.startsWith("top."),
    );
    const folded = Object.keys(overflow).filter((key) =>
      key.startsWith("what=rows:"),
    );
    expect(counted.length).toBeLessThanOrEqual(5 + folded.length);
  });

  it("keeps at most maxPendingMinutes unflushed, counting what it drops", () => {
    let now = T0;
    const recorder = createAnalyticsRecorder({
      service: "api",
      now: () => now,
      maxPendingMinutes: 2,
    });
    for (let i = 0; i < 4; i++) {
      recorder.record({ action: "allow" });
      now += 60_000;
    }
    expect(recorder.stats().pendingMinutes).toBe(2);
    const rows = recorder.flush();
    expect(byDims(rows, "analytics.overflow")).toEqual({ "what=minutes": 2 });
    expect(byDims(rows, "requests")).toEqual({ "action=allow": 2 });
  });

  it("cuts a long value to a store's 200 characters, and checks count() as a store would", () => {
    let now = T0;
    const recorder = createAnalyticsRecorder({
      service: "api",
      now: () => now,
    });
    recorder.record({ action: "allow", route: `GET /${"x".repeat(500)}` });
    recorder.count("store.errors");
    expect(() => recorder.count("Bad Metric")).toThrow();
    expect(() => recorder.count("ok", {}, -1)).toThrow();
    now += 60_000;
    const rows = recorder.flush();
    const route = rows.find((row) => row.metric === "requests.route")!.dims!
      .route!;
    expect(route.length).toBe(200);
    expect(byDims(rows, "store.errors")).toEqual({ "": 1 });
  });

  it("refuses bad options", () => {
    expect(() => createAnalyticsRecorder({ service: "" })).toThrow();
    expect(() =>
      createAnalyticsRecorder({ service: "api", topK: 0 }),
    ).toThrow();
    expect(() =>
      createAnalyticsRecorder({ service: "api", subjects: ["phone" as never] }),
    ).toThrow();
  });
});

describe("SpaceSaving", () => {
  it("holds every key heavier than total/capacity, overestimating by at most its error", () => {
    const random = seededRandom(7);
    const summary = new SpaceSaving(20);
    const truth = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) {
      // Five heavy keys, a long tail.
      const key =
        random() < 0.5
          ? `heavy${Math.floor(random() * 5)}`
          : `tail${Math.floor(random() * 5_000)}`;
      summary.offer(key);
      truth.set(key, (truth.get(key) ?? 0) + 1);
    }
    const held = new Map(summary.top().map((entry) => [entry.key, entry]));
    for (const [key, count] of truth) {
      if (count > summary.total / summary.capacity)
        expect(held.has(key)).toBe(true);
    }
    for (const entry of held.values()) {
      const real = truth.get(entry.key) ?? 0;
      expect(entry.count).toBeGreaterThanOrEqual(real);
      expect(entry.count - entry.error).toBeLessThanOrEqual(real);
    }
    expect(
      summary
        .top()
        .slice(0, 5)
        .every((entry) => entry.key.startsWith("heavy")),
    ).toBe(true);
    expect(summary.size).toBe(20);
  });

  it("refuses a capacity under 1", () => {
    expect(() => new SpaceSaving(0)).toThrow(RangeError);
  });
});
