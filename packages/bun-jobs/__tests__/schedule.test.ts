import { describe, expect, it } from "bun:test";
import {
  ConfigError,
  createTicker,
  nextFireDate,
  normalizeSchedule,
} from "../lib/index";
import { waitFor } from "./helpers";

/**
 * Schedules: the three shapes a runner accepts, and the ticker that fires
 * them. Ticker tests use short intervals rather than a fake clock, because
 * the behaviour under test is the timer arithmetic itself.
 */

describe("normalizeSchedule", () => {
  it("reads a bare value as its obvious shape", () => {
    expect(normalizeSchedule("*/5 * * * *")).toEqual({ cron: "*/5 * * * *" });
    expect(normalizeSchedule(5000)).toEqual({ every: 5000 });
    expect(normalizeSchedule(new Date(1_700_000_000_000))).toEqual({
      at: 1_700_000_000_000,
    });
    expect(normalizeSchedule(undefined)).toBeNull();
    expect(normalizeSchedule(null)).toBeNull();
  });

  it("keeps six-field expressions as cron", () => {
    // The seconds are handled by the cron parser, not rewritten to an
    // interval — so the expression a caller wrote is the one stored.
    expect(normalizeSchedule("*/10 * * * * *")).toEqual({
      cron: "*/10 * * * * *",
    });
  });

  it("normalises absolute times to epoch milliseconds", () => {
    const anchor = new Date("2026-01-01T00:00:00.000Z");
    expect(normalizeSchedule({ every: 1000, anchor })).toEqual({
      every: 1000,
      anchor: anchor.getTime(),
    });
    expect(normalizeSchedule({ at: anchor })).toEqual({
      at: anchor.getTime(),
    });
  });

  it("carries a pinned time zone", () => {
    expect(normalizeSchedule({ cron: "0 9 * * *", tz: "UTC" })).toEqual({
      cron: "0 9 * * *",
      tz: "UTC",
    });
  });

  it("rejects what cannot fire", () => {
    expect(() => normalizeSchedule("not a cron")).toThrow(ConfigError);
    expect(() => normalizeSchedule(0)).toThrow(/positive/);
    expect(() => normalizeSchedule(-1)).toThrow(/positive/);
    expect(() => normalizeSchedule({ every: Number.NaN })).toThrow(/positive/);
    expect(() => normalizeSchedule({ at: new Date("nonsense") })).toThrow(
      /valid date/,
    );
  });
});

describe("nextFireDate", () => {
  const from = new Date("2026-01-01T12:00:00.000Z");

  it("has nothing to fire for a manual schedule", () => {
    expect(nextFireDate(null, from)).toBeNull();
  });

  it("delegates cron to the cron parser", () => {
    expect(nextFireDate({ cron: "*/15 * * * *" }, from)?.toISOString()).toBe(
      "2026-01-01T12:15:00.000Z",
    );
    expect(nextFireDate({ cron: "*/10 * * * * *" }, from)?.toISOString()).toBe(
      "2026-01-01T12:00:10.000Z",
    );
  });

  it("measures an un-anchored interval from the given instant", () => {
    expect(nextFireDate({ every: 60_000 }, from)?.toISOString()).toBe(
      "2026-01-01T12:01:00.000Z",
    );
  });

  it("keeps an anchored interval on the anchor's grid", () => {
    const anchor = new Date("2026-01-01T12:00:00.000Z").getTime();

    // Mid-interval: the next point on the grid, not now plus the interval.
    expect(
      nextFireDate(
        { every: 60_000, anchor },
        new Date("2026-01-01T12:00:30.000Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T12:01:00.000Z");

    // Exactly on a grid point: strictly after, so the following one.
    expect(nextFireDate({ every: 60_000, anchor }, from)?.toISOString()).toBe(
      "2026-01-01T12:01:00.000Z",
    );

    // Far in the future: still on the grid, with no accumulated drift.
    expect(
      nextFireDate(
        { every: 60_000, anchor },
        new Date("2026-01-01T12:59:59.500Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T13:00:00.000Z");
  });

  it("fires a one-shot once, then never again", () => {
    const at = new Date("2026-01-01T12:30:00.000Z").getTime();
    expect(nextFireDate({ at }, from)?.getTime()).toBe(at);
    expect(nextFireDate({ at }, new Date(at))).toBeNull();
    expect(nextFireDate({ at }, new Date(at + 1))).toBeNull();
  });
});

describe("createTicker", () => {
  it("does nothing for a manual schedule", () => {
    let fired = 0;
    const ticker = createTicker(null, () => fired++, { keepAlive: false });

    expect(ticker.next()).toBeNull();
    ticker.stop();
    expect(fired).toBe(0);
  });

  it("fires an interval repeatedly with its scheduled time", async () => {
    const fired: Date[] = [];
    const ticker = createTicker({ every: 20 }, (at) => fired.push(at), {
      keepAlive: false,
    });

    try {
      await waitFor(() => fired.length >= 3, {
        message: "ticker did not fire",
      });
    } finally {
      ticker.stop();
    }

    // Scheduled times sit on the interval grid, so lateness cannot accumulate.
    expect(fired[1].getTime() - fired[0].getTime()).toBe(20);
    expect(fired[2].getTime() - fired[1].getTime()).toBe(20);
  });

  it("stops firing once stopped", async () => {
    let fired = 0;
    const ticker = createTicker({ every: 10 }, () => fired++, {
      keepAlive: false,
    });

    await waitFor(() => fired > 0);
    ticker.stop();
    const seen = fired;

    await Bun.sleep(40);
    expect(fired).toBe(seen);
    expect(ticker.next()).toBeNull();
  });

  it("is idempotent about stopping", () => {
    const ticker = createTicker({ every: 1000 }, () => {}, {
      keepAlive: false,
    });
    ticker.stop();
    ticker.stop();
  });

  it("fires a one-shot exactly once", async () => {
    const fired: Date[] = [];
    const at = Date.now() + 20;
    const ticker = createTicker({ at }, (when) => fired.push(when), {
      keepAlive: false,
    });

    try {
      await waitFor(() => fired.length > 0);
      await Bun.sleep(60);
      expect(fired).toHaveLength(1);
      expect(ticker.next()).toBeNull();
    } finally {
      ticker.stop();
    }
  });

  it("fires a sub-minute cron on the wall-clock mark", async () => {
    const fired: Date[] = [];
    const ticker = createTicker(
      { cron: "* * * * * *" },
      (at) => fired.push(at),
      { keepAlive: false },
    );

    try {
      await waitFor(() => fired.length >= 2, {
        timeout: 4000,
        message: "sub-minute cron did not fire twice",
      });
    } finally {
      ticker.stop();
    }

    // Every fire lands exactly on a second boundary.
    for (const when of fired) {
      expect(when.getTime() % 1000).toBe(0);
    }
    expect(fired[1].getTime() - fired[0].getTime()).toBe(1000);
  });

  it("reports the next fire time while running", () => {
    const ticker = createTicker({ every: 60_000 }, () => {}, {
      keepAlive: false,
    });

    try {
      const next = ticker.next();
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      ticker.stop();
    }
  });

  it("arms a minute-granular cron through Bun.cron", () => {
    // Nothing fires within the test; what matters is that a five-field
    // expression is accepted and reports a sane next time.
    const ticker = createTicker({ cron: "*/5 * * * *" }, () => {}, {
      keepAlive: false,
    });

    try {
      expect(ticker.next()?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      ticker.stop();
    }
  });
});
