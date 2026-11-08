import { useSyncExternalStore } from "react";

/**
 * One app-wide clock for relative times. However many components show
 * "3m ago", there is a single `setInterval`, started with the first
 * subscriber and stopped with the last, so a table of 500 rows does not
 * run 500 timers.
 */

/** How often the shared clock ticks, ms. */
export const NOW_TICK_MS = 10_000;

/** Subscribers to the clock. */
const listeners = new Set<() => void>();
/** The time every subscriber reads, updated on each tick. */
let now = Date.now();
/** The one interval, while anything subscribes. */
let timer: ReturnType<typeof setInterval> | null = null;

/** Advances the shared time and tells every subscriber. */
function tick(): void {
  now = Date.now();
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribes to the clock; starts it for the first subscriber, stops it after the last. */
function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    // The clock was idle: refresh before anyone reads a stale time.
    now = Date.now();
    timer = setInterval(tick, NOW_TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current shared time. */
function getSnapshot(): number {
  return now;
}

/** The current time, epoch ms, re-rendering every {@link NOW_TICK_MS} on the shared clock. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** How many components are on the shared clock, and whether its timer runs. For tests. */
export function sharedClockState(): { subscribers: number; running: boolean } {
  return { subscribers: listeners.size, running: timer !== null };
}
