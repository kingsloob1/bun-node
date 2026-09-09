import { describe, expect, it } from "bun:test";
import {
  ConfigError,
  nextCronDate,
  parseCron,
  validateCron,
} from "../lib/index";

/**
 * Cron with optional seconds.
 *
 * The five-field half is not reimplemented here — it is `Bun.cron.parse` —
 * so those tests use Bun's own answer as the oracle rather than restating it.
 * What is genuinely new is the seconds field and how it composes with the
 * minute Bun picks, and that is where the specific assertions are.
 */

/** A fixed instant, so nothing here depends on when the suite runs. */
const at = (iso: string) => new Date(iso);

describe("parseCron", () => {
  it("treats five fields as Bun does, with no seconds", () => {
    const parsed = parseCron("0 3 * * *");
    expect(parsed).toEqual({
      expression: "0 3 * * *",
      seconds: null,
      minuteExpression: "0 3 * * *",
    });
  });

  it("accepts nicknames", () => {
    expect(parseCron("@hourly").seconds).toBeNull();
    expect(parseCron("@daily").minuteExpression).toBe("@daily");
  });

  it("splits six fields into seconds and the rest", () => {
    expect(parseCron("*/10 * * * * *")).toMatchObject({
      seconds: [0, 10, 20, 30, 40, 50],
      minuteExpression: "* * * * *",
    });
    expect(parseCron("0 3 * * * *").seconds).toEqual([0]);
    expect(parseCron("* * * * * *").seconds).toHaveLength(60);
  });

  it("expands lists, ranges and stepped ranges", () => {
    expect(parseCron("5,35 * * * * *").seconds).toEqual([5, 35]);
    expect(parseCron("10-13 * * * * *").seconds).toEqual([10, 11, 12, 13]);
    expect(parseCron("0-29/10 * * * * *").seconds).toEqual([0, 10, 20]);
    expect(parseCron("45/5 * * * * *").seconds).toEqual([45, 50, 55]);
    // De-duplicated and sorted, whatever order they were written in.
    expect(parseCron("30,0,30 * * * * *").seconds).toEqual([0, 30]);
  });

  it("normalises surrounding whitespace", () => {
    expect(parseCron("  */30   *  *  *  *  * ").expression).toBe(
      "*/30   *  *  *  *  *",
    );
    expect(parseCron("  0 3 * * *  ").expression).toBe("0 3 * * *");
  });

  it("keeps a pinned time zone", () => {
    expect(parseCron("0 9 * * *", { tz: "UTC" }).tz).toBe("UTC");
  });

  it("rejects what it cannot schedule", () => {
    expect(() => parseCron("")).toThrow(ConfigError);
    expect(() => parseCron("* * * * * * *")).toThrow(/7 fields/);
    expect(() => parseCron("60 * * * * *")).toThrow(/0-59/);
    expect(() => parseCron("-1 * * * * *")).toThrow(/0-59/);
    expect(() => parseCron("30-10 * * * * *")).toThrow(/0-59/);
    expect(() => parseCron("*/0 * * * * *")).toThrow(/step/);
    expect(() => parseCron("abc * * * * *")).toThrow(/0-59/);
    expect(() => parseCron("5,, * * * * *")).toThrow(/Empty entry/);
    expect(() => parseCron("* 99 * * *")).toThrow(/Invalid cron expression/);
    expect(() => parseCron("0 9 * * *", { tz: "Not/AZone" })).toThrow(
      /Invalid cron expression/,
    );
  });

  it("reports validity without throwing", () => {
    expect(validateCron("*/10 * * * * *")).toBe(true);
    expect(validateCron("@weekly")).toBe(true);
    expect(validateCron("nonsense")).toBe(false);
    expect(validateCron("70 * * * * *")).toBe(false);
  });
});

