import type { BadgeTone } from "../components/Badge";
import { POLL_INTERVAL_MS } from "../queryClient";

/** What the live-status badge says, derived from `/meta`. */
export interface LiveStatusInfo {
  /** Short badge text. */
  text: string;
  /** Tooltip explaining it. */
  title: string;
  /** Colour. */
  tone: BadgeTone;
}

/** Explanations of each `meta.events` value (contract §4.7). */
const EVENTS_EXPLAINED = {
  push: "events are pushed across processes (near real time)",
  poll: "events are read from the backend on an interval, across processes",
  local: "events are only seen from the API's own process",
} as const;

/**
 * The badge's content. Milestone 1 has no socket client, so the screens poll;
 * the badge says so, and reports what `/meta` says about events and whether
 * producers publish them (`null` → "unknown").
 */
export function liveStatusInfo(
  events: "push" | "poll" | "local",
  publishing: boolean | null,
): LiveStatusInfo {
  const seconds = Math.round(POLL_INTERVAL_MS / 1000);
  const publishingText =
    publishing === null ? "unknown" : publishing ? "yes" : "no";
  const warn = events === "local" || publishing === false;
  return {
    text: `Polling ${seconds}s · events: ${events} · publishing: ${publishingText}`,
    title: `Live updates are off; screens refresh every ${seconds} seconds. The backend reports that ${EVENTS_EXPLAINED[events]}. Producers publishing events: ${publishingText}.`,
    tone: warn ? "warning" : "neutral",
  };
}
