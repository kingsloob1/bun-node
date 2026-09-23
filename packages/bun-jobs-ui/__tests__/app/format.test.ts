import { describe, expect, it } from "bun:test";
import { formatBytes, formatNumber } from "../../app/format";

/**
 * The shared formatters in `app/format.ts`. No DOM: they are pure functions
 * of a number, so this file registers none (see `domLeak.test.ts`).
 */

describe("formatBytes", () => {
  it("prints whole bytes below a kilobyte, zero included", () => {
    // Zero is a measurement, not a missing value: it must not read "—".
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(912)).toBe("912 B");
    expect(formatBytes(1023)).toBe("1,023 B");
  });

  it("steps to the largest 1024-based unit that fits, with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    // 268,435,456 B — the fixture's worker: a quarter of a gibibyte.
    expect(formatBytes(268_435_456)).toBe("256.0 MiB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TiB");
    // It stops at the last unit rather than inventing one.
    expect(formatBytes(1024 ** 6)).toBe("1,024.0 PiB");
  });

  it("rounds to one decimal, and rounding up does not change the unit", () => {
    expect(formatBytes(1_500_000)).toBe("1.4 MiB");
    expect(formatBytes(2_147_000_000)).toBe("2.0 GiB");
    // 1023.9 KiB rounds to 1024.0 KiB rather than silently becoming 1.0 MiB.
    expect(formatBytes(Math.round(1023.94 * 1024))).toBe("1,023.9 KiB");
  });

  it("gives the fallback — never a figure — for a size it was not given", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(undefined, "unknown")).toBe("unknown");
  });
});

describe("formatNumber", () => {
  it("groups a count", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1_234_567)).toBe("1,234,567");
  });
});