describe("nextCronDate: five-field expressions", () => {
  const from = at("2026-03-05T12:34:56.789Z");

  it.each([
    "* * * * *",
    "*/5 * * * *",
    "0 3 * * *",
    "30 9 * * MON-FRI",
    "0 0 13 * FRI",
    "@hourly",
    "@daily",
  ])("matches Bun.cron.parse for %s", (expression) => {
    expect(nextCronDate(expression, from)?.toISOString()).toBe(
      Bun.cron.parse(expression, from)?.toISOString(),
    );
  });

  it("returns null when the expression can never match", () => {
    // 30 February: Bun gives up after eight years, and so do we.
    expect(nextCronDate("0 0 30 2 *", from)).toBeNull();
  });

  it("honours a pinned time zone", () => {
    const newYork = nextCronDate("0 9 * * *", from, {
      tz: "America/New_York",
    });
    const utc = nextCronDate("0 9 * * *", from, { tz: "UTC" });

    expect(newYork?.toISOString()).toBe(
      Bun.cron
        .parse("0 9 * * *", from, { tz: "America/New_York" })
        ?.toISOString(),
    );
    expect(newYork?.getTime()).not.toBe(utc?.getTime());
  });
});

describe("nextCronDate: seconds", () => {
  it("fires on the wall-clock mark, not relative to now", () => {
    expect(
      nextCronDate(
        "*/10 * * * * *",
        at("2026-01-01T12:00:03.000Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T12:00:10.000Z");
    expect(
      nextCronDate(
        "*/10 * * * * *",
        at("2026-01-01T12:00:50.000Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T12:01:00.000Z");
  });

  it("is strictly after the given instant", () => {
    // Exactly on a mark, the next one is due — never the same instant twice.
    expect(
      nextCronDate(
        "*/10 * * * * *",
        at("2026-01-01T12:00:10.000Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T12:00:20.000Z");
    // A millisecond before, that mark is still ahead.
    expect(
      nextCronDate(
        "*/10 * * * * *",
        at("2026-01-01T12:00:09.999Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T12:00:10.000Z");
  });

  it("walks a list within the minute, then rolls over", () => {
    const expression = "5,35 * * * * *";
    expect(
      nextCronDate(expression, at("2026-01-01T12:00:00.000Z"))?.toISOString(),
    ).toBe("2026-01-01T12:00:05.000Z");
    expect(
      nextCronDate(expression, at("2026-01-01T12:00:05.000Z"))?.toISOString(),
    ).toBe("2026-01-01T12:00:35.000Z");
    expect(
      nextCronDate(expression, at("2026-01-01T12:00:35.000Z"))?.toISOString(),
    ).toBe("2026-01-01T12:01:05.000Z");
  });

  it("takes the first configured second of the next matching minute", () => {
    // The minute field only matches at :15, so seconds resume there.
    expect(
      nextCronDate(
        "20,40 15 * * * *",
        at("2026-01-01T12:16:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T13:15:20.000Z");
  });

  it("fires every second for the all-wildcard form", () => {
    expect(
      nextCronDate(
        "* * * * * *",
        at("2026-01-01T12:00:00.500Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T12:00:01.000Z");
  });

  it("matches the five-field expression when seconds are zero", () => {
    const from = at("2026-01-01T12:34:56.000Z");
    expect(nextCronDate("0 3 * * * *", from)?.toISOString()).toBe(
      nextCronDate("3 * * * *", from)?.toISOString(),
    );
    expect(nextCronDate("0 */15 * * * *", from)?.toISOString()).toBe(
      nextCronDate("*/15 * * * *", from)?.toISOString(),
    );
  });

  it("supports the forms the reference implementation used", () => {
    const from = at("2026-01-01T12:00:00.000Z");
    // Sub-minute, which the reference could only approximate with setInterval.
    expect(nextCronDate("*/10 * * * * *", from)?.toISOString()).toBe(
      "2026-01-01T12:00:10.000Z",
    );
    // Six-field with a zero seconds field, which it rewrote to five.
    expect(nextCronDate("0 0 3 * * *", from)?.toISOString()).toBe(
      "2026-01-02T03:00:00.000Z",
    );
    expect(nextCronDate("0 */15 * * * *", from)?.toISOString()).toBe(
      "2026-01-01T12:15:00.000Z",
    );
  });

  it("accepts an already-parsed expression", () => {
    const parsed = parseCron("*/30 * * * * *");
    expect(
      nextCronDate(parsed, at("2026-01-01T12:00:00.000Z"))?.toISOString(),
    ).toBe("2026-01-01T12:00:30.000Z");
  });
});
