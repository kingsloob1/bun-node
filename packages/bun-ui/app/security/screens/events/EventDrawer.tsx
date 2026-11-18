/**
 * The event detail drawer (`/events/:id`, ui.md §7's "Events list"): one
 * event, whole, with its redacted request — the headers, the query, the
 * JSON body's fields and the answer sent — over the list, in a dialog
 * (Escape, the close button and "Back to the events" return to the list
 * with its query). It reads `GET /analytics/events/:id`, which needs
 * `events:read` on the event's own service: a 403 says "No access" here, a
 * 404 "Not found". From it, the subject goes to the ban form or the
 * list-entry form, pre-filled (the URL contract in `prefill.ts`), each link
 * present only when the operator may use that form on the scope.
 */
import type { ReactNode } from "react";
import type { EventDetailDto } from "./eventFilters";
import { useQuery } from "@tanstack/react-query";
import { Dialog } from "../../../kit/components/Dialog";
import { JsonView } from "../../../kit/components/JsonView";
import { KeyValue } from "../../../kit/components/KeyValue";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { useSecurityClient } from "../../context";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { useNavigate } from "../../routing";
import { eventKeys, when } from "./eventFilters";
import { EventSubjects } from "./EventsTable";
import { bannableSubjects, banFormPath, listFormPath } from "./prefill";

/** Props of {@link EventDrawer}. */
export interface EventDrawerProps {
  /** The event's id. */
  id: string;
  /** The scope on screen (the forms' scope). */
  scope: string;
  /** Where closing goes: the list, with its query. */
  backTo: string;
}

/** Each ban link's text (the contract's wording). */
const BAN_LABELS = {
  ip: "Ban this address",
  user: "Ban this user key",
  apiKey: "Ban this API key key",
} as const;

