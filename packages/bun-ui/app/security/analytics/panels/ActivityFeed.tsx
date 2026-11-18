/**
 * The activity feed (ui.md §7, PR-U2): the latest decisions, as the live
 * stream sends them (each stripped to the reader's rights by the server:
 * a viewer's carry no account subject and never a sample), the last 200
 * kept. It pauses while the pointer or focus is on it, counting what
 * arrived ("N new"), and resumes on leaving. Each row opens the event in
 * U3's detail view (`/events/:id`).
 */
import type {
  LiveEventMessageDto,
  LiveMoreDto,
} from "@kingsleyweb/bun-security/control/contract";
import { useRef, useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Table } from "../../../kit/components/Table";
import { formatTime } from "../../../kit/charts/chart";
import { dataOf } from "../../api/client";
import { useLiveMessages, useLiveTopic } from "../../live/hooks";
import { Subject } from "../../components/Subject";
import { Link } from "../../router";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** An event as the feed shows it. */
type FeedEvent = LiveEventMessageDto["event"];

/** The most events the feed keeps. */
const FEED_LIMIT = 200;

/** An event's subject as a cell: the address, or an account's key when the reader may see it. */
function SubjectCell({ event }: { event: FeedEvent }) {
  const subjects = event.subjects ?? {};
  const kind = (["ip", "user", "apiKey", "username"] as const).find(
    (name) => subjects[name] !== undefined,
  );
  return kind === undefined ? (
    <>—</>
  ) : (
    <Subject
      kind={kind}
      value={subjects[kind]!}
      {...(event.country === undefined ? {} : { country: event.country })}
      {...(event.asn === undefined ? {} : { asn: event.asn })}
    />
  );
}

/** See the module's description. */
export function ActivityFeed() {
  const initial = usePanelQuery(
    "feed.initial",
    async (c) =>
      await dataOf(
        c.client.get("/analytics/events", {
          query: { scope: c.scope, limit: 50 },
          ...(c.signal === undefined ? {} : { signal: c.signal }),
        }),
      ),
    { liveMs: 300_000 },
  );
  const [arrived, setArrived] = useState<FeedEvent[]>([]);
  const [held, setHeld] = useState<FeedEvent[]>([]);
  const [more, setMore] = useState(0);
  const paused = useRef(false);
  const [isPaused, setPaused] = useState(false);
  useLiveTopic("events");
  useLiveMessages(["event", "more", "$gap"], (data) => {
    const message = data as Partial<LiveEventMessageDto & LiveMoreDto>;
    if (message.event !== undefined) {
      const event = message.event;
      if (paused.current)
        setHeld((current) => [event, ...current].slice(0, FEED_LIMIT));
      else setArrived((current) => [event, ...current].slice(0, FEED_LIMIT));
    } else if (typeof message.count === "number") {
      const count = message.count;
      setMore((total) => total + count);
    } else {
      // A gap: the resume point is gone; read the latest again.
      void initial.refetch();
    }
  });
  const pause = (on: boolean) => {
    paused.current = on;
    setPaused(on);
    if (!on && held.length > 0) {
      setArrived((current) => [...held, ...current].slice(0, FEED_LIMIT));
      setHeld([]);
    }
  };
  return (
    <Panel
      title="Activity"
      testId="panel-feed"
      states={[initial]}
      className="analytics-wide"
      actions={
        held.length > 0 ? (
          <Button
            variant="ghost"
            onClick={() => pause(false)}
          >
            {held.length} new
          </Button>
        ) : null
      }
    >
      {() => {
        const seen = new Set<string>();
        const events = [...arrived, ...initial.data!.items]
          .filter((event) =>
            seen.has(event.id) ? false : (seen.add(event.id), true),
          )
          .slice(0, FEED_LIMIT);
        if (events.length === 0)
          return <p className="chart-empty">No decision yet.</p>;
        return (
          <div
            className="feed"
            data-paused={isPaused}
            onMouseEnter={() => pause(true)}
            onMouseLeave={() => pause(false)}
            onFocus={() => pause(true)}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                pause(false);
            }}
          >
            {more > 0 ? (
              <p className="panel-note">
                {more} more decisions arrived too fast to list.
              </p>
            ) : null}
            <Table label="Latest decisions">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Service</th>
                  <th scope="col">Route</th>
                  <th scope="col">Rule</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr
                    key={event.id}
                    data-testid="feed-row"
                  >
                    <td>
                      <Link to={`/events/${encodeURIComponent(event.id)}`}>
                        {formatTime(event.at)}
                      </Link>
                    </td>
                    <td>
                      <SubjectCell event={event} />
                    </td>
                    <td>{event.service}</td>
                    <td className="mono">{event.route ?? "—"}</td>
                    <td className="mono">{event.rule ?? "—"}</td>
                    <td>{event.action}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        );
      }}
    </Panel>
  );
}
