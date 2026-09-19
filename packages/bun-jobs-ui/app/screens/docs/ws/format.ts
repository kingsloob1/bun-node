import { formatNumber } from "../../../format";

/**
 * How the limits panel reads each `x-bun-jobs-limits` entry: a label, what it
 * means, and its unit. A limit the document adds later is still listed, by
 * its name, as a plain number.
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

/** The known limits. */
export const LIMIT_INFO: Readonly<Record<string, LimitInfo>> = {
  maxMessageBytes: {
    label: "Largest client frame",
    meaning:
      "A bigger frame is refused MESSAGE_TOO_LARGE, then the socket closes 1009.",
    unit: "bytes",
  },
  messagesPerSecond: {
    label: "Client frames per second",
    meaning: "The sustained rate; over it, a RATE_LIMITED error.",
    unit: "per-second",
  },
  rateLimitBurst: {
    label: "Rate-limit burst",
    meaning: "Frames that may be sent at once before the rate applies.",
    unit: "count",
  },
  rateLimitBreachWindowMs: {
    label: "Breach window",
    meaning: "A second rate-limit breach within it closes the socket 1008.",
    unit: "ms",
  },
  maxSubscriptions: {
    label: "Subscriptions per connection",
    meaning:
      "Channels one connection may hold; more are refused SUBSCRIPTION_LIMIT.",
    unit: "count",
  },
  maxChannelsPerFrame: {
    label: "Channels per frame",
    meaning:
      "Channels one subscribe or unsubscribe may list: send more in several frames.",
    unit: "count",
  },
  maxConnections: {
    label: "Connections",
    meaning:
      "Open connections the API accepts; the next upgrade is refused 429 CONNECTION_LIMIT.",
    unit: "count",
  },
  heartbeatMs: {
    label: "Heartbeat",
    meaning: "How often a heartbeat is sent to an idle connection.",
    unit: "ms",
  },
  maxBufferedBytes: {
    label: "Send buffer",
    meaning:
      "Unsent bytes past which a connection is behind and stops receiving events.",
    unit: "bytes",
  },
  slowConsumerTimeoutMs: {
    label: "Slow-consumer timeout",
    meaning: "How long a connection may stay behind before it is closed 4008.",
    unit: "ms",
  },
  coalesceProgressMs: {
    label: "Progress coalescing",
    meaning: "A job's progress events are merged to at most one per interval.",
    unit: "ms",
  },
};

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

/** A limit's value in its unit. */
export function formatLimit(name: string, value: number): string {
  switch (LIMIT_INFO[name]?.unit) {
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
