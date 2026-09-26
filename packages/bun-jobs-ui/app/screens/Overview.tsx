import type { ReactNode } from "react";
import type { TimeRange } from "../analytics/range";
import type { JobState } from "../api/contract";
import type {
  AnalyticsSeriesDto,
  JobCounts,
  JobsBucketDto,
  JobsTotalsDto,
  Overview,
  QueueDemandDto,
  QueueSummaryDto,
} from "../api/types";
import type { SectionProps } from "./overview/sections";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useMemo } from "react";
import { AnalyticsError } from "../analytics/AnalyticsError";
import { RangeCaption } from "../analytics/RangeCaption";
import { RangePicker } from "../analytics/RangePicker";
import { useAnalyticsRange } from "../analytics/useAnalyticsRange";
import { useRange, useRangeScope } from "../analytics/useRange";
import {
  analyticsKeys,
  describeResolution,
  getJobsAnalytics,
  getQueueJobsAnalytics,
  isRangeNotRetained,
} from "../api/analytics";
import { JOB_STATES } from "../api/contract";
import { demandKeys, listQueueDemand } from "../api/demand";
import { queryKeys } from "../api/queryKeys";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { ErrorView } from "../components/ErrorView";
import { Checkbox } from "../components/inputs";
import { Pager } from "../components/Pager";
import { Sparkline } from "../components/Sparkline";
import { Spinner } from "../components/Spinner";
import { StateBadge } from "../components/StateBadge";
import { Table } from "../components/Table";
import { useClientPage } from "../components/useClientPage";
import { useApiClient } from "../context";
import { formatNumber, plural } from "../format";
import { useInView } from "../hooks/useInView";
import { SEARCH_SHORTCUT } from "../layout/shortcuts";
import { createLimiter } from "../limiter";
import { usePollInterval } from "../live";
import { useCan, useFeature, useMeta } from "../meta/hooks";
import { POLL_INTERVAL_MS } from "../queryClient";
import { Link } from "../router";
import { useQueryParam } from "../routing";
import { AddedByStateGroup, RunnersSection, WorkersSection } from "./lazy";
import { useAnalyticsGate } from "./overview/gate";
import { useOverviewLive } from "./queues/live";
import { demandFigureHint, formatDemandFigure } from "./queues/panels/demand";
import "./overview/sections.css";

/** Most per-queue analytics requests in flight at once, however many rows are visible. */
const SPARKLINE_CONCURRENCY = 4;

/** Sparklines refresh slower than counts: no event announces a bucket, so they poll at this rate even while live. */
const SPARKLINE_REFETCH_MS = 30_000;

/** Shared across rows so the cap is global. */
const throughputLimiter = createLimiter(SPARKLINE_CONCURRENCY);

/**
 * Queues per page on the Overview.
 *
 * Twenty, like `/queues`: the card is a glance at the namespace, and a row
 * carries eight counts and a sparkline, so more than a screenful defeats it.
 * A sparkline is fetched per visible row, so a page is also what the card
 * costs in analytics reads.
 */
const QUEUE_PAGE_SIZE = 20;

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

/**
 * The "Over the range" tile: what happened to jobs in the range on screen, as
 * a compact label/number list rather than one headline, so several figures
 * fit one tile at a readable size.
 *
 * Two groups, never merged: "Finished in range" from the analytics series (by
 * finish time; failed *attempts*), and — only where `features.addedByState`
 * is true — the jobs added in the range by the state they are in now (by
 * creation time; still stored). They answer different questions, so they
 * are not expected to agree.
 */
