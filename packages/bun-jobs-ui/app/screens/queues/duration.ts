/** A unit an age or window is typed in. */
export type DurationUnit = "minutes" | "hours" | "days";

/** Milliseconds per unit. */
export const UNIT_MS: Readonly<Record<DurationUnit, number>> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** Converts an amount in a unit to whole milliseconds (`undefined` for an empty or negative amount). */
export function toMs(
  amount: number | undefined,
  unit: DurationUnit,
): number | undefined {
  if (amount === undefined || !Number.isFinite(amount) || amount < 0) {
    return undefined;
  }
  return Math.round(amount * UNIT_MS[unit]);
}

/** Formats milliseconds compactly: `90000` → `1m 30s`, `3600000` → `1h`. */
export function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [size, suffix] of [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${suffix}`);
      rest %= size;
    }
  }
  return parts.join(" ");
}

/** A rate window as typed: all digits is milliseconds, anything else a duration phrase the API parses (`"1 minute"`). */
export function parseWindow(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}
