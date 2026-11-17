/**
 * Rollups and retention (README §8.3, §8.4): one pass rolls the closed
 * minutes and hours up after a grace, deletes past each table's retention
 * in bounded batches, says when more is left, refuses a retention past its
 * maximum, runs once at a time, and keeps a timer that never holds the
 * process open.
 */
import { describe, expect, it } from "bun:test";
import {
  analyticsMaintenance,
  DEFAULT_RETENTION,
} from "../../lib/analytics/index";
import { memoryStore, policyFile } from "../../lib/store/index";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 17);

describe("analyticsMaintenance", () => {
  it("rolls closed buckets up after the grace, and deletes past retention", async () => {
    let now = T0 + 2 * HOUR + 3 * 60_000;
    const store = memoryStore({ now: () => now });
    await store.addCounters!([
      { service: "api", at: T0 + 10 * 60_000, metric: "requests", value: 1 },
      {
        service: "api",
        at: T0 + HOUR + 10 * 60_000,
        metric: "requests",
        value: 2,
      },
    ]);
    await store.appendEvents!("b", [
      { id: "old", at: T0 - 20 * DAY, service: "api", action: "block" },
      { id: "new", at: T0, service: "api", action: "block" },
    ]);
    const maintenance = analyticsMaintenance(store, { now: () => now });
    // 02:03 less 5 minutes' grace is 01:58: only hour 0 has closed and settled.
    const first = await maintenance.run();
    expect(first.rolledUp).toEqual({ "minute>hour": 1, "hour>day": 0 });
    expect(first.deleted.events).toBe(1);
    expect(
      (await store.listEvents!({ limit: 10 })).items.map((e) => e.id),
    ).toEqual(["new"]);
    // At 02:04, hour 1 is still within its grace; at 02:06 it is rolled up.
    now = T0 + 2 * HOUR + 4 * 60_000;
    expect((await maintenance.run()).rolledUp["minute>hour"]).toBe(0);
    now = T0 + 2 * HOUR + 6 * 60_000;
    expect((await maintenance.run()).rolledUp["minute>hour"]).toBe(1);
    // A day and a grace later, the day is rolled up.
    now = T0 + DAY + 10 * 60_000;
    expect((await maintenance.run()).rolledUp["hour>day"]).toBe(1);
    const [day] = await store.series!({
      tier: "day",
      metric: "requests",
      from: T0,
      to: T0 + DAY,
    });
    expect(day?.value).toBe(3);
    expect(maintenance.retention).toEqual(DEFAULT_RETENTION);
  });

  it("deletes in bounded batches and says when more is left", async () => {
    const now = T0 + 30 * DAY;
    const store = memoryStore({ now: () => now });
    await store.appendEvents!(
      "b",
      Array.from({ length: 25 }, (_, i) => ({
        id: `e${i}`,
        at: T0 + i,
        service: "api",
        action: "block",
      })),
    );
    const maintenance = analyticsMaintenance(store, {
      now: () => now,
      batchSize: 5,
      maxBatches: 2,
    });
    const first = await maintenance.run();
    expect(first.deleted.events).toBe(10);
    expect(first.more).toBe(true);
    await maintenance.run();
    const third = await maintenance.run();
    expect(third.deleted.events).toBe(5);
    expect(third.more).toBe(false);
  });

  it("refuses a retention past its maximum, an unknown table, and a store without analytics", () => {
    const store = memoryStore();
    expect(() =>
      analyticsMaintenance(store, { retention: { events: "91d" } }),
    ).toThrow(/at most 90 days/);
    expect(() =>
      analyticsMaintenance(store, { retention: { audit: "1d" } as never }),
    ).toThrow(/not a table/);
    expect(() => analyticsMaintenance(store, { batchSize: 0 })).toThrow();
    expect(() => analyticsMaintenance(policyFile("/nonexistent.json"))).toThrow(
      /no analytics/,
    );
    // The control: a retention within its maximum is taken.
    expect(
      analyticsMaintenance(store, { retention: { events: "90d" } }).retention
        .events,
    ).toBe(90 * DAY);
  });

  it("runs one pass at a time; start and stop", async () => {
    const store = memoryStore();
    let rollups = 0;
    const counted = {
      ...store,
      rollup: async (...args: Parameters<NonNullable<typeof store.rollup>>) => {
        rollups += 1;
        await Bun.sleep(5);
        return await store.rollup!(...args);
      },
    };
    const maintenance = analyticsMaintenance(counted, { interval: 10 });
    await Promise.all([
      maintenance.run(),
      maintenance.run(),
      maintenance.run(),
    ]);
    expect(rollups).toBe(2);
    maintenance.start();
    await Bun.sleep(60);
    await maintenance.stop();
    const after = rollups;
    expect(after).toBeGreaterThan(2);
    await Bun.sleep(40);
    expect(rollups).toBe(after);
  });
});
