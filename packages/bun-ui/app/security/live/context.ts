/** The live stream's state, for the header's badge and the screens' safety polling. */
import { createContext, use } from "react";

/** How long invalidations are coalesced, ms (the jobs UI's `LIVE_INVALIDATION_DELAY_MS`). */
export const LIVE_INVALIDATION_DELAY_MS = 250;

/** The stream's state. */
export type LiveState =
  "connecting" | "live" | "reconnecting" | "refused" | "off";

/** What the live provider tells the app. */
export interface LiveStatus {
  /** The state. */
  readonly state: LiveState;
  /** Why it is not live, when there is a reason worth showing. */
  readonly detail: string | null;
}

/** The status (default: off, no provider). */
export const LiveStatusContext = createContext<LiveStatus>({
  state: "off",
  detail: null,
});

/** Options the boot passes (tests turn the stream off). */
export interface LiveOptions {
  /** `true`: no stream (screens poll). */
  readonly disabled?: boolean;
}

/** The boot's live options. */
export const LiveOptionsContext = createContext<LiveOptions | null>(null);

/** The live status. */
export function useLiveStatus(): LiveStatus {
  return use(LiveStatusContext);
}

/** How often a screen re-reads: slowly while live (a safety net), at the poll interval otherwise. */
export function useRefetchInterval(pollMs: number): number {
  const { state } = useLiveStatus();
  return state === "live" ? Math.max(pollMs * 6, 60_000) : pollMs;
}

/** The live messages a screen may listen for (the API's `GET /live` events, and `$gap` for a lost resume point). */
export type LiveMessageName =
  | "ban"
  | "ban.changed"
  | "policy.published"
  | "bundle.compiled"
  | "approval.created"
  | "approval.decided"
  | "event"
  | "more"
  | "overview"
  | "$gap";

/** The extra topics a screen may want while mounted: `events` (the activity feed, the events list), `overview` (per-second counts, PR-U2). */
export type LiveTopicKind = "events" | "overview";

/** Every extra topic kind, in the order they are subscribed. */
export const LIVE_TOPIC_KINDS: readonly LiveTopicKind[] = [
  "overview",
  "events",
];

/** A screen's listener: the message's data, as sent. */
export type LiveListener = (data: unknown) => void;

/** What the live provider offers screens beyond invalidation. */
export interface LiveFeed {
  /** Listens for a message by name; the unsubscribe. */
  readonly listen: (
    name: LiveMessageName,
    listener: LiveListener,
  ) => () => void;
  /** Asks for an extra topic on the scope while it is wanted; the release. */
  readonly want: (kind: LiveTopicKind) => () => void;
}

/** The feed (default: nothing arrives). */
export const LiveFeedContext = createContext<LiveFeed>({
  listen: () => () => {},
  want: () => () => {},
});

/**
 * Query keys (their first element) a live message never invalidates: the
 * lists that count new rows in a chip instead ("N new — show", ui.md §5),
 * so a page never reshuffles under the operator.
 */
export const LIVE_COUNTED_LISTS: ReadonlySet<string> = new Set([
  "bansList",
  "eventsList",
]);
