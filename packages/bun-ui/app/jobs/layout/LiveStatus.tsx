import { useState } from "react";
import { Badge } from "../components/Badge";
import { useUiConfig } from "../context";
import { useLiveStatus } from "../live";
import { liveStatusInfo } from "./liveStatusInfo";

/**
 * The header's live-status badge: live, connecting, reconnecting, or polling
 * (see {@link liveStatusInfo}).
 *
 * Beside it, a polite live region announces the badge's text when the
 * connection's state changes — never on the first render (the page load is
 * not news) and never for a change of detail alone, so a screen reader hears
 * "Live updates: Reconnecting…" once per transition rather than a stream.
 */
export function LiveStatus() {
  const status = useLiveStatus();
  const { sections } = useUiConfig();
  const info = liveStatusInfo(status, { docsOnly: !sections.manage });
  // What the region says, and the state it was last updated for. Adjusted
  // while rendering (not in an effect), so the announcement lands in the
  // same commit as the badge.
  const [spoken, setSpoken] = useState({ state: status.state, text: "" });
  if (spoken.state !== status.state) {
    setSpoken({ state: status.state, text: `Live updates: ${info.text}` });
  }

  return (
    <>
      <span
        className="live-status"
        data-testid="live-status"
        data-state={status.state}
      >
        <Badge
          tone={info.tone}
          title={info.title}
        >
          <span
            className="live-dot"
            aria-hidden="true"
          />
          {info.text}
        </Badge>
      </span>
      <span
        className="visually-hidden"
        aria-live="polite"
        data-testid="live-status-announcer"
      >
        {spoken.text}
      </span>
    </>
  );
}
