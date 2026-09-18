import type { EventName } from "@kingsleyweb/bun-jobs/api/contract";
/**
 * Live updates over the API's WebSocket: the contract between the socket
 * client (this directory) and the screens that use it.
 *
 * One socket (`LiveProvider`, over a {@link LiveClient}) is shared by every
 * screen: each holds the channels it needs, the client refcounts them and
 * merges filters, and events are hints that invalidate queries. Outside a
 * `LiveProvider` everything reports `"off"` and polling is unchanged.
 */
import type { QueryKey } from "@tanstack/react-query";
import type {
  EventWire,
  JobsApiAckRejection,
  JobsApiGapMessage,
} from "../api/types";
import type { LiveClientSnapshot } from "./client";
import { encodeJobId } from "@kingsleyweb/bun-jobs/api/contract";
import { useQueryClient } from "@tanstack/react-query";
import {
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { LiveContext } from "./context";

/**
 * Where live updates stand:
 * - `"off"`: no socket (the API has none, `events.connect` is refused, or the
 *   events are only this process's (`events: "local"`) and nothing publishes);
 * - `"connecting"`: the first connection is being made;
 * - `"live"`: connected and subscribed;
 * - `"reconnecting"`: the connection dropped, a retry is scheduled;
 * - `"refused"`: the server refused the socket (a close or a failed upgrade
 *   it will keep refusing); no more retries until reload.
 */
export type LiveState =
  | "off"
  | "connecting"
  | "live"
  | "reconnecting"
  | "refused";

/** What the header badge and the polling fallback read. */
export interface LiveStatus {
  /** See {@link LiveState}. */
  state: LiveState;
  /** Why it is `"off"`, `"reconnecting"` or `"refused"`, in words; `null` when live. */
  detail: string | null;
  /** `meta.events`: how events reach the API (`"local"` = only its own process). */
  events: "push" | "poll" | "local";
  /** `meta.publishing`: whether producers publish events (`null` = unknown). */
  publishing: boolean | null;
  /** When the last event frame arrived, epoch ms; `null` before any. */
  lastEventAt: number | null;
}

/** One screen's interest in some channels. */
export interface LiveSubscription {
  /** Channel names, from {@link liveChannels}. Refcounted across the app: several screens may hold one. */
  channels: readonly string[];
  /** Only these event types, on these channels. Omitted: all. Filters of screens sharing a channel are merged. */
  events?: readonly EventName[];
  /** Called for each event on these channels (after de-duplication). */
  onEvent?: (event: EventWire) => void;
  /** Called when the server reports a gap on these channels (events were lost: refetch). */
  onGap?: (gap: JobsApiGapMessage) => void;
  /** Subscribe only while `true`. Defaults to `true`. */
  enabled?: boolean;
}

/** Channel names (AsyncAPI `x-bun-jobs` channel families). */
export const liveChannels = {
  /** Every event (mode `both` only). */
  all: "all",
  /** Every queue event. */
  queues: "queues",
  /** Every runner event. */
  runners: "runners",
  /** One queue's events. */
  queue: (queue: string) => `queue/${queue}`,
  /** One job's events; the id is encoded as the server names it. */
  job: (queue: string, id: string) => `queue/${queue}/job/${encodeJobId(id)}`,
  /** One runner's events. */
  runner: (runner: string) => `runner/${runner}`,
} as const;

/** How long events and gaps are gathered before one invalidation, in ms. */
export const LIVE_INVALIDATION_DELAY_MS = 250;

/** The slowest a live screen still polls, as a safety net, in ms. */
export const LIVE_SAFETY_POLL_MS = 60_000;

/** The client status outside a provider, or with no client. */
const OFF_SNAPSHOT: LiveClientSnapshot = {
  state: "off",
  detail: null,
  lastEventAt: null,
};

/** No rejections, one stable array. */
const NO_REJECTIONS: readonly JobsApiAckRejection[] = [];

/** A subscribe function for no store. */
const noSubscribe = () => () => {};

/** The client's snapshot, re-rendering on change; the "off" one without a client. */
function useClientSnapshot(): LiveClientSnapshot {
  const client = use(LiveContext)?.client ?? null;
  return useSyncExternalStore(
    client?.subscribe ?? noSubscribe,
    client ? client.getSnapshot : () => OFF_SNAPSHOT,
    client ? client.getSnapshot : () => OFF_SNAPSHOT,
  );
}

/** Just the state, so a component re-renders on a state change and not on every event. */
function useLiveState(): LiveState {
  const client = use(LiveContext)?.client ?? null;
  return useSyncExternalStore(
    client?.subscribe ?? noSubscribe,
    () => (client ? client.getSnapshot().state : "off"),
    () => (client ? client.getSnapshot().state : "off"),
  );
}

/** Where live updates stand. */
export function useLiveStatus(): LiveStatus {
  const context = use(LiveContext);
  const snapshot = useClientSnapshot();
  return useMemo((): LiveStatus => {
    if (!context) {
      return {
        state: "off",
        detail: "Live updates are not available here",
        events: "local",
        publishing: null,
        lastEventAt: null,
      };
    }
    const detail = !context.client
      ? context.offDetail
      : snapshot.state === "live"
        ? (snapshot.detail ?? context.liveNote)
        : snapshot.detail;
    return {
      state: context.client ? snapshot.state : "off",
      detail,
      events: context.events,
      publishing: context.publishing,
      lastEventAt: snapshot.lastEventAt,
    };
  }, [context, snapshot]);
}

/** Holds a subscription for the component's lifetime; returns the channels the server rejected. */
export function useLiveSubscription(subscription: LiveSubscription): {
  /** Channels the server refused (bad name, not permitted, limit), with why. */
  rejected: readonly JobsApiAckRejection[];
} {
  const client = use(LiveContext)?.client ?? null;
  // The callbacks are read through a ref, so a re-render with new closures
  // does not resubscribe.
  const callbacksRef = useRef(subscription);
  useLayoutEffect(() => {
    callbacksRef.current = subscription;
  });

  const enabled = subscription.enabled !== false;
  const channelsKey = subscription.channels.join("\n");
  const eventsKey = subscription.events?.join(",");
  // Rejections belong to one hold: a changed subscription starts clean.
  const holdKey = `${enabled}|${eventsKey ?? "*"}|${channelsKey}`;
  const [reported, setReported] = useState<{
    /** The hold they were reported for. */
    key: string;
    /** The rejections. */
    rejected: readonly JobsApiAckRejection[];
  }>({ key: holdKey, rejected: NO_REJECTIONS });

  useEffect(() => {
    if (!client || !enabled || channelsKey === "") {
      return;
    }
    const hold = client.hold({
      channels: channelsKey.split("\n"),
      ...(eventsKey === undefined
        ? {}
        : {
            events: eventsKey.split(",") as NonNullable<
              LiveSubscription["events"]
            >,
          }),
      onEvent: (event) => callbacksRef.current.onEvent?.(event),
      onGap: (gap) => callbacksRef.current.onGap?.(gap),
      onRejected: (rejected) =>
        setReported({
          key: `${enabled}|${eventsKey ?? "*"}|${channelsKey}`,
          rejected,
        }),
    });
    return () => hold.release();
  }, [client, enabled, channelsKey, eventsKey]);

  const rejected =
    client && reported.key === holdKey ? reported.rejected : NO_REJECTIONS;
  return { rejected };
}

/**
 * Invalidates `keys` when an event arrives on `channels` (coalesced, about
 * 250 ms) or a gap is reported. The screens' one-line way to be live.
 */
export function useLiveInvalidation(
  channels: readonly string[],
  keys: readonly QueryKey[],
  options: {
    /** Only these event types trigger it. Omitted: all. */
    events?: readonly EventName[];
    /** Subscribe only while `true`. Defaults to `true`. */
    enabled?: boolean;
  } = {},
): void {
  const queryClient = useQueryClient();
  const keysRef = useRef(keys);
  useLayoutEffect(() => {
    keysRef.current = keys;
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    },
    [],
  );

  const schedule = () => {
    if (timerRef.current !== undefined) {
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      for (const queryKey of keysRef.current) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }, LIVE_INVALIDATION_DELAY_MS);
  };

  useLiveSubscription({
    channels,
    ...(options.events ? { events: options.events } : {}),
    enabled: options.enabled,
    onEvent: schedule,
    onGap: schedule,
  });
}

/**
 * The refetch interval to use given live updates: `base` while not live; while
 * live, a slow safety net (events are hints, and pub/sub is at-most-once), or
 * `false` when `base` is `false`.
 */
export function usePollInterval(base: number | false): number | false {
  const state = useLiveState();
  const publishing = use(LiveContext)?.publishing;
  return pollInterval(base, state === "live" && publishing !== false);
}

/** {@link usePollInterval}'s rule: `base`, or while live `false` / `max(base × 6, 60 s)`. */
export function pollInterval(
  base: number | false,
  live: boolean,
): number | false {
  if (!live || base === false) {
    return base;
  }
  return Math.max(base * 6, LIVE_SAFETY_POLL_MS);
}
