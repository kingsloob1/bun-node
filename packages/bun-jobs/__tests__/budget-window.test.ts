import { describe, expect, it } from "bun:test";
import { HOUR_MS, hourLeft, withinOneHour } from "./helpers/budgetWindow";

/**
 * The hour-boundary guard the summon group race, replica and settled tests
 * take before spending a budget (review of #314, round 2): driven by a fake
 * clock put near an hour's end, so it is shown to hold without waiting for
 * a real one.
 */

/** A fake clock starting at `start`, which a sleep moves on. */
function fakeClock(start: number): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let time = start;
  const slept: number[] = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
    },
    slept,
  };
}

/** Whether `[from, from + span]` lies inside one UTC hour. */
function oneHour(from: number, span: number): boolean {
  return Math.floor(from / HOUR_MS) === Math.floor((from + span) / HOUR_MS);
}

/** An hour's start, well clear of now. */
const HOUR = Math.floor(Date.UTC(2026, 9, 10, 12) / HOUR_MS) * HOUR_MS;

describe("withinOneHour", () => {
  it("waits past the turn when the span would straddle it, and the span then fits one hour", async () => {
    const needed = 81_000;
    // From the hour's last 80 s down to its last millisecond.
    for (const left of [80_000, 60_000, 10_000, 1_000, 1]) {
      const clock = fakeClock(HOUR + HOUR_MS - left);
      expect(oneHour(clock.now(), needed)).toBe(false);
      const waited = await withinOneHour(needed, clock);
      expect({ left, slept: clock.slept, waited }).toEqual({
        left,
        slept: [left + 50],
        waited: left + 50,
      });
      expect(oneHour(clock.now(), needed)).toBe(true);
      expect(clock.now()).toBe(HOUR + HOUR_MS + 50);
    }
  });

  it("returns at once with the span to spare, and at exactly the span left", async () => {
    for (const left of [HOUR_MS, 20 * 60_000, 81_000]) {
      const clock = fakeClock(HOUR + HOUR_MS - left);
      expect(await withinOneHour(81_000, clock)).toBe(0);
      expect(clock.slept).toEqual([]);
      expect(oneHour(clock.now(), 81_000 - 1)).toBe(true);
    }
  });

  it("negative control: without the guard (a span of 0) a run near the end straddles the hour", async () => {
    const clock = fakeClock(HOUR + HOUR_MS - 10_000);
    expect(await withinOneHour(0, clock)).toBe(0);
    expect(oneHour(clock.now(), 81_000)).toBe(false);
  });

  it("reads the real clock by default", async () => {
    // Nothing to wait for when no time is needed; the hour left is real.
    expect(await withinOneHour(0)).toBe(0);
    const left = hourLeft(Date.now());
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(HOUR_MS);
  });
});
