/** Screens' hooks on the live feed: listening, wanting a topic, and counting new rows. */
import type { LiveListener, LiveMessageName, LiveTopicKind } from "./context";
import { use, useEffect, useRef, useState } from "react";
import { LiveFeedContext } from "./context";

/** Calls `listener` for each message named in `names` while mounted. */
export function useLiveMessages(
  names: readonly LiveMessageName[],
  listener: LiveListener,
): void {
  const feed = use(LiveFeedContext);
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  const key = names.join(",");
  useEffect(() => {
    const offs = key
      .split(",")
      .map((name) =>
        feed.listen(name as LiveMessageName, (data) => latest.current(data)),
      );
    return () => {
      for (const off of offs) off();
    };
  }, [feed, key]);
}

/** Subscribes the stream to the scope's `kind` topic (`events:<scope>`, `overview:<scope>`) while mounted and `enabled`. */
export function useLiveTopic(kind: LiveTopicKind, enabled = true): void {
  const feed = use(LiveFeedContext);
  useEffect(
    () => (enabled ? feed.want(kind) : undefined),
    [feed, kind, enabled],
  );
}

/**
 * Counts the live messages named in `names` that `matches` accepts, for a
 * list's "N new — show" chip; `reset` zeroes it (when the list is
 * refetched).
 */
export function useNewCount(
  names: readonly LiveMessageName[],
  matches: (data: unknown) => boolean = () => true,
): { count: number; reset: () => void } {
  const [count, setCount] = useState(0);
  useLiveMessages(names, (data) => {
    if (matches(data)) setCount((n) => n + 1);
  });
  return { count, reset: () => setCount(0) };
}
