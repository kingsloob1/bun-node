import type { RunnerInfoDto, RunnerStatsDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { getRunner, getRunnerStats, runnerKeys } from "../../api/runners";
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { KeyValue } from "../../components/KeyValue";
import { ProblemBanner } from "../../components/ProblemBanner";
import { RelativeTime } from "../../components/RelativeTime";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { formatNumber } from "../../format";
import { useCan, usePermissionsSettled } from "../../meta/hooks";
import { Link } from "../../router";
import { useParams } from "../../routing";
import { RunnerActions } from "./actions";
import { useRunnerLive, useRunnerRefetchInterval } from "./live";
import {
  describeConcurrency,
  describeQueueing,
  describeSchedule,
  isRunnerDenied,
  isRunnerNotFound,
  REMOTE_RUNNER_NOTE,
  runnerBadges,
} from "./runnerFormat";
import { RunnerHistory } from "./RunnerHistory";
import { RunRecordDetails } from "./RunRecord";
import "./runners.css";

/** The counters, in the order the tiles show them, with their tile colour. */
const STAT_TILES: readonly {
  key: keyof RunnerStatsDto;
  label: string;
  state?: string;
}[] = [
  { key: "success", label: "Success", state: "completed" },
  { key: "failed", label: "Failed", state: "failed" },
  { key: "timeout", label: "Timed out", state: "delayed" },
  { key: "killed", label: "Killed", state: "dead" },
  { key: "skipped", label: "Skipped" },
  { key: "queued", label: "Queued", state: "waiting" },
  { key: "total", label: "Total" },
];

/** Props of {@link RunnerHidden}. */
export interface RunnerHiddenProps {
  /** The API's own explanation (a 401/403 problem's `detail`), shown instead of the default sentence. */
  detail?: string;
}

/** Shown when the caller may not read this runner (`runners.read`), or the API refused. */
export function RunnerHidden({ detail }: RunnerHiddenProps) {
  return (
    <div
      className="screen"
      data-testid="runner-hidden"
    >
      <EmptyState
        title="Runner hidden"
        description={detail ?? "You may not read this runner."}
        action={<Link to="/runners">Back to runners</Link>}
      />
    </div>
  );
}

/** Shown when no runner has this id. */
export function RunnerNotFound({ id }: { id: string }) {
  return (
    <div
      className="screen"
      data-testid="runner-not-found"
    >
      <EmptyState
        title="Runner not found"
        description={
          <>
            There is no runner <code>{id}</code> in this namespace. It may have
            been unregistered, or its process has not started yet.
          </>
        }
        action={<Link to="/runners">Back to runners</Link>}
      />
    </div>
  );
}

/** Props of {@link RunnerSummary}. */
export interface RunnerSummaryProps {
  /** The runner. */
  runner: RunnerInfoDto;
}

/** The runner's settings and state as label/value rows. */
export function RunnerSummary({ runner }: RunnerSummaryProps) {
  return (
    <KeyValue
      className="runner-summary"
      items={[
        { label: "Namespace", value: <code>{runner.namespace}</code> },
        {
          label: "Registered here",
          value: runner.isLocal ? "Yes (local)" : "No (remote)",
          key: "isLocal",
        },
        runner.file !== undefined && {
          label: "File",
          value: <code>{runner.file}</code>,
        },
        {
          label: "Schedule",
          value: (
            <span data-testid="runner-schedule">
              {describeSchedule(runner.schedule)}
            </span>
          ),
        },
        {
          label: "Next run",
          value:
            runner.nextRunAt === null ? (
              "Not scheduled"
            ) : (
              <RelativeTime value={runner.nextRunAt} />
            ),
          hint:
            runner.local &&
            runner.local.nextRunAt !== null &&
            runner.local.nextRunAt !== runner.nextRunAt ? (
              <>
                This process's ticker:{" "}
                <RelativeTime value={runner.local.nextRunAt} />
              </>
            ) : undefined,
        },
        { label: "Execution mode", value: runner.executionMode },
        { label: "Run mode", value: runner.runMode },
        { label: "Queues triggers", value: describeQueueing(runner) },
        {
          label: "Max concurrency",
          value: (
            <span data-testid="runner-concurrency">
              {describeConcurrency(runner.maxConcurrency)}
            </span>
          ),
        },
        {
          label: "Queued triggers",
          value: formatNumber(runner.queuedTriggers),
        },
        {
          label: "Running on",
          value: runner.runningOn ? (
            <>
              <code>{runner.runningOn.runId}</code>
              {runner.runningOn.host !== undefined &&
                ` on ${runner.runningOn.host}`}
              {runner.runningOn.pid !== undefined &&
                ` (pid ${runner.runningOn.pid})`}
              {", since "}
              <RelativeTime value={runner.runningOn.since} />
            </>
          ) : null,
        },
        { label: "Updated", value: <RelativeTime value={runner.updatedAt} /> },
        {
          label: "Last error",
          value: runner.lastError ? (
            <span className="runner-last-error">
              <strong>{runner.lastError.name}</strong>:{" "}
              {runner.lastError.message}
            </span>
          ) : null,
        },
      ]}
    />
  );
}

/** Props of {@link RunnerStatsTiles}. */
export interface RunnerStatsTilesProps {
  /** The counters. */
  stats: RunnerStatsDto;
}

/** The lifetime counters as tiles. */
export function RunnerStatsTiles({ stats }: RunnerStatsTilesProps) {
  return (
    <dl
      className="stat-grid"
      aria-label="Runs by outcome"
      data-testid="runner-stats"
    >
      {STAT_TILES.map(({ key, label, state }) => (
        <div
          key={key}
          className={state ? `stat stat-state state-${state}` : "stat"}
        >
          <dt className="stat-label">{label}</dt>
          <dd className="stat-value">{formatNumber(stats[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The loaded runner: header, summary, stats, runs and history. */
function RunnerDetail({
  runner,
  stats,
  historyEnabled,
}: {
  /** The runner. */
  runner: RunnerInfoDto;
  /** Its counters: `GET /stats`, else the detail's own until that loads. */
  stats: RunnerStatsDto;
  /** Whether the history may be read (the scoped `runners.read`, settled). */
  historyEnabled: boolean;
}) {
  const activeRuns = runner.local?.activeRuns ?? [];
  return (
    <>
      <header className="runner-header">
        <div className="runner-heading">
          <h1 className="screen-title runner-title">{runner.name}</h1>
          <span
            className="runner-badges"
            data-testid="runner-status"
          >
            {runnerBadges(runner).map((badge) => (
              <Badge
                key={badge.label}
                tone={badge.tone}
                title={badge.hint}
              >
                {badge.label}
              </Badge>
            ))}
            {!runner.isLocal && <Badge tone="neutral">Remote</Badge>}
          </span>
          {runner.name !== runner.id && (
            <code
              className="runner-id muted"
              data-testid="runner-id"
            >
              {runner.id}
            </code>
          )}
        </div>
        <RunnerActions runner={runner} />
      </header>

      {!runner.isLocal && (
        <p
          className="notice"
          role="note"
          data-testid="remote-note"
        >
          {REMOTE_RUNNER_NOTE}
        </p>
      )}

      <Card title="Summary">
        <RunnerSummary runner={runner} />
      </Card>

      <Card title="Stats">
        <RunnerStatsTiles stats={stats} />
      </Card>

      {runner.local && (
        <Card title="Active runs">
          {activeRuns.length === 0 ? (
            <p
              className="muted"
              data-testid="no-active-runs"
            >
              Nothing is running in this process.
            </p>
          ) : (
            <ul
              className="run-list"
              aria-label="Active runs"
            >
              {activeRuns.map((run) => (
                <li key={run.runId}>
                  <RunRecordDetails run={run} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Last run">
        {runner.lastRun ? (
          <RunRecordDetails run={runner.lastRun} />
        ) : (
          <p className="muted">This runner has not run yet.</p>
        )}
      </Card>

      <RunnerHistory
        runner={runner.id}
        enabled={historyEnabled}
      />
    </>
  );
}

/**
 * `/runners/:runner`: one runner, polled faster while it runs. Needs
 * `runners.read` for the runner (scoped by the route's
 * `<RunnerPermissionScope>`); without it, or on a 401/403, the runner is
 * hidden and never fetched again.
 */
export function RunnerScreen() {
  const { runner: id = "" } = useParams<{ runner: string }>();
  const api = useApiClient();
  // Scoped to the runner by the route's <RunnerPermissionScope>. Every read
  // waits for that map (`settled`), so an untargeted grant cannot send a read
  // the runner's own answer refuses; a later `false` also stops the polling.
  const canRead = useCan("runners.read");
  const settled = usePermissionsSettled();
  const allowed = canRead && settled;
  const refetchInterval = useRunnerRefetchInterval();

  const detail = useQuery({
    queryKey: runnerKeys.detail(id),
    queryFn: ({ signal }) => getRunner(api, id, signal),
    enabled: allowed,
    refetchInterval: (query) =>
      isRunnerNotFound(query.state.error) || isRunnerDenied(query.state.error)
        ? false
        : refetchInterval(query.state.data),
  });
  const stats = useQuery({
    queryKey: runnerKeys.stats(id),
    queryFn: ({ signal }) => getRunnerStats(api, id, signal),
    enabled: allowed && detail.isSuccess,
    refetchInterval: (query) =>
      isRunnerNotFound(query.state.error) || isRunnerDenied(query.state.error)
        ? false
        : refetchInterval(detail.data),
  });
  // Subscribes once the runner's map allows the read, and stops when the
  // runner turns out to be refused or gone.
  useRunnerLive(
    id,
    allowed && !isRunnerDenied(detail.error) && !isRunnerNotFound(detail.error),
  );

  if (settled && !canRead) {
    return <RunnerHidden />;
  }
  if (isRunnerDenied(detail.error)) {
    return <RunnerHidden detail={detail.error.detail} />;
  }
  if (isRunnerNotFound(detail.error)) {
    return <RunnerNotFound id={id} />;
  }
  return (
    <div
      className="screen runner-screen"
      data-testid="runner-screen"
    >
      <nav
        className="breadcrumb"
        aria-label="Breadcrumb"
      >
        <ol>
          <li>
            <Link to="/runners">Runners</Link>
          </li>
          <li aria-current="page">{id}</li>
        </ol>
      </nav>
      {detail.data ? (
        <>
          {detail.isError && (
            <ProblemBanner
              error={detail.error}
              title="Could not refresh this runner"
              onRetry={() => void detail.refetch()}
            />
          )}
          <RunnerDetail
            runner={detail.data}
            stats={stats.data ?? detail.data.stats}
            historyEnabled={allowed}
          />
        </>
      ) : detail.isError ? (
        <ErrorView
          error={detail.error}
          title="Could not load the runner"
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <Spinner
          label="Loading the runner"
          showLabel
        />
      )}
    </div>
  );
}
