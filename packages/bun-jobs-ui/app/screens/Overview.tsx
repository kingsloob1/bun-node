import type { ReactNode } from "react";
import type { JobCounts, Overview, QueueSummaryDto } from "../api/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId } from "react";
import { JOB_STATES } from "../api/contract";
import { queryKeys } from "../api/queryKeys";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { ErrorView } from "../components/ErrorView";
import { Sparkline } from "../components/Sparkline";
import { Spinner } from "../components/Spinner";
import { StateBadge } from "../components/StateBadge";
import { Table } from "../components/Table";
import { useApiClient } from "../context";
import { formatNumber, plural } from "../format";
import { useInView } from "../hooks/useInView";
import { createLimiter } from "../limiter";
import { usePollInterval } from "../live";
import { useCan, useFeature } from "../meta/hooks";
import { POLL_INTERVAL_MS } from "../queryClient";
import { Link } from "../router";
import { useQueryParam } from "../routing";
import { useOverviewLive } from "./queues/live";

/** Minutes of throughput each row's sparkline covers. */
const SPARKLINE_MINUTES = 60;

/** Most throughput requests in flight at once, however many rows are visible. */
const SPARKLINE_CONCURRENCY = 4;

/** Sparklines refresh slower than counts: their buckets are a minute wide. No event announces a bucket, so they poll at this rate even while live. */
const SPARKLINE_REFETCH_MS = 30_000;

/** Shared across rows so the cap is global. */
const throughputLimiter = createLimiter(SPARKLINE_CONCURRENCY);

/** One stat tile. */
function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`stat ${className ?? ""}`}>
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value">{value}</dd>
      {hint && <dd className="stat-hint">{hint}</dd>}
    </div>
  );
}

/** The namespace-wide totals. */
export function OverviewSummary({ overview }: { overview: Overview }) {
  return (
    <div className="overview-summary">
      <dl
        className="stat-grid"
        aria-label="Jobs by state"
        data-testid="state-counts"
      >
        {JOB_STATES.map((state) => (
          <Stat
            key={state}
            className={`stat-state state-${state}`}
            label={<StateBadge state={state} />}
            value={formatNumber(overview.counts[state])}
          />
        ))}
      </dl>
      <dl
        className="stat-grid stat-grid-totals"
        aria-label="Totals"
      >
        <Stat
          label="Total jobs"
          value={formatNumber(overview.total)}
        />
        <Stat
          label="Queues"
          value={formatNumber(overview.queues)}
          hint={`${formatNumber(overview.pausedQueues)} paused`}
        />
        {overview.workers !== undefined && (
          <Stat
            label="Workers"
            value={formatNumber(overview.workers)}
          />
        )}
        {overview.throughput && (
          <Stat
            label={`Last ${plural(overview.throughput.minutes, "minute")}`}
            value={`${formatNumber(overview.throughput.completed)} completed`}
            hint={`${formatNumber(overview.throughput.failed)} failed`}
          />
        )}
      </dl>
      {overview.truncated && (
        <p
          className="notice"
          role="note"
        >
          These totals cover only the first {plural(overview.queues, "queue")}:
          the API summarises at most that many.
        </p>
      )}
    </div>
  );
}

