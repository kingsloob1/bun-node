import { describe, expect, it } from "bun:test";
import { ApiError } from "../../../../app/api/errors";
import {
  cronShapeError,
  emptyScheduleForm,
  formFromSchedule,
  intervalMs,
  invalidScheduleErrors,
  isValidTimeZone,
  scheduleBody,
  scheduleFieldErrors,
  splitInterval,
  validateScheduleForm,
} from "../../../../app/screens/runners/actions/schedule";

const ZONES = ["UTC", "Europe/London", "America/New_York"];

describe("formFromSchedule (prefill)", () => {
  it("prefills a cron schedule with its time zone", () => {
    expect(formFromSchedule({ cron: "0 3 * * *", tz: "UTC" })).toMatchObject({
      mode: "cron",
      cron: "0 3 * * *",
      tz: "UTC",
    });
    expect(formFromSchedule({ cron: "@daily" }).tz).toBe("");
  });

  it("prefills an interval in the largest exact unit, with its anchor", () => {
    expect(formFromSchedule({ every: 7_200_000, anchor: 1_000 })).toMatchObject(
      { mode: "every", everyAmount: 2, everyUnit: "hours", anchor: 1_000 },
    );
    expect(formFromSchedule({ every: 90_000 })).toMatchObject({
      everyAmount: 90,
      everyUnit: "seconds",
      anchor: undefined,
    });
    expect(formFromSchedule({ every: 300_000 })).toMatchObject({
      everyAmount: 5,
      everyUnit: "minutes",
    });
  });

  it("prefills a one-off time", () => {
    expect(formFromSchedule({ at: 1_789_730_520_000 })).toMatchObject({
      mode: "at",
      at: 1_789_730_520_000,
    });
  });

  it("prefills none for no schedule", () => {
    expect(formFromSchedule(null)).toEqual(emptyScheduleForm("none"));
  });
});

describe("interval conversion", () => {
  it("converts each unit to ms", () => {
    expect(intervalMs(30, "seconds")).toBe(30_000);
    expect(intervalMs(5, "minutes")).toBe(300_000);
    expect(intervalMs(1, "hours")).toBe(3_600_000);
    expect(intervalMs(1.5, "seconds")).toBe(1_500);
  });

  it("refuses empty, zero, negative and sub-millisecond amounts", () => {
    expect(intervalMs(undefined, "minutes")).toBeUndefined();
    expect(intervalMs(0, "minutes")).toBeUndefined();
    expect(intervalMs(-1, "minutes")).toBeUndefined();
    expect(intervalMs(0.0001, "seconds")).toBeUndefined();
    expect(intervalMs(Number.NaN, "seconds")).toBeUndefined();
  });

  it("splits a sub-second interval as fractional seconds", () => {
    expect(splitInterval(1_500)).toEqual({ amount: 1.5, unit: "seconds" });
  });
});

describe("scheduleBody", () => {
  it("sends { cron, tz }, dropping an empty tz and trimming", () => {
    const form = { ...emptyScheduleForm("cron"), cron: " 0 9 * * 1 " };
    expect(scheduleBody(form)).toEqual({ cron: "0 9 * * 1" });
    expect(scheduleBody({ ...form, tz: " Europe/London " })).toEqual({
      cron: "0 9 * * 1",
      tz: "Europe/London",
    });
  });

  it("sends { every } in ms with an optional anchor", () => {
    const form = {
      ...emptyScheduleForm("every"),
      everyAmount: 1,
      everyUnit: "hours" as const,
    };
    expect(scheduleBody(form)).toEqual({ every: 3_600_000 });
    expect(scheduleBody({ ...form, anchor: 42 })).toEqual({
      every: 3_600_000,
      anchor: 42,
    });
  });

  it("sends { at } in epoch ms", () => {
    expect(scheduleBody({ ...emptyScheduleForm("at"), at: 99 })).toEqual({
      at: 99,
    });
  });

  it("sends null for none, which unschedules", () => {
    expect(scheduleBody(emptyScheduleForm("none"))).toBeNull();
  });

  it("round-trips every stored form", () => {
    for (const schedule of [
      { cron: "*/10 * * * * *", tz: "UTC" },
      { every: 60_000, anchor: 5 },
      { at: 123 },
      null,
    ]) {
      expect(scheduleBody(formFromSchedule(schedule))).toEqual(schedule);
    }
  });
});

