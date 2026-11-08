import type { LimitInfo } from "@kingsleyweb/bun-api-docs-ui/embed";

/**
 * How the limits panel reads each `x-bun-jobs-limits` entry: a label, what it
 * means, and its unit. The vocabulary is this API's own; the rendering is the
 * package's (`wsFormat.formatLimit`), with this as its `limitsInfo`.
 */

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
