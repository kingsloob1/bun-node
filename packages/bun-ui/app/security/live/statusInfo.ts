/** What the header's live badge says for each state. */
import type { LiveStatusBadgeInfo } from "../../kit/components/LiveStatusBadge";
import type { LiveStatus } from "./context";
import { POLL_INTERVAL_MS } from "../queryClient";

/** The badge's text, title and tone for `status`. */
export function liveStatusInfo(status: LiveStatus): LiveStatusBadgeInfo {
  const seconds = Math.round(POLL_INTERVAL_MS / 1000);
  const detail = status.detail === null ? "" : ` (${status.detail})`;
  switch (status.state) {
    case "live":
      return {
        text: "Live",
        title:
          "Live updates are on: bans and policy changes refresh the screen as they happen.",
        tone: "success",
      };
    case "connecting":
      return {
        text: "Connecting…",
        title: `Connecting to live updates; until then the screen refreshes every ${seconds} seconds.`,
        tone: "info",
      };
    case "reconnecting":
      return {
        text: "Reconnecting…",
        title: `Live updates dropped and will reconnect; meanwhile the screen refreshes every ${seconds} seconds${detail}.`,
        tone: "warning",
      };
    case "refused":
      return {
        text: `Polling ${seconds}s`,
        title: `The API refused live updates${detail}; the screen refreshes every ${seconds} seconds.`,
        tone: "warning",
      };
    case "off":
      return {
        text: `Polling ${seconds}s`,
        title: `Live updates are off; the screen refreshes every ${seconds} seconds.`,
        tone: "neutral",
      };
  }
}
