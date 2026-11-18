/**
 * The events list (`/events`, ui.md §7's "Events list" and §5): every
 * stored event on the scope and under it, newest first, a page at a time
 * with the cursor trail in the URL, filtered by time, action, rule, route,
 * address, country, ASN and dry run (and, with `events:read`, an account's
 * key), every filter in the URL. Live events are counted in an "N new —
 * show" chip, never inserted, and nothing else re-reads the list (no
 * polling: the chip is the refresh). A row opens `/events/:id`, the detail
 * drawer over the list, keeping the list's query so closing it comes back
 * to the same page.
 *
 * What an operator sees of each event is the API's to decide: under
 * `analytics:read` alone, no account subject and no request sample; under
 * `events:read` on the event's service, the whole event.
 */
import type { EventFilters } from "./eventFilters";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "../../../kit/components/EmptyState";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { useSecurityClient } from "../../context";
import { useCan } from "../../meta/hooks";
import { useParams, useRouter } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { EventDrawer } from "./EventDrawer";
import {
  ALL_FILTER_FIELDS,
  anyFilter,
  eventKeys,
  filtersOf,
  listQuery,
  searchWith,
} from "./eventFilters";
import { EventFiltersForm } from "./EventFiltersForm";
import { EventsTable } from "./EventsTable";
import { NewEventsChip } from "./NewEventsChip";
import { useNewEvents } from "./useNewEvents";

/** Props of {@link EventsScreen}. */
export interface EventsScreenProps {
  /** The scope on screen. */
  scope: string;
}

/** The event id in the route (`/events/:id`, or `/events/*` when both paths are one route), or `undefined` on the list. */
function useEventId(): string | undefined {
  const params = useParams<{ id?: string; "*"?: string }>();
  const id = params.id ?? params["*"];
  return id === undefined || id === "" ? undefined : id;
}

/** See the module's description. */
export function EventsScreen({ scope }: EventsScreenProps) {
  const { client } = useSecurityClient();
  const { location, navigate } = useRouter();
  const id = useEventId();
  const position = useUrlCursor(50);
  const filters = filtersOf(location.search);
  const canFilterAccounts = useCan("events:read");
  const page = useQuery({
    queryKey: eventKeys.list(scope, filters, position.cursor, position.limit),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/analytics/events", {
          query: {
            scope,
            limit: position.limit,
            direction: "desc",
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
            ...listQuery(filters),
          },
          signal,
        }),
      ),
  });
  const news = useNewEvents({
    scope,
    filters,
    loaded: page.data !== undefined,
    depth: position.depth,
    refetch: () => void page.refetch(),
  });
  const apply = (next: EventFilters) =>
    navigate(`/events${searchWith(location.search, next)}`);
  const listSearch = location.search;
  return (
    <div
      className="screen"
      data-testid="events"
    >
      <h1>Events: {scopeLabel(scope)}</h1>
      <EventFiltersForm
        // A new URL (back/forward, Clear) starts the form again from it.
        key={searchWith("", filters)}
        filters={filters}
        fields={ALL_FILTER_FIELDS}
        canFilterAccounts={canFilterAccounts}
        onApply={apply}
        clearTo={
          anyFilter(filters)
            ? `/events${searchWith(location.search, filtersOf(""))}`
            : undefined
        }
      />
      <NewEventsChip news={news} />
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The events could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : page.isPending ? (
        <Spinner label="Loading the events" />
      ) : page.data.items.length === 0 ? (
        <EmptyState
          title="No events"
          description={
            anyFilter(filters)
              ? "No stored event matches these filters."
              : "No event has been stored for this scope yet."
          }
        />
      ) : (
        <EventsTable
          label="Events"
          items={page.data.items}
          detailPath={(event) =>
            `/events/${encodeURIComponent(event.id)}${listSearch}`
          }
        />
      )}
      {page.data === undefined ? null : (
        <UrlPager
          position={position}
          page={page.data}
          label="Events pages"
        />
      )}
      {id === undefined ? null : (
        <EventDrawer
          key={id}
          id={id}
          scope={scope}
          backTo={`/events${listSearch}`}
        />
      )}
    </div>
  );
}
