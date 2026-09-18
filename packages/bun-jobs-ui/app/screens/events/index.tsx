/**
 * The Events console: a live tail of the API's socket. Routed from
 * `routes.tsx` at `/events` (lazily, see `../lazy.tsx`).
 */
import type { FormEvent } from "react";
import type {
  EventName,
  EventWire,
  JobsApiAckRejection,
  JobsApiGapMessage,
} from "../../api/types";
import type { BadgeTone } from "../../components/Badge";
import type { LiveStatus } from "../../live";
import type { ChannelChoice, ChannelScope, LogRow } from "./eventLog";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { queryKeys } from "../../api/queryKeys";
import { jobPath, queuePath } from "../../api/queues";
import { listRunners, runnerKeys, runnerPath } from "../../api/runners";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Field } from "../../components/Field";
import { Checkbox, Select, TextInput } from "../../components/inputs";
import { JsonView } from "../../components/JsonView";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { formatNumber, plural } from "../../format";
import { useLiveStatus, useLiveSubscription } from "../../live";
import { useCan, useMeta } from "../../meta/hooks";
import { Link } from "../../router";
import { useUrlParams } from "../queues/urlState";
import {
  channelName,
  defaultChoice,
  matchesTypes,
  MAX_PAUSED,
  MAX_ROWS,
  parseChannel,
  parseTypes,
  prependRows,
  scopesFor,
  typesFor,
} from "./eventLog";
import "./events.css";

/** How the scope select names each scope. */
const SCOPE_LABELS: Readonly<Record<ChannelScope, string>> = {
  all: "Everything (all)",
  queues: "Every queue (queues)",
  queue: "One queue",
  job: "One job",
  runners: "Every runner (runners)",
  runner: "One runner",
};

/** Scopes that name no target, applied as soon as they are picked. */
const BROAD_SCOPES: ReadonlySet<ChannelScope> = new Set<ChannelScope>([
  "all",
  "queues",
  "runners",
]);

/** What the picker is editing before it is applied. */
interface Draft {
  /** The scope. */
  scope: ChannelScope;
  /** The queue, for `queue` and `job`. */
  queue: string;
  /** The runner, for `runner`. */
  runner: string;
  /** The job id, for `job`. */
  id: string;
}

/** A draft from an applied choice. */
function draftOf(choice: ChannelChoice): Draft {
  return {
    scope: choice.scope,
    queue:
      choice.scope === "queue" || choice.scope === "job" ? choice.queue : "",
    runner: choice.scope === "runner" ? choice.runner : "",
    id: choice.scope === "job" ? choice.id : "",
  };
}

/** The choice a draft names, or `null` while a target is missing. */
function choiceOf(draft: Draft): ChannelChoice | null {
  switch (draft.scope) {
    case "all":
    case "queues":
    case "runners":
      return { scope: draft.scope };
    case "queue":
      return draft.queue ? { scope: "queue", queue: draft.queue } : null;
    case "runner":
      return draft.runner ? { scope: "runner", runner: draft.runner } : null;
    case "job":
      return draft.queue && draft.id
        ? { scope: "job", queue: draft.queue, id: draft.id }
        : null;
  }
}

/** Props of {@link TargetInput}. */
interface TargetInputProps {
  /** The field's label. */
  label: string;
  /** The chosen name. */
  value: string;
  /** Names to choose from; `undefined` (not listable) or empty gives a text box. */
  names: readonly string[] | undefined;
  /** Sets the name. */
  onChange: (value: string) => void;
}