/** A plain record, or `undefined`. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A section of the request: a heading and its content. */
function Part({
  title,
  testId,
  children,
}: {
  /** The heading. */
  title: string;
  /** Its test id. */
  testId: string;
  /** The content. */
  children: ReactNode;
}) {
  return (
    <section
      className="event-sample-part"
      data-testid={testId}
    >
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/**
 * The redacted request (bun-security's `RequestSample`): its method and
 * path, headers, query, body (type, length, fields) and the answer. A
 * sample of another shape is shown as it is.
 */
export function RequestSampleView({ sample }: { sample: unknown }) {
  if (sample === undefined || sample === null) {
    return (
      <p
        className="muted"
        data-testid="event-no-sample"
      >
        No request was sampled for this event.
      </p>
    );
  }
  const record = recordOf(sample);
  const headers = recordOf(record?.headers);
  if (
    record === undefined ||
    typeof record.method !== "string" ||
    headers === undefined
  ) {
    return (
      <Part
        title="Recorded sample"
        testId="event-sample-raw"
      >
        <JsonView
          value={sample}
          label="Recorded sample"
          expandDepth={2}
        />
      </Part>
    );
  }
  const query = recordOf(record.query);
  const body = recordOf(record.body);
  const answer = recordOf(record.answer);
  const answerHeaders = recordOf(answer?.headers);
  return (
    <div
      className="event-sample"
      data-testid="event-sample"
    >
      <Part
        title="Request"
        testId="event-sample-request"
      >
        <p>
          <code>
            {record.method} {typeof record.path === "string" ? record.path : ""}
          </code>
        </p>
      </Part>
      <Part
        title="Headers"
        testId="event-sample-headers"
      >
        <JsonView
          value={headers}
          label="Request headers"
        />
      </Part>
      {query === undefined ? null : (
        <Part
          title="Query"
          testId="event-sample-query"
        >
          <JsonView
            value={query}
            label="Request query"
          />
        </Part>
      )}
      {body === undefined ? null : (
        <Part
          title="Body"
          testId="event-sample-body"
        >
          <KeyValue
            items={[
              {
                label: "Type",
                value: typeof body.type === "string" ? body.type : undefined,
              },
              typeof body.length === "number" && {
                label: "Length",
                value: `${body.length} bytes`,
              },
              body.truncated === true && {
                label: "Cut",
                value: "Yes: the recorded fields are partial",
              },
            ]}
          />
          {body.fields === undefined ? null : (
            <JsonView
              value={body.fields}
              label="Request body"
              expandDepth={2}
            />
          )}
        </Part>
      )}
      {answer === undefined ? null : (
        <Part
          title="Answer"
          testId="event-sample-answer"
        >
          <KeyValue
            items={[
              {
                label: "Status",
                value:
                  typeof answer.status === "number"
                    ? String(answer.status)
                    : undefined,
              },
            ]}
          />
          {answerHeaders === undefined ? null : (
            <JsonView
              value={answerHeaders}
              label="Answer headers"
            />
          )}
          {typeof answer.body === "string" ? (
            <pre
              className="event-answer-body"
              data-testid="event-answer-body"
            >
              {answer.body}
            </pre>
          ) : null}
        </Part>
      )}
    </div>
  );
}

/** The event's fields and its request. */
function EventBody({ event, scope }: { event: EventDetailDto; scope: string }) {
  const canBan = useCan("bans:write");
  const canDraft = useCan("policy:draft");
  const bannable = canBan ? bannableSubjects(event) : [];
  const ip = event.subjects?.ip;
  return (
    <div data-testid="event-detail">
      <KeyValue
        items={[
          { label: "Time", value: when(event.at) },
          { label: "Service", value: event.service },
          { label: "Route", value: event.route },
          { label: "Action", value: event.action },
          {
            label: "Rule",
            value:
              event.rule === undefined ? undefined : <code>{event.rule}</code>,
          },
          event.rules !== undefined &&
            event.rules.length > 0 && {
              label: "Rules hit",
              value: event.rules.join(", "),
            },
          { label: "Dry run", value: event.dryRun === true ? "Yes" : "No" },
          { label: "Subjects", value: <EventSubjects event={event} /> },
          { label: "Country", value: event.country },
          {
            label: "ASN",
            value: event.asn === undefined ? undefined : `AS${event.asn}`,
          },
          {
            label: "Status",
            value:
              event.status === undefined ? undefined : String(event.status),
          },
          {
            label: "Latency",
            value:
              event.latencyMs === undefined
                ? undefined
                : `${event.latencyMs} ms`,
          },
          event.sampleRate !== undefined && {
            label: "Sample rate",
            value: `1 in ${Math.round(1 / event.sampleRate).toLocaleString()} allows kept`,
          },
          { label: "Id", value: <code>{event.id}</code> },
        ]}
      />
      {bannable.length > 0 || (canDraft && ip !== undefined) ? (
        <ul
          className="event-actions"
          aria-label="Act on this event"
        >
          {bannable.map((subject) => (
            <li key={subject.kind}>
              <Link
                to={banFormPath(scope, subject)}
                data-testid={`event-ban-${subject.kind}`}
              >
                {BAN_LABELS[subject.kind]}
              </Link>
            </li>
          ))}
          {canDraft && ip !== undefined ? (
            <li>
              <Link
                to={listFormPath(scope, ip)}
                data-testid="event-list-ip"
              >
                Allow / deny in lists
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}
      <h3>Redacted request</h3>
      <RequestSampleView sample={event.sample} />
    </div>
  );
}

/** See the module's description. */
export function EventDrawer({ id, scope, backTo }: EventDrawerProps) {
  const { client } = useSecurityClient();
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: eventKeys.detail(id),
    queryFn: ({ signal }) =>
      dataOf(client.get("/analytics/events/:id", { params: { id }, signal })),
  });
  const status = isApiError(detail.error) ? detail.error.status : undefined;
  let body: ReactNode;
  if (detail.isPending) body = <Spinner label="Loading the event" />;
  else if (status === 403) {
    body = (
      <div data-testid="event-no-access">
        <h3>No access</h3>
        <p>
          You may not see this event: it needs the events:read permission on the
          service that recorded it.
        </p>
      </div>
    );
  } else if (status === 404) {
    body = (
      <div data-testid="event-not-found">
        <h3>Not found</h3>
        <p>
          There is no event &ldquo;{id}&rdquo;: retention may have removed it.
        </p>
      </div>
    );
  } else if (detail.isError) {
    body = (
      <ErrorView
        error={detail.error}
        title="The event could not be read"
        onRetry={() => void detail.refetch()}
      />
    );
  } else {
    body = (
      <EventBody
        event={detail.data}
        scope={scope}
      />
    );
  }
  return (
    <Dialog
      open
      onClose={() => navigate(backTo)}
      title="Event"
      size="lg"
      className="event-drawer"
      footer={
        <Link
          to={backTo}
          data-testid="event-close"
        >
          Back to the events
        </Link>
      }
    >
      {body}
    </Dialog>
  );
}
