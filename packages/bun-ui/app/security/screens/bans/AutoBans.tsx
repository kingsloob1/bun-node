/**
 * The automatic bans (`/bans/auto`, ui.md §4.2): the bans the engines made
 * by themselves, as they show in the events (`action: "ban"`; the control
 * plane does not store them as bans until a later PR), filtered by rule and
 * time range, grouped by rule (a count per rule on the page shown, most
 * first) and listed a page at a time with the cursor trail in the URL. Each
 * row's subject can be made a fleet ban: the ban form, pre-filled (an
 * address as `ip`, an account's key as `userHash` or `apiKeyHash`), present
 * only with `bans:write`. It reads the events, so it needs
 * `analytics:read` on the scope (the section's `bans:read` is not enough).
 * Live ban events are counted in an "N new — show" chip, as on the events
 * list.
 */
import type { EventDto, EventFilters } from "../events/eventFilters";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "../../../kit/components/EmptyState";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { useSecurityClient } from "../../context";
import { useCan, usePermissionsSettled } from "../../meta/hooks";
import { Link } from "../../router";
import { useRouter } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import {
  anyFilter,
  countByRule,
  eventKeys,
  filtersOf,
  listQuery,
  NO_RULE,
  searchWith,
} from "../events/eventFilters";
import { EventFiltersForm } from "../events/EventFiltersForm";
import { EventsTable } from "../events/EventsTable";
import { NewEventsChip } from "../events/NewEventsChip";
import { useNewEvents } from "../events/useNewEvents";
import { bannableSubjects, banFormPath } from "../events/prefill";
import { NoAccess } from "../NoAccess";

/** Props of {@link AutoBans}. */
export interface AutoBansProps {
  /** The scope on screen. */
  scope: string;
}

/** The filters this screen offers: the rule and the time range (the action is always `ban`). */
function autoFilters(filters: EventFilters): EventFilters {
  return {
    ...filtersOf(""),
    from: filters.from,
    to: filters.to,
    rule: filters.rule,
  };
}

/** Which subject a fleet-ban link takes, when an event has several. */
const FLEET_KINDS = {
  ip: "address",
  user: "user key",
  apiKey: "API key key",
} as const;

/** An event's fleet-ban links: one per subject the ban form takes. */
function FleetBanLinks({ event, scope }: { event: EventDto; scope: string }) {
  const subjects = bannableSubjects(event);
  if (subjects.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="auto-bans-actions">
      {subjects.map((subject) => (
        <li key={subject.kind}>
          <Link
            to={banFormPath(scope, subject)}
            data-testid={`auto-ban-fleet-${subject.kind}`}
          >
            Make a fleet ban
            {subjects.length === 1 ? null : ` (${FLEET_KINDS[subject.kind]})`}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The screen, once the operator may read the events. */
function AutoBansList({ scope }: AutoBansProps) {
  const { client } = useSecurityClient();
  const { location, navigate } = useRouter();
  const position = useUrlCursor(50);
  const filters = autoFilters(filtersOf(location.search));
  const canBan = useCan("bans:write");
  const page = useQuery({
    queryKey: eventKeys.autoBans(
      scope,
      filters,
      position.cursor,
      position.limit,
    ),
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
            action: "ban",
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
    accept: (event) => event.action === "ban",
  });
  const scopeQuery = new URLSearchParams({ scope }).toString();
  const groups = page.data === undefined ? [] : countByRule(page.data.items);
  return (
    <div
      className="screen"
      data-testid="auto-bans"
    >
      <h1>Automatic bans: {scopeLabel(scope)}</h1>
      <p className="muted">
        The bans the engines made by themselves, as their events report them.
      </p>
      <EventFiltersForm
        key={searchWith("", filters)}
        filters={filters}
        fields={["time", "rule"]}
        canFilterAccounts={false}
        onApply={(next) =>
          navigate(
            `/bans/auto${searchWith(location.search, autoFilters(next))}`,
          )
        }
        clearTo={
          anyFilter(filters)
            ? `/bans/auto${searchWith(location.search, filtersOf(""))}`
            : undefined
        }
      />
      <NewEventsChip
        news={news}
        testId="auto-bans-new"
      />
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The automatic bans could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : page.isPending ? (
        <Spinner label="Loading the automatic bans" />
      ) : page.data.items.length === 0 ? (
        <EmptyState
          title="No automatic bans"
          description={
            anyFilter(filters)
              ? "No ban event matches these filters."
              : "No engine has reported a ban for this scope."
          }
        />
      ) : (
        <>
          <section
            className="auto-bans-rules"
            aria-labelledby="auto-bans-rules-title"
            data-testid="auto-bans-rules"
          >
            <h2 id="auto-bans-rules-title">By rule, on this page</h2>
            <ol>
              {groups.map((group) => (
                <li
                  key={group.rule}
                  data-testid="auto-bans-rule"
                  data-rule={group.rule}
                >
                  {group.rule === NO_RULE ? (
                    <span className="muted">{group.rule}</span>
                  ) : (
                    <Link
                      to={`/bans/auto${searchWith(location.search, {
                        ...filters,
                        rule: group.rule,
                      })}`}
                      title={`Only the bans by ${group.rule}`}
                    >
                      <code>{group.rule}</code>
                    </Link>
                  )}{" "}
                  <span data-testid="auto-bans-rule-count">{group.count}</span>
                </li>
              ))}
            </ol>
          </section>
          <EventsTable
            label="Automatic bans"
            items={page.data.items}
            detailPath={(event) =>
              `/events/${encodeURIComponent(event.id)}?${scopeQuery}`
            }
            {...(canBan
              ? {
                  extra: {
                    header: "Fleet ban",
                    renderCell: (event: EventDto) => (
                      <FleetBanLinks
                        event={event}
                        scope={scope}
                      />
                    ),
                  },
                }
              : {})}
          />
        </>
      )}
      {page.data === undefined ? null : (
        <UrlPager
          position={position}
          page={page.data}
          label="Automatic bans pages"
        />
      )}
    </div>
  );
}

/** See the module's description. */
export function AutoBans({ scope }: AutoBansProps) {
  const canRead = useCan("analytics:read");
  const settled = usePermissionsSettled();
  if (!settled) return <Spinner label="Loading the permissions" />;
  if (!canRead) {
    return (
      <NoAccess
        section="Automatic bans"
        scope={scope}
        needs="analytics:read"
      />
    );
  }
  return <AutoBansList scope={scope} />;
}
