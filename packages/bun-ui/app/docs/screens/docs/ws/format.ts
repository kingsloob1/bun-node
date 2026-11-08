import { formatNumber } from "../../../format";

/**
 * How the limits panel reads each `<prefix>-limits` entry. A limit's unit is
 * read from its name's suffix (`…Bytes`, `…Ms`, `…PerSecond`); a viewer
 * embedding this reference can pass a {@link LimitInfo} per name for a label
 * and a meaning instead (bun-jobs-ui does, for its own vocabulary).
 */

/** A limit's unit. */
export type LimitUnit = "bytes" | "ms" | "count" | "per-second";

/** How one limit reads. */
export interface LimitInfo {
  /** Its label. */
  label: string;
  /** What it means. */
  meaning: string;
  /** Its unit. */
  unit: LimitUnit;
}

/** A limit's unit from its name: `maxMessageBytes` → bytes, `heartbeatMs` → ms, `messagesPerSecond` → per-second, anything else a count. */
export function limitUnit(name: string): LimitUnit {
  if (/bytes$/i.test(name)) {
    return "bytes";
  }
  if (/ms$/i.test(name)) {
    return "ms";
  }
  if (/persecond$/i.test(name)) {
    return "per-second";
  }
  return "count";
}

/** `1,048,576 bytes (1 MiB)`. */
export function formatBytes(value: number): string {
  const units = ["KiB", "MiB", "GiB"];
  let scaled = value;
  let unit = "";
  for (const next of units) {
    if (scaled < 1024 || scaled % 1024 !== 0) {
      break;
    }
    scaled /= 1024;
    unit = next;
  }
  return unit === ""
    ? `${formatNumber(value)} bytes`
    : `${formatNumber(value)} bytes (${formatNumber(scaled)} ${unit})`;
}

/** `25,000 ms (25 s)`, `300,000 ms (5 min)`. */
export function formatMs(value: number): string {
  const plain = `${formatNumber(value)} ms`;
  if (value >= 60_000 && value % 60_000 === 0) {
    return `${plain} (${formatNumber(value / 60_000)} min)`;
  }
  if (value >= 1000 && value % 1000 === 0) {
    return `${plain} (${formatNumber(value / 1000)} s)`;
  }
  return plain;
}

/** A limit's value in its unit: `info`'s when given, else the name's suffix. */
export function formatLimit(
  name: string,
  value: number,
  info?: LimitInfo,
): string {
  switch (info?.unit ?? limitUnit(name)) {
    case "bytes":
      return formatBytes(value);
    case "ms":
      return formatMs(value);
    case "per-second":
      return `${formatNumber(value)} / s`;
    default:
      return formatNumber(value);
  }
}