/** A target picker: a select over the listed names when there are some, else a text box. */
function TargetInput({ label, value, names, onChange }: TargetInputProps) {
  return (
    <Field label={label}>
      {names && names.length > 0 ? (
        <Select
          options={[
            { value: "", label: "Choose…" },
            ...names.map((name) => ({ value: name })),
          ]}
          value={names.includes(value) ? value : ""}
          onChange={onChange}
        />
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Field>
  );
}

/** Props of {@link ChannelPicker}. */
interface ChannelPickerProps {
  /** The applied choice. */
  choice: ChannelChoice;
  /** Applies a new choice. */
  onApply: (choice: ChannelChoice) => void;
}

/**
 * Picks the channel: a scope, then its queue (from the queue list), runner
 * (from the runner list) or job (a queue and an id). A broad scope applies
 * at once; a targeted one on "Watch".
 */
function ChannelPicker({ choice, onApply }: ChannelPickerProps) {
  const api = useApiClient();
  const meta = useMeta();
  const canQueues = useCan("queues.list");
  const canRunners = useCan("runners.list");
  const [draft, setDraft] = useState<Draft>(() => draftOf(choice));
  const needsQueue = draft.scope === "queue" || draft.scope === "job";
  const queues = useQuery({
    queryKey: queryKeys.queues(""),
    queryFn: ({ signal }) => api.listQueues("", signal),
    enabled: needsQueue && canQueues,
  });
  const runners = useQuery({
    queryKey: runnerKeys.list(),
    queryFn: ({ signal }) => listRunners(api, signal),
    enabled: draft.scope === "runner" && canRunners,
  });
  const next = choiceOf(draft);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (next) {
      onApply(next);
    }
  };

  return (
    <form
      className="events-picker"
      onSubmit={onSubmit}
      aria-label="Channel"
    >
      <Field label="Channel">
        <Select
          options={scopesFor(meta.mode).map((scope) => ({
            value: scope,
            label: SCOPE_LABELS[scope],
          }))}
          value={draft.scope}
          onChange={(scope) => {
            const updated = { ...draft, scope };
            setDraft(updated);
            const applied = BROAD_SCOPES.has(scope) ? choiceOf(updated) : null;
            if (applied) {
              onApply(applied);
            }
          }}
        />
      </Field>
      {needsQueue && (
        <TargetInput
          label="Queue"
          value={draft.queue}
          names={queues.data?.items.map((queue) => queue.name)}
          onChange={(queue) => setDraft({ ...draft, queue })}
        />
      )}
      {draft.scope === "job" && (
        <Field label="Job id">
          <TextInput
            value={draft.id}
            onChange={(id) => setDraft({ ...draft, id })}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      {draft.scope === "runner" && (
        <TargetInput
          label="Runner"
          value={draft.runner}
          names={runners.data?.items.map((runner) => runner.id)}
          onChange={(runner) => setDraft({ ...draft, runner })}
        />
      )}
      {!BROAD_SCOPES.has(draft.scope) && (
        <Button
          type="submit"
          variant="primary"
          disabled={next === null}
        >
          Watch
        </Button>
      )}
    </form>
  );
}

/** Props of {@link TypeFilter}. */
interface TypeFilterProps {
  /** The types the channel can carry. */
  allowed: readonly EventName[];
  /** The chosen ones; empty means every type. */
  selected: readonly EventName[];
  /** Sets the filter. */
  onChange: (types: EventName[]) => void;
}

/** The event-type filter: a checkbox per type, under a summary of the choice. */
function TypeFilter({ allowed, selected, onChange }: TypeFilterProps) {
  const toggle = (type: EventName, on: boolean) =>
    onChange(
      allowed.filter((candidate) =>
        candidate === type ? on : selected.includes(candidate),
      ),
    );
  return (
    <details className="events-types">
      <summary data-testid="events-types-summary">
        Types: {selected.length === 0 ? "all" : selected.join(", ")}
      </summary>
      <fieldset>
        <legend className="visually-hidden">Event types</legend>
        <div className="events-type-grid">
          {allowed.map((type) => (
            <Checkbox
              key={type}
              label={type}
              checked={selected.includes(type)}
              onChange={(on) => toggle(type, on)}
            />
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([])}
          disabled={selected.length === 0}
        >
          All types
        </Button>
      </fieldset>
    </details>
  );
}

/** `hh:mm:ss.mmm`, local time. */
function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** A colour per outcome: failures red, trouble amber, successes green. */
function toneOf(event: EventWire): BadgeTone {
  switch (event.type) {
    case "failed":
    case "dead":
    case "timeout":
    case "killed":
      return "danger";
    case "retrying":
    case "stalled":
    case "skipped":
      return "warning";
    case "completed":
    case "succeeded":
      return "success";
    default:
      return "neutral";
  }
}

/** An event's id: a queue event's job, linked to its screen; a runner event's run, as text. */
function EventId({ event }: { event: EventWire }) {
  if (event.id === undefined) {
    return <span className="muted">—</span>;
  }
  if (event.kind === "queue") {
    return <Link to={jobPath(event.target, event.id)}>{event.id}</Link>;
  }
  return <code>{event.id}</code>;
}

/** One event row. */
function EventRow({ row, event }: { row: LogRow; event: EventWire }) {
  const at = new Date(event.at).toISOString();
  return (
    <tr
      data-testid="event-row"
      data-type={event.type}
    >
      <td className="events-time">
        <time
          dateTime={at}
          title={at}
        >
          {clock(event.at)}
        </time>
      </td>
      <td className="events-kind">
        <Badge tone={event.kind === "queue" ? "info" : "accent"}>
          {event.kind}
        </Badge>{" "}
        <Badge tone={toneOf(event)}>{event.type}</Badge>
      </td>
      <td className="events-target">
        <Link
          to={
            event.kind === "queue"
              ? queuePath(event.target)
              : runnerPath(event.target)
          }
        >
          {event.target}
        </Link>
      </td>
      <td className="events-id">
        <EventId event={event} />
      </td>
      <td className="events-payload">
        <JsonView
          value={event.payload}
          label={`Payload of ${event.type} #${row.key}`}
          expandDepth={0}
          copyable={false}
        />
      </td>
    </tr>
  );
}

/** A gap row: events in a range may have been lost. */
function GapRow({ row, gap }: { row: LogRow; gap: JobsApiGapMessage }) {
  return (
    <tr
      data-testid="event-row"
      data-type="gap"
      className="events-gap"
    >
      <td className="events-time">{clock(row.receivedAt)}</td>
      <td colSpan={4}>
        <strong>gap: {gap.reason}</strong>{" "}
        <span className="muted">
          events {gap.fromSeq}–{gap.toSeq} may be missing
          {gap.channels ? ` on ${gap.channels.join(", ")}` : ""}
        </span>
      </td>
    </tr>
  );
}

/** Why the log may stay empty, from the live status. */
function EmptyLog({
  status,
  channel,
}: {
  status: LiveStatus;
  channel: string;
}) {
  if (status.publishing === false) {
    return (
      <EmptyState
        title="Producers are not publishing events"
        description="This API reports publishing: false. The queues and runners it manages emit no events, so nothing will arrive here; the screens refresh by polling instead."
      />
    );
  }
  if (status.events === "local") {
    return (
      <EmptyState
        title="Only this API process's own events"
        description="This API reports events: local. It sees only the events of work done in its own process; jobs and runs handled by other processes will not appear here."
      />
    );
  }
  if (status.state === "off" || status.state === "refused") {
    return (
      <EmptyState
        title="Live updates are off"
        description={status.detail ?? "There is no socket to the API."}
      />
    );
  }
  return (
    <EmptyState
      title="Waiting for events"
      description={
        <>
          Nothing has arrived on <code>{channel}</code> yet.
        </>
      }
    />
  );
}

/** The channels the server refused, each with why. */
function Rejections({
  rejected,
}: {
  rejected: readonly JobsApiAckRejection[];
}) {
  if (rejected.length === 0) {
    return null;
  }
  return (
    <div
      className="events-rejected"
      role="alert"
      data-testid="events-rejected"
    >
      {rejected.map((rejection) => (
        <p key={`${rejection.channel}:${rejection.code}`}>
          The server refused <code>{rejection.channel}</code>:{" "}
          <strong>{rejection.code}</strong>
          {rejection.detail ? ` (${rejection.detail})` : ""}
        </p>
      ))}
    </div>
  );
}

/** What the paused display holds back. */
interface Held {
  /** Rows waiting, oldest first (at most {@link MAX_PAUSED}). */
  rows: LogRow[];
  /** Rows that arrived after the cap, dropped. */
  dropped: number;
}

/**
 * `/events`: the live event tail. The channel and type filter live in the
 * URL (`channel`, `types`); the log keeps the latest {@link MAX_ROWS} rows,
 * newest first, and pausing holds up to {@link MAX_PAUSED} more.
 */
export function EventsScreen() {
  const meta = useMeta();
  const status = useLiveStatus();
  const [params, update] = useUrlParams();
  const choice =
    parseChannel(params.get("channel"), meta.mode) ?? defaultChoice(meta.mode);
  const channel = channelName(choice);
  const allowed = typesFor(choice);
  const types = parseTypes(params.get("types"), allowed);

  const [rows, setRows] = useState<LogRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState<Held>({ rows: [], dropped: 0 });
  const nextKeyRef = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const typesRef = useRef(types);
  typesRef.current = types;

  const add = useCallback((row: LogRow) => {
    if (pausedRef.current) {
      setHeld((current) =>
        current.rows.length >= MAX_PAUSED
          ? { rows: current.rows, dropped: current.dropped + 1 }
          : { rows: [...current.rows, row], dropped: current.dropped },
      );
    } else {
      setRows((current) => prependRows(current, [row]));
    }
  }, []);

  const onEvent = useCallback(
    (event: EventWire) => {
      // Another screen may hold this channel with a wider filter, and the
      // client merges filters per channel, so filter here too.
      if (!matchesTypes(event, typesRef.current)) {
        return;
      }
      add({
        key: nextKeyRef.current++,
        kind: "event",
        receivedAt: Date.now(),
        event,
      });
    },
    [add],
  );
  const onGap = useCallback(
    (gap: JobsApiGapMessage) =>
      add({
        key: nextKeyRef.current++,
        kind: "gap",
        receivedAt: Date.now(),
        gap,
      }),
    [add],
  );

  const { rejected } = useLiveSubscription({
    channels: [channel],
    events: types.length === 0 ? undefined : types,
    onEvent,
    onGap,
  });

  const pause = () => {
    pausedRef.current = true;
    setPaused(true);
  };
  const resume = () => {
    pausedRef.current = false;
    setRows((current) => prependRows(current, held.rows));
    setHeld({ rows: [], dropped: 0 });
    setPaused(false);
  };
  const clear = () => {
    setRows([]);
    setHeld({ rows: [], dropped: 0 });
  };

  const apply = (next: ChannelChoice) => {
    const nextAllowed = typesFor(next);
    update({
      channel: channelName(next),
      types:
        types.filter((type) => nextAllowed.includes(type)).join(",") || null,
    });
  };

  return (
    <div
      className="screen events-screen"
      data-testid="events-screen"
    >
      <h1 className="screen-title">Events</h1>
      <Card
        title="Subscription"
        className="events-controls"
      >
        <ChannelPicker
          key={channel}
          choice={choice}
          onApply={apply}
        />
        <TypeFilter
          allowed={allowed}
          selected={types}
          onChange={(next) => update({ types: next.join(",") || null })}
        />
        <p className="muted events-channel">
          Watching <code data-testid="events-channel">{channel}</code>
        </p>
        <Rejections rejected={rejected} />
      </Card>
      <Card
        title="Log"
        actions={
          <div className="events-actions">
            <span
              className="muted"
              data-testid="events-count"
            >
              {plural(rows.length, "row")} (the latest {formatNumber(MAX_ROWS)}{" "}
              are kept)
            </span>
            {paused && (
              <span
                className="events-held"
                data-testid="events-held"
              >
                {formatNumber(held.rows.length)} held
                {held.dropped > 0
                  ? `, ${formatNumber(held.dropped)} dropped`
                  : ""}
              </span>
            )}
            <Button
              size="sm"
              aria-pressed={paused}
              onClick={paused ? resume : pause}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="sm"
              onClick={clear}
              disabled={rows.length === 0 && held.rows.length === 0}
            >
              Clear
            </Button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <EmptyLog
            status={status}
            channel={channel}
          />
        ) : (
          <Table
            label="Events, newest first"
            className="events-table"
          >
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Target</th>
                <th scope="col">Id</th>
                <th scope="col">Payload</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                row.kind === "event" ? (
                  <EventRow
                    key={row.key}
                    row={row}
                    event={row.event}
                  />
                ) : (
                  <GapRow
                    key={row.key}
                    row={row}
                    gap={row.gap}
                  />
                ),
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
