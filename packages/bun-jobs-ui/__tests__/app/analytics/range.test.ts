import { describe, expect, it } from "bun:test";
import {
  bucketSeconds,
  defaultRange,
  describeRange,
  MAX_RANGE_MS,
  rangeBounds,
  rangeProblem,
  readRange,
  writeRange,
} from "../../../app/analytics/range";

/** A fixed clock, so a rolling preset resolves to known instants. */
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

describe("a rolling preset", () => {
  it("follows the clock rather than fixing its instants", () => {
    const range = { kind: "preset", seconds: 600 } as const;
    expect(rangeBounds(range, NOW)).toEqual({ from: NOW - 600_000, to: NOW });
    // A minute later the same range covers a minute later.
    expect(rangeBounds(range, NOW + 60_000)).toEqual({
      from: NOW - 540_000,
      to: NOW + 60_000,
    });
  });

  it("round-trips through the URL, leaving the default out", () => {
    expect(writeRange(defaultRange())).toBeNull();
    expect(readRange(null)).toEqual(defaultRange());
    expect(writeRange({ kind: "preset", seconds: 60 })).toBe("60s");
    expect(readRange("60s")).toEqual({ kind: "preset", seconds: 60 });
    // A preset nobody offers falls back rather than asking for it.
    expect(readRange("97s")).toEqual(defaultRange());
    expect(readRange("nonsense")).toEqual(defaultRange());
  });
});

describe("a custom range", () => {
  it("round-trips its instants", () => {
    const range = { kind: "custom", from: NOW - 3_600_000, to: NOW } as const;
    expect(readRange(writeRange(range)!)).toEqual(range);
    expect(rangeBounds(range, NOW + 999_999)).toEqual({
      from: range.from,
      to: range.to,
    });
  });

  it("refuses a range that is backwards, empty or absurdly long", () => {
    expect(rangeProblem(NOW, NOW - 1)).toBe("The end must be after the start.");
    expect(rangeProblem(NOW, NOW)).toBe("The end must be after the start.");
    expect(rangeProblem(NOW, NOW + 500)).toContain("shorter than a second");
    expect(rangeProblem(NOW, NOW + MAX_RANGE_MS + 1)).toContain(
      "longer than 1 day",
    );
    expect(rangeProblem(NOW, NOW + MAX_RANGE_MS)).toBeNull();
    // A deployment reporting a shorter span is what decides, not the default.
    expect(rangeProblem(NOW, NOW + 7_200_000, 3_600_000)).toContain(
      "longer than 1 hour",
    );
    expect(rangeProblem(Number.NaN, NOW)).toContain("both a start and an end");
  });

  it("falls back when the URL holds one it would refuse", () => {
    expect(readRange(`${NOW}-${NOW - 1_000}`)).toEqual(defaultRange());
  });
});

describe("what a range is read at", () => {
  it("asks for per-second buckets up to 15 minutes, per-minute beyond", () => {
    expect(bucketSeconds({ kind: "preset", seconds: 60 }, NOW)).toBe(1);
    expect(bucketSeconds({ kind: "preset", seconds: 600 }, NOW)).toBe(1);
    // 15 minutes exactly is the boundary; no preset is that long, so it is
    // expressed as a custom range.
    expect(
      bucketSeconds({ kind: "custom", from: NOW - 900_000, to: NOW }, NOW),
    ).toBe(1);
    expect(bucketSeconds({ kind: "preset", seconds: 3600 }, NOW)).toBe(60);
    expect(
      bucketSeconds({ kind: "custom", from: NOW - 60_000, to: NOW }, NOW),
    ).toBe(1);
  });

  it("describes a preset by name and a custom range by its instants", () => {
    expect(describeRange({ kind: "preset", seconds: 300 })).toBe(
      "Last 5 minutes",
    );
    const described = describeRange({
      kind: "custom",
      from: NOW - 3_600_000,
      to: NOW,
    });
    expect(described).toContain("—");
    expect(described.length).toBeGreaterThan(10);
  });
});
