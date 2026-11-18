/**
 * An events list's count of new events (ui.md §5): live `event` messages
 * on the scope's activity feed (`events:<scope>`, subscribed while the list
 * is mounted) that the list's filter would show are counted, never
 * inserted, so the page never reshuffles under the operator. `show` goes
 * to the first page and reads it again. A `gap` (messages were lost)
 * cannot be counted: it is reported so the chip can say new events may
 * have arrived.
 */
import type { EventDto, EventFilters } from "./eventFilters";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { PAGE_PARAM } from "../../components/urlCursor";
import { useLiveMessages, useLiveTopic, useNewCount } from "../../live/hooks";
import { useRouter } from "../../routing";
import { eventKeys, liveEventOf, matchesFilters } from "./eventFilters";

/** What {@link useNewEvents} answers. */
export interface NewEvents {
  /** How many matching events arrived since the list was read. */
  readonly count: number;
  /** Whether messages were lost (a `gap`): some may not be counted. */
  readonly gap: boolean;
  /** Goes to the first page and reads it again; zeroes the count. */
  readonly show: () => void;
}

/** Options of {@link useNewEvents}. */
export interface UseNewEventsOptions {
  /** The scope on screen. */
  scope: string;
  /** The list's filters (a live event is counted only when it passes them). */
  filters: EventFilters;
  /** Whether the list's first read has answered (events before it are not new). */
  loaded: boolean;
  /** The list's depth in its cursor trail (0: the first page). */
  depth: number;
  /** Reads the page shown again (when it is the first). */
  refetch: () => void;
  /** Only events this also accepts (the automatic bans: `action === "ban"`). */
  accept?: (event: EventDto) => boolean;
}

/** See the module's description. */
export function useNewEvents({
  scope,
  filters,
  loaded,
  depth,
  refetch,
  accept,
}: UseNewEventsOptions): NewEvents {
  useLiveTopic("events");
  const queryClient = useQueryClient();
  const { location, navigate } = useRouter();
  const latest = useRef({ filters, loaded, accept });
  useEffect(() => {
    latest.current = { filters, loaded, accept };
  });
  const counted = useNewCount(["event"], (data) => {
    const event = liveEventOf(data);
    const now = latest.current;
    return (
      event !== null &&
      now.loaded &&
      matchesFilters(event, now.filters) &&
      (now.accept === undefined || now.accept(event))
    );
  });
  const [gap, setGap] = useState(false);
  useLiveMessages(["$gap"], () => setGap(true));
  const show = () => {
    counted.reset();
    setGap(false);
    if (depth === 0) {
      refetch();
      return;
    }
    // The first page may be cached from earlier: stale, so going there reads it.
    void queryClient.invalidateQueries({
      queryKey: eventKeys.lists(scope),
      refetchType: "none",
    });
    const params = new URLSearchParams(location.search);
    params.delete(PAGE_PARAM);
    const query = params.toString();
    navigate(`${location.path ?? "/events"}${query === "" ? "" : `?${query}`}`);
  };
  return { count: counted.count, gap, show };
}