/** A queue's throughput sparkline, fetched once its row scrolls into view. */
export function QueueSparkline({ queue }: { queue: string }) {
  const api = useApiClient();
  const [ref, inView] = useInView<HTMLSpanElement>();
  const query = useQuery({
    queryKey: queryKeys.queueThroughput(queue, SPARKLINE_MINUTES),
    queryFn: ({ signal }) =>
      throughputLimiter.run(() =>
        api.getQueueThroughput(queue, SPARKLINE_MINUTES, signal),
      ),
    enabled: inView,
    refetchInterval: SPARKLINE_REFETCH_MS,
    staleTime: SPARKLINE_REFETCH_MS - 5_000,
  });
  const data = query.data;
  return (
    <span
      ref={ref}
      className="sparkline-cell"
    >
      {data ? (
        <Sparkline
          values={data.buckets.map((bucket) => bucket.completed)}
          secondary={data.buckets.map((bucket) => bucket.failed)}
          label={`${queue}: ${formatNumber(data.completed)} completed, ${formatNumber(data.failed)} failed in the last ${plural(SPARKLINE_MINUTES, "minute")}`}
        />
      ) : query.isError ? (
        <span
          className="muted"
          title={query.error.message}
        >
          unavailable
        </span>
      ) : (
        <span
          className="sparkline-placeholder"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

/** Props of {@link QueueTable}. */
export interface QueueTableProps {
  /** The queues. */
  items: readonly QueueSummaryDto[];
  /** Whether to render the throughput column. */
  sparklines: boolean;
}

/** Queues with their per-state counts. */
export function QueueTable({ items, sparklines }: QueueTableProps) {
  return (
    <Table label="Queues">
      <thead>
        <tr>
          <th scope="col">Queue</th>
          {JOB_STATES.map((state) => (
            <th
              key={state}
              scope="col"
              className="num"
            >
              <StateBadge state={state} />
            </th>
          ))}
          <th
            scope="col"
            className="num"
          >
            Total
          </th>
          {sparklines && <th scope="col">Throughput</th>}
        </tr>
      </thead>
      <tbody>
        {items.map((queue) => (
          <tr
            key={queue.name}
            data-testid={`queue-row-${queue.name}`}
          >
            <th
              scope="row"
              className="queue-name"
            >
              <Link to={`/queues/${encodeURIComponent(queue.name)}`}>
                {queue.name}
              </Link>
              {queue.paused && (
                <Badge
                  tone="warning"
                  className="queue-paused"
                >
                  Paused
                </Badge>
              )}
            </th>
            {JOB_STATES.map((state) => (
              <CountCell
                key={state}
                counts={queue.counts}
                state={state}
              />
            ))}
            <td className="num total">{formatNumber(queue.total)}</td>
            {sparklines && (
              <td>
                <QueueSparkline queue={queue.name} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** One count cell; zero is dimmed so the non-zero counts stand out. */
function CountCell({
  counts,
  state,
}: {
  counts: JobCounts;
  state: (typeof JOB_STATES)[number];
}) {
  const value = counts[state];
  return (
    <td className={`num count state-${state}${value === 0 ? " zero" : ""}`}>
      {formatNumber(value)}
    </td>
  );
}

/** The queue list card: search box, table, truncated notice, empty states. */
function QueuesCard() {
  const api = useApiClient();
  const canMetrics = useCan("metrics.read");
  const throughput = useFeature("throughput");
  const [search, setSearch] = useQueryParam("q");
  const deferredSearch = useDeferredValue(search);
  const searchId = useId();
  const refetchInterval = usePollInterval(POLL_INTERVAL_MS);
  useOverviewLive({ overview: false, search: deferredSearch });
  const queues = useQuery({
    queryKey: queryKeys.queues(deferredSearch),
    queryFn: ({ signal }) => api.listQueues(deferredSearch, signal),
    refetchInterval,
    placeholderData: keepPreviousData,
  });

  return (
    <Card
      title="Queues"
      actions={
        <div className="search">
          <label
            htmlFor={searchId}
            className="visually-hidden"
          >
            Filter queues by name
          </label>
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder="Filter queues"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      }
    >
      {queues.isPending ? (
        <Spinner
          label="Loading queues"
          showLabel
        />
      ) : queues.isError ? (
        <ErrorView
          error={queues.error}
          title="Could not load queues"
          onRetry={() => void queues.refetch()}
        />
      ) : queues.data.items.length === 0 ? (
        deferredSearch ? (
          <EmptyState
            title="No queues match"
            description={`No queue name contains “${deferredSearch}”.`}
          />
        ) : (
          <EmptyState
            title="No queues yet"
            description="Queues appear here once a job is added to one."
          />
        )
      ) : (
        <>
          <QueueTable
            items={queues.data.items}
            sparklines={throughput && canMetrics}
          />
          {queues.data.truncated && (
            <p
              className="notice"
              role="note"
              data-testid="queues-truncated"
            >
              Showing the first {plural(queues.data.items.length, "queue")}.
              More exist; narrow the filter to find the others.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** The namespace-wide totals card. */
function SummaryCard() {
  const api = useApiClient();
  const refetchInterval = usePollInterval(POLL_INTERVAL_MS);
  useOverviewLive({ overview: true, search: null });
  const overview = useQuery({
    queryKey: queryKeys.overview(),
    queryFn: ({ signal }) => api.getOverview(undefined, signal),
    refetchInterval,
  });
  return (
    <Card title="Jobs">
      {overview.isPending ? (
        <Spinner
          label="Loading the overview"
          showLabel
        />
      ) : overview.isError ? (
        <ErrorView
          error={overview.error}
          title="Could not load the overview"
          onRetry={() => void overview.refetch()}
        />
      ) : (
        <OverviewSummary overview={overview.data} />
      )}
    </Card>
  );
}

/** The start page: namespace-wide counts, and the queue table. */
export function OverviewScreen() {
  const canMetrics = useCan("metrics.read");
  const canQueues = useCan("queues.list");
  return (
    <div
      className="screen"
      data-testid="overview"
    >
      <h1 className="screen-title">Overview</h1>
      {canMetrics && <SummaryCard />}
      {canQueues && <QueuesCard />}
      {!canMetrics && !canQueues && (
        <EmptyState
          title="Nothing to show"
          description="You may not read metrics or list queues on this API."
        />
      )}
    </div>
  );
}