function RangeStat({
  jobs,
  added,
}: {
  /** `GET /analytics/jobs` over the range on screen, once it has answered. */
  jobs?: AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto>;
  /** The range the added-by-state group is read over, or absent for no group. */
  added?: TimeRange;
}) {
  const rows: { label: string; value: number; state: JobState }[] = jobs
    ? [
        {
          label: "Completed",
          value: jobs.totals.completed,
          state: "completed",
        },
        // Failed ATTEMPTS, not failed jobs: the series counts every attempt
        // that threw, including ones a retry later completed. Named so it
        // cannot be read as the `failed` state, which reads "Retrying"
        // (STATE_LABELS).
        {
          label: "Failed attempts",
          value: jobs.totals.failed,
          state: "failed",
        },
      ]
    : [];
  return (
    <section
      className="range-band"
      aria-label="Over the range"
      data-testid="range-stat"
    >
      <p className="range-band-head">
        <span className="range-band-title">Over the range</span>
        {jobs && (
          <span className="muted">in {describeResolution(jobs.range)}</span>
        )}
      </p>
      <div className="range-band-groups">
        {jobs && (
          <div className="range-group">
            {/* Named only beside the added group; alone it needs no name. */}
            {added && <p className="range-group-title">Finished in range</p>}
            <dl className="range-cells">
              {rows.map((row) => (
                <div
                  key={row.state}
                  className={`range-cell state-${row.state}`}
                >
                  <dt>{row.label}</dt>
                  <dd>{formatNumber(row.value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {added && (
          <div
            className="range-group range-group-wide"
            data-testid="range-stat-added"
          >
            <AddedByStateGroup range={added} />
          </div>
        )}
      </div>
    </section>
  );
}

/** Props of {@link OverviewSummary}. */
export interface OverviewSummaryProps {
  /** `GET /overview`: the counts, which no range applies to. */
  overview: Overview;
  /**
   * `GET /analytics/jobs` over the range on screen, when it has answered.
   * Its totals replace the deprecated `overview.throughput` window, and its
   * `range.resolution` is what the figure is labelled from.
   */
  jobs?: AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto>;
  /**
   * The range to count the jobs added in, by their state now
   * (`GET /overview/added`). Pass it only where `features.addedByState` is
   * true: absent, the tile shows the analytics series alone and reads nothing
   * more.
   */
  added?: TimeRange;
}

/** The namespace-wide totals: counts from `/overview`, throughput from the analytics series. */
export function OverviewSummary({
  overview,
  jobs,
  added,
}: OverviewSummaryProps) {
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
        {/*
          Throughput belongs to the range the page is showing, so there is no
          fixed-window tile: with no analytics (`meta.analytics` is `null` and
          every analytics route is pruned) the figure is simply absent, rather
          than a "last 60 minutes" that contradicts the range picker above it.
        */}
      </dl>
      {/*
        Its own full-width band, not a tile in the totals grid: inside the grid
        its many figures stacked into one tall column and stretched every
        other tile to match.
      */}
      {(jobs || added) && (
        <RangeStat
          jobs={jobs}
          added={added}
        />
      )}
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

/** Props of {@link QueueSparkline}. */
export interface QueueSparklineProps {
  /** The queue. */
  queue: string;
  /** The range it covers; the response says at what resolution it was served. */
  range: TimeRange;
}

/** A queue's throughput sparkline, fetched once its row scrolls into view. */
export function QueueSparkline({ queue, range }: QueueSparklineProps) {
  const api = useApiClient();
  const [ref, inView] = useInView<HTMLSpanElement>();
  const { key, request } = useAnalyticsRange(range);
  const query = useQuery({
    queryKey: analyticsKeys.queueJobs(queue, key),
    queryFn: ({ signal }) =>
      throughputLimiter.run(() =>
        getQueueJobsAnalytics(api, queue, request(), signal),
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
          label={`${queue}: ${formatNumber(data.totals.completed)} completed, ${formatNumber(data.totals.failed)} failed, in ${describeResolution(data.range)}`}
        />
      ) : query.isError ? (
        <span
          className="muted"
          title={query.error.message}
        >
          {isRangeNotRetained(query.error) ? "not kept" : "unavailable"}
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
  /** Whether to render the throughput column. Needs a `range`. */
  sparklines: boolean;
  /** The range each sparkline covers; required when `sparklines` is on. */
  range?: TimeRange;
  /**
   * The Demand column's readings, by queue name. Absent: no column
   * (`features.demand` off). `readings` is `undefined` while loading.
   */
  demand?: QueueDemandColumn;
}

/** What the Overview queue table's Demand column shows. */
export interface QueueDemandColumn {
  /** Each row's reading, by queue name, or `undefined` while the read is in flight. */
  readings: ReadonlyMap<string, QueueDemandDto> | undefined;
  /** The read's failure, if it failed. */
  error: Error | null;
}

/** The Demand column header's tooltip. */
const DEMAND_COLUMN_HINT =
  "Work a worker could claim now: waiting, due now and stalled; 0 while the queue is paused. What a scaler polls. ≥ marks a lower bound, ≈ an approximate figure. Open a queue's Demand panel for the rest.";

/** Queues with their per-state counts. */
export function QueueTable({
  items,
  sparklines,
  range,
  demand,
}: QueueTableProps) {
  const withSparklines = sparklines && range !== undefined;
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
          {demand && (
            <th
              scope="col"
              className="num"
              title={DEMAND_COLUMN_HINT}
            >
              Demand
            </th>
          )}
          {withSparklines && <th scope="col">Throughput</th>}
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
            {demand && (
              <DemandCell
                queue={queue.name}
                demand={demand}
              />
            )}
            {withSparklines && (
              <td>
                <QueueSparkline
                  queue={queue.name}
                  range={range}
                />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * A row's demand, linked to the queue's Demand panel: the figure as its
 * answer qualifies it (≥, ≈), "—" for a queue the answer left out (the API
 * omits one the caller cannot read, never errors), and a muted word while
 * loading or after a failure.
 */
function DemandCell({
  queue,
  demand,
}: {
  /** The row's queue. */
  queue: string;
  /** The column's readings. */
  demand: QueueDemandColumn;
}) {
  if (demand.readings === undefined) {
    return (
      <td className="num demand">
        {demand.error ? (
          <span
            className="muted"
            title={demand.error.message}
          >
            unavailable
          </span>
        ) : (
          <span
            className="muted"
            aria-label="Loading demand"
          >
            …
          </span>
        )}
      </td>
    );
  }
  const reading = demand.readings.get(queue);
  if (reading === undefined) {
    return (
      <td
        className="num demand muted"
        title="The demand read did not include this queue."
      >
        —
      </td>
    );
  }
  const hint = [
    reading.paused ? "Paused: a paused queue demands nothing." : undefined,
    demandFigureHint(reading, "demand"),
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  return (
    <td
      className={`num demand${reading.demand === 0 ? " zero" : ""}`}
      data-testid={`queue-demand-${queue}`}
    >
      <Link
        to={`/queues/${encodeURIComponent(queue)}?panel=demand`}
        title={hint === "" ? undefined : hint}
      >
        {formatDemandFigure(reading, "demand")}
      </Link>
    </td>
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
function QueuesCard({ range, picker }: SectionProps) {
  const api = useApiClient();
  const canMetrics = useCan("metrics.read");
  const throughput = useFeature("throughput");
  // Every analytics route is pruned when the backend records nothing, so a
  // sparkline would be a 404 per row.
  const analytics = useMeta().analytics ?? null;
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
  // The read brings back every queue the API summarises (and says so when it
  // truncated), so the page is cut here rather than asked for: the filter, the
  // poll and the permissions are untouched.
  const page = useClientPage(queues.data?.items ?? [], QUEUE_PAGE_SIZE);
  // One `GET /demand` for the page on screen, not per row and not for every
  // queue: turning a page reads that page's demand.
  const demandOn = useFeature("demand");
  const pageNames = useMemo(
    () => page.rows.map((queue) => queue.name),
    [page.rows],
  );
  const demand = useQuery({
    queryKey: demandKeys.list(pageNames),
    queryFn: ({ signal }) => listQueueDemand(api, pageNames, signal),
    enabled: demandOn && pageNames.length > 0,
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  const demandReadings = useMemo(
    () =>
      demand.data === undefined
        ? undefined
        : new Map(
            demand.data.queues.map((reading) => [reading.queue, reading]),
          ),
    [demand.data],
  );

  return (
    <Card
      title="Queues"
      actions={picker}
    >
      {/* Under the title rather than beside it: the filter belongs to the
          table below, and the header carries the range control. */}
      <div className="search queues-search">
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
          {...SEARCH_SHORTCUT}
          value={search}
          maxLength={200}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
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
            items={page.rows}
            sparklines={throughput && canMetrics && analytics !== null}
            range={range}
            demand={
              demandOn
                ? { readings: demandReadings, error: demand.error }
                : undefined
            }
          />
          {page.paged && (
            <Pager
              label="Queue pages"
              offset={page.offset}
              limit={page.limit}
              total={page.total}
              itemCount={page.rows.length}
              onChange={page.onChange}
            />
          )}
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

/** The namespace-wide totals card, read over `range`. */
function SummaryCard({ range, picker }: SectionProps) {
  const api = useApiClient();
  // Where the backend cannot count by creation time the route does not
  // exist, so nothing is read and the tile keeps the series alone.
  const addedByState = useFeature("addedByState");
  const refetchInterval = usePollInterval(POLL_INTERVAL_MS);
  const { analytics, key, request } = useAnalyticsRange(range);
  useOverviewLive({ overview: true, search: null });
  // The counts are a snapshot, not a window, so `/overview` is read without
  // the deprecated `minutes`; everything the range applies to comes from the
  // analytics series below.
  const overview = useQuery({
    queryKey: queryKeys.overview(),
    queryFn: ({ signal }) => api.getOverview(undefined, signal),
    refetchInterval,
  });
  const jobs = useQuery({
    queryKey: analyticsKeys.jobs(key),
    queryFn: ({ signal }) => getJobsAnalytics(api, request(), signal),
    enabled: analytics !== null,
    refetchInterval,
  });
  return (
    <Card
      title="Jobs"
      actions={picker}
    >
      <RangeCaption
        range={jobs.data?.range}
        testId="jobs-range-caption"
      />
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
        <>
          <OverviewSummary
            overview={overview.data}
            jobs={jobs.data}
            added={addedByState ? range : undefined}
          />
          {jobs.isError ? (
            <AnalyticsError
              error={jobs.error}
              title="Could not load job analytics"
              onRetry={() => void jobs.refetch()}
              testId="jobs-range-not-retained"
            />
          ) : (
            jobs.data && (
              <div
                className="overview-jobs-chart"
                data-testid="jobs-series"
              >
                <Sparkline
                  values={jobs.data.buckets.map((bucket) => bucket.completed)}
                  secondary={jobs.data.buckets.map((bucket) => bucket.failed)}
                  label={`Every queue: ${formatNumber(jobs.data.totals.completed)} completed, ${formatNumber(jobs.data.totals.failed)} failed, in ${describeResolution(jobs.data.range)}`}
                  width={240}
                />
              </div>
            )
          )}
        </>
      )}
    </Card>
  );
}

/** The start page: namespace-wide counts, and the queue table, over a chosen range. */
export function OverviewScreen() {
  const canMetrics = useCan("metrics.read");
  const canQueues = useCan("queues.list");
  // What this API can actually serve; an older one reports none and the
  // picker falls back to the contract's ceiling.
  const maxSpan = useMeta().analytics?.maxSpanMs;
  const [applyToPage, setApplyToPage] = useRangeScope();
  const [pageRange, setPageRange] = useRange("range");
  const [jobsRange, setJobsRange] = useRange("jobsRange");
  const [queuesRange, setQueuesRange] = useRange("queuesRange");
  const [runnersRange, setRunnersRange] = useRange("runnersRange");
  const [workersRange, setWorkersRange] = useRange("workersRange");
  // Decided here, outside the sections, so a deployment recording nothing
  // never fetches their chunk.
  const canRunnerMetrics = useAnalyticsGate("runners");
  const canWorkerMetrics = useAnalyticsGate("workers");

  /** One section's range and its own control, by whether the page-wide one is in force. */
  const section = (
    range: TimeRange,
    set: (next: TimeRange) => void,
    label: string,
  ): SectionProps => ({
    range: applyToPage ? pageRange : range,
    picker: applyToPage ? null : (
      <RangePicker
        range={range}
        onChange={set}
        label={label}
        maxSpan={maxSpan}
      />
    ),
  });

  return (
    <div
      className="screen"
      data-testid="overview"
    >
      <div className="overview-header">
        <h1 className="screen-title">Overview</h1>
        <div className="overview-range">
          {applyToPage && (
            <RangePicker
              range={pageRange}
              onChange={setPageRange}
              label="Range for every section"
              maxSpan={maxSpan}
            />
          )}
          <Checkbox
            className="range-scope"
            checked={applyToPage}
            onChange={setApplyToPage}
            label="Apply date filter to page"
            hint="One range for every section, so the numbers are comparable. Off: each section has its own."
          />
        </div>
      </div>
      {canMetrics && (
        <SummaryCard {...section(jobsRange, setJobsRange, "Jobs range")} />
      )}
      {canQueues && (
        <QueuesCard {...section(queuesRange, setQueuesRange, "Queues range")} />
      )}
      {canRunnerMetrics && (
        <RunnersSection
          {...section(runnersRange, setRunnersRange, "Runners range")}
        />
      )}
      {canWorkerMetrics && (
        <WorkersSection
          {...section(workersRange, setWorkersRange, "Workers range")}
        />
      )}
      {!canMetrics && !canQueues && (
        <EmptyState
          title="Nothing to show"
          description="You may not read metrics or list queues on this API."
        />
      )}
    </div>
  );
}
