import type { LiveClient, LiveClientOptions } from "./client";
import { createContext } from "react";

/** What `LiveProvider` gives the hooks. */
export interface LiveContextValue {
  /** The one client, or `null` when live updates are off. */
  client: LiveClient | null;
  /** Why live updates are off, when `client` is `null`. */
  offDetail: string | null;
  /** A note to show while live (e.g. `events: "local"`), or `null`. */
  liveNote: string | null;
  /** `meta.events`. */
  events: "push" | "poll" | "local";
  /** `meta.publishing`. */
  publishing: boolean | null;
}

/** Carries the live client and what the status needs from `/meta`. */
export const LiveContext = createContext<LiveContextValue | null>(null);

/**
 * Overrides for the client `LiveProvider` builds: a socket constructor,
 * timers, backoff. For tests and embedding; the app provides none.
 */
export type LiveClientOverrides = Partial<Omit<LiveClientOptions, "url">>;

/** What {@link LiveOptionsContext} carries: client overrides, or live updates switched off. */
export interface LiveOptions extends LiveClientOverrides {
  /**
   * Keep live updates off (status `"off"`), whatever `/meta` says: for tests
   * that render the whole app with no server to connect to. Defaults to `false`.
   */
  disabled?: boolean;
}

/** Carries {@link LiveOptions} to `LiveProvider`. */
export const LiveOptionsContext = createContext<LiveOptions | null>(null);

/** Shown while live when the API sees only its own process's events (`events: "local"`). */
export const LOCAL_EVENTS_NOTE =
  "Only this API process's events are seen: workers in other processes are not";