describe("time zones", () => {
  it("accepts listed zones, case-insensitively", () => {
    expect(isValidTimeZone("Europe/London", ZONES)).toBe(true);
    expect(isValidTimeZone("utc", ZONES)).toBe(true);
  });

  it("accepts an alias the list leaves out but Intl knows (as Bun.cron does)", () => {
    expect(isValidTimeZone("US/Eastern", ZONES)).toBe(true);
  });

  it("refuses unknown names and UTC offsets", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons", ZONES)).toBe(false);
    expect(isValidTimeZone("+01:00", ZONES)).toBe(false);
    expect(isValidTimeZone("", ZONES)).toBe(false);
  });

  it("still validates without Intl.supportedValuesOf", () => {
    expect(isValidTimeZone("Europe/Paris", null)).toBe(true);
    expect(isValidTimeZone("Nowhere/Land", null)).toBe(false);
  });
});

describe("validateScheduleForm", () => {
  it("checks the cron shape: 5 or 6 fields, or a nickname", () => {
    expect(cronShapeError("0 3 * * *")).toBeNull();
    expect(cronShapeError("*/10 * * * * *")).toBeNull();
    expect(cronShapeError("@hourly")).toBeNull();
    expect(cronShapeError("")).toBe("Enter a cron expression.");
    expect(cronShapeError("0 3 *")).toContain("3 fields");
    expect(cronShapeError("1 2 3 4 5 6 7")).toContain("7 fields");
    expect(cronShapeError("x".repeat(201))).toBe("At most 200 characters.");
  });

  it("flags an unknown time zone on the tz field", () => {
    const errors = validateScheduleForm(
      { ...emptyScheduleForm("cron"), cron: "0 3 * * *", tz: "Mars/Base" },
      ZONES,
    );
    expect(errors).toEqual({
      tz: "“Mars/Base” is not a known time zone. Use an IANA name such as Europe/London or UTC.",
    });
  });

  it("needs a positive interval, and a time for a one-off", () => {
    expect(validateScheduleForm(emptyScheduleForm("every"), ZONES)).toEqual({
      every: "Enter an interval greater than zero.",
    });
    expect(validateScheduleForm(emptyScheduleForm("at"), ZONES)).toEqual({
      at: "Pick a date and time.",
    });
    expect(validateScheduleForm(emptyScheduleForm("none"), ZONES)).toEqual({});
  });

  it("only checks the chosen mode", () => {
    const form = { ...emptyScheduleForm("none"), cron: "bad", tz: "Bad/Zone" };
    expect(validateScheduleForm(form, ZONES)).toEqual({});
  });
});

describe("server errors onto fields", () => {
  it("reads INVALID_SCHEDULE's issues as field errors, by path", () => {
    const error = new ApiError({
      kind: "problem",
      status: 400,
      code: "INVALID_SCHEDULE",
      title: "Invalid schedule",
      detail: "Bun.cron: unknown time zone 'Mars/Base'",
      issues: [
        { target: "body", path: "schedule.tz", message: "unknown time zone" },
      ],
    });
    expect(invalidScheduleErrors(error)).toEqual({
      "schedule.tz": "unknown time zone",
    });
    expect(
      scheduleFieldErrors(invalidScheduleErrors(error), "cron").fields,
    ).toEqual({ tz: "unknown time zone" });
  });

  it("reads nothing from an issue-less INVALID_SCHEDULE, or another error", () => {
    const bare = new ApiError({
      kind: "problem",
      status: 400,
      code: "INVALID_SCHEDULE",
      title: "Invalid schedule",
      detail: "Bun.cron: unknown time zone 'Mars/Base'",
    });
    expect(invalidScheduleErrors(bare)).toEqual({});
    expect(invalidScheduleErrors(new Error("boom"))).toEqual({});
    const other = new ApiError({
      kind: "problem",
      status: 400,
      code: "VALIDATION",
      title: "Validation failed",
      issues: [{ target: "body", path: "schedule.tz", message: "x" }],
    });
    expect(invalidScheduleErrors(other)).toEqual({});
  });

  it("maps VALIDATION paths onto fields, a bare path onto the mode's field", () => {
    expect(
      scheduleFieldErrors(
        { "schedule.tz": "too long", schedule: "no match" },
        "cron",
      ),
    ).toEqual({
      fields: { tz: "too long", cron: "no match" },
      other: undefined,
    });
    expect(scheduleFieldErrors({ schedule: "bad" }, "none")).toEqual({
      fields: {},
      other: "bad",
    });
  });
});
