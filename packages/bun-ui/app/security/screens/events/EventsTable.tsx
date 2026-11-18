/**
 * A page of events as a table: time (the link to its detail), service,
 * route, action, rule, the subjects (each through `Subject`: an account is
 * its key as the API reports it), country and ASN, status, latency and dry
 * run. A screen may add a column of its own (the automatic bans' "Make a
 * fleet ban").
 */
import type { ReactNode } from "react";
import type { SubjectKind } from "../../components/Subject";
import type { EventDto } from "./eventFilters";
import { Badge } from "../../../kit/components/Badge";
import { Table } from "../../../kit/components/Table";
import { Subject } from "../../components/Subject";
import { Link } from "../../router";
import { when } from "./eventFilters";

/** The subject kinds an event carries, in the order shown. */
const SUBJECT_ORDER = ["ip", "user", "apiKey", "username"] as const;

/** An action's badge tone. */
function toneOf(action: string) {
  switch (action) {
    case "allow":
      return "success";
    case "log":
    case "tag":
      return "neutral";
    case "delay":
    case "challenge":
      return "warning";
    default:
      return "danger";
  }
}

/** An event's subjects, each through `Subject`. */
export function EventSubjects({ event }: { event: EventDto }) {
  const subjects = event.subjects ?? {};
  const present = SUBJECT_ORDER.filter(
    (kind) => typeof subjects[kind] === "string",
  );
  if (present.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="event-subjects">
      {present.map((kind) => (
        <li key={kind}>
          <Subject
            kind={kind satisfies SubjectKind}
            value={subjects[kind]!}
          />
        </li>
      ))}
    </ul>
  );
}

/** Props of {@link EventsTable}. */
export interface EventsTableProps {
  /** The table's accessible name. */
  label: string;
  /** The events, in order. */
  items: readonly EventDto[];
  /** The detail's path for an event (with the list's query, so closing it comes back). */
  detailPath: (event: EventDto) => string;
  /** A column of the screen's own, after the others. */
  extra?: {
    /** Its header. */
    readonly header: string;
    /** Renders its cell for an event. */
    readonly renderCell: (event: EventDto) => ReactNode;
  };
}

/** See the module's description. */
export function EventsTable({
  label,
  items,
  detailPath,
  extra,
}: EventsTableProps) {
  return (
    <Table label={label}>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Service</th>
          <th scope="col">Route</th>
          <th scope="col">Action</th>
          <th scope="col">Rule</th>
          <th scope="col">Subjects</th>
          <th scope="col">Country / ASN</th>
          <th scope="col">Status</th>
          <th scope="col">Latency</th>
          <th scope="col">Dry run</th>
          {extra === undefined ? null : <th scope="col">{extra.header}</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((event) => (
          <tr
            key={event.id}
            data-testid="event-row"
            data-event-id={event.id}
          >
            <td>
              <Link
                to={detailPath(event)}
                title={`Event ${event.id}`}
                data-testid="event-open"
              >
                {when(event.at)}
              </Link>
            </td>
            <td>{event.service}</td>
            <td>{event.route ?? <span className="muted">—</span>}</td>
            <td>
              <Badge tone={toneOf(event.action)}>{event.action}</Badge>
            </td>
            <td>
              {event.rule === undefined ? (
                <span className="muted">—</span>
              ) : (
                <code>{event.rule}</code>
              )}
            </td>
            <td>
              <EventSubjects event={event} />
            </td>
            <td>
              {[
                event.country,
                event.asn === undefined ? undefined : `AS${event.asn}`,
              ]
                .filter((part) => part !== undefined)
                .join(" / ") || <span className="muted">—</span>}
            </td>
            <td>{event.status ?? <span className="muted">—</span>}</td>
            <td>
              {event.latencyMs === undefined ? (
                <span className="muted">—</span>
              ) : (
                `${event.latencyMs} ms`
              )}
            </td>
            <td>{event.dryRun === true ? "Yes" : "No"}</td>
            {extra === undefined ? null : <td>{extra.renderCell(event)}</td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
