/**
 * A UI header's live-status badge (moved from the jobs app for the security
 * UI, PR-U1): the state's text in a badge, and beside it a polite live
 * region that announces the text when the state changes — never on the
 * first render (the page load is not news) and never for a change of
 * detail alone, so a screen reader hears "Live updates: Reconnecting…" once
 * per transition rather than a stream. Each UI says what its states mean.
 */
import type { BadgeTone } from "./Badge";
import { useState } from "react";
import { Badge } from "./Badge";

/** What the badge says. */
export interface LiveStatusBadgeInfo {
  /** Short badge text. */
  text: string;
  /** Tooltip explaining it. */
  title: string;
  /** Colour. */
  tone: BadgeTone;
}

/** Props of {@link LiveStatusBadge}. */
export interface LiveStatusBadgeProps {
  /** The connection's state (`live`, `reconnecting`, …): a change is announced. */
  state: string;
  /** What to show for it. */
  info: LiveStatusBadgeInfo;
}

/** The badge; see the module's description. */
export function LiveStatusBadge({ state, info }: LiveStatusBadgeProps) {
  // What the region says, and the state it was last updated for. Adjusted
  // while rendering (not in an effect), so the announcement lands in the
  // same commit as the badge.
  const [spoken, setSpoken] = useState({ state, text: "" });
  if (spoken.state !== state) {
    setSpoken({ state, text: `Live updates: ${info.text}` });
  }
  return (
    <>
      <span
        className="live-status"
        data-testid="live-status"
        data-state={state}
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
