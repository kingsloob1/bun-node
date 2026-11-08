import type { BadgeTone } from "../components/Badge";
import type { LiveStatus } from "../live";
import { POLL_INTERVAL_MS } from "../queryClient";

/** What the live-status badge says. */
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

/** Options of {@link liveStatusInfo}. */
export interface LiveStatusInfoOptions {
  /** The UI shows documentation only (`sections.manage` off): the badge says "Live off". Defaults to `false`. */
  docsOnly?: boolean;
}

/**
 * The badge's content, from the live client's status: `Live`,
 * `Connecting…`, `Reconnecting…`, or `Polling Ns` when there is no socket
 * (off) or the server refused it. A backend whose events are only its own
 * process's (`events: "local"`), or whose producers do not publish
 * (`publishing: false`), is a warning in every state, and the text says why.
 */
export function liveStatusInfo(
  status: LiveStatus,
  options: LiveStatusInfoOptions = {},
): LiveStatusInfo {
  if (options.docsOnly) {
    // No screen here uses live updates or polls, so neither the poll period
    // nor the backend's event warnings mean anything.
    return {
      text: "Live off",
      title:
        "Live updates are off: this UI shows documentation only, and nothing on it refreshes.",
      tone: "neutral",
    };
  }
  const seconds = Math.round(POLL_INTERVAL_MS / 1000);
  const { events, publishing } = status;
  const publishingText =
    publishing === null ? "unknown" : publishing ? "yes" : "no";
  const warnings = [
    ...(events === "local" ? ["events: local"] : []),
    ...(publishing === false ? ["publishing: no"] : []),
  ];
  const backend = `The backend reports that ${EVENTS_EXPLAINED[events]}. Producers publishing events: ${publishingText}.`;
  const detail = status.detail ? ` ${sentence(status.detail)}` : "";
  const suffix = warnings.length > 0 ? ` · ${warnings.join(" · ")}` : "";
  const warn = warnings.length > 0;

  switch (status.state) {
    case "live":
      return {
        text: `Live${suffix}`,
        title: `Live updates are on: events from the API's socket refresh the screens as things change, with a slow poll as a safety net. ${backend}`,
        tone: warn ? "warning" : "success",
      };
    case "connecting":
      return {
        text: `Connecting…${suffix}`,
        title: `Connecting to the API's live updates; until then, screens refresh every ${seconds} seconds. ${backend}`,
        tone: warn ? "warning" : "info",
      };
    case "reconnecting":
      return {
        text: `Reconnecting…${suffix}`,
        title: `Live updates dropped and will reconnect; meanwhile screens refresh every ${seconds} seconds.${detail} ${backend}`,
        tone: "warning",
      };
    case "refused":
      return {
        text: `Polling ${seconds}s${suffix}`,
        title: `The API refused live updates; screens refresh every ${seconds} seconds. Reload to try again.${detail} ${backend}`,
        tone: "warning",
      };
    case "off":
      return {
        text: `Polling ${seconds}s${suffix}`,
        title: `Live updates are off; screens refresh every ${seconds} seconds.${detail} ${backend}`,
        tone: warn ? "warning" : "neutral",
      };
  }
}

/** `text` ending in a full stop. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}
