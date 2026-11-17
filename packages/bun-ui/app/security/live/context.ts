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
