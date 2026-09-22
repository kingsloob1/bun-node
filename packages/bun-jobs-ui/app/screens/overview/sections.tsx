import type { ReactNode } from "react";
import type { TimeRange } from "../../analytics/range";
import type {
  RunnerAnalyticsRowDto,
  RunnerAnalyticsSeriesDto,
  RunnersAnalyticsDto,
  WorkerAnalyticsRowDto,
  WorkerAnalyticsSeriesDto,
  WorkersAnalyticsDto,
} from "../../api/types";
import type { PageWindow } from "../../components/pagerState";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AnalyticsError } from "../../analytics/AnalyticsError";
import { RangeCaption } from "../../analytics/RangeCaption";
import { useAnalyticsRange } from "../../analytics/useAnalyticsRange";
import {
  analyticsKeys,
  derivedInFlight,
  describeAxis,
  getRunnersAnalytics,
  getWorkersAnalytics,
  isRangeNotRetained,
} from "../../api/analytics";
import { MAX_ANALYTICS_SERIES } from "../../api/contract";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Pager } from "../../components/Pager";
import { Sparkline } from "../../components/Sparkline";
import { Spinner } from "../../components/Spinner";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { formatNumber, plural } from "../../format";
import { usePollInterval } from "../../live";
import { POLL_INTERVAL_MS } from "../../queryClient";
import { useAnalyticsGate } from "./gate";
import "./sections.css";

/**
 * The Overview's Runners and Workers sections.
 *
 * **Each section costs two requests, whatever the entity count.** The roll-up
 * read brings back one summed series plus a page of scalar rows, and a single
 * batch read brings back the sparklines of the rows *actually on screen* —
 * `ids=` / `keys=`, capped at `meta.analytics.maxSeries`, which is also the
 * page size, so one page is always exactly one batch request. A namespace with
 * 200 workers therefore costs three series (jobs, the runners roll-up, the
 * workers roll-up) and one page of sparklines, not 200 series.
 *
 * Every axis and every caption is written from the resolution the **response**
 * reports, never the one the request asked for.
 */

/**
 * What a runner series' `failed` counts, said wherever it is shown: a run that
 * **threw**. A timeout and a kill are their own counters, so this is not the
 * lifetime `stat:failed` (which lumps all three) and must never be totalled
 * against it.
 */
const FAILED_MEANS =
  "Runs that threw. Timeouts and kills are counted apart, so this is not the runner's lifetime failed count.";

/** How often a section's sparklines are re-read; no event announces a bucket, so they poll even while live. */
const ANALYTICS_REFETCH_MS = 30_000;

/** What every Overview section takes: the range it shows, and the control to render in its header. */
export interface SectionProps {
  /** The range this section is read over. */
  range: TimeRange;
  /** This section's own range control, or `null` while the page-wide one is in force. */
  picker: ReactNode;
}

/** Props of {@link Figure}. */
interface FigureProps {
  /** What it counts. */
  label: string;
  /** The figure, already formatted. */
  value: string;
  /** A qualifier below it, e.g. that a number is derived. */
  hint?: string;
}

/** One headline figure of a section. */
function Figure({ label, value, hint }: FigureProps) {
  return (
    <div className="stat">
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value">{value}</dd>
      {hint && <dd className="stat-hint">{hint}</dd>}
    </div>
  );
}

/** What {@link usePage} works out. */
interface PageState extends PageWindow {
  /** Sets the window the pager asked for. */
  setWindow: (next: PageWindow) => void;
}

/**
 * The page of rows on screen, and the pager driving it.
 *
 * The page size is capped at `meta.analytics.maxSeries` so the sparklines of
 * one page are always exactly one batch request; the rows themselves came back
 * with the roll-up, so turning a page costs no further roll-up read.
 */
function usePage(rowCount: number, maxSeries: number): PageState {
  const [window, setWindow] = useState<PageWindow>(() => ({
    offset: 0,
    limit: maxSeries,
  }));
  return {
    // A shrinking list (a narrower range, an entity gone) must not leave the
    // pager stranded past the end with nothing to show.
    offset: window.offset < rowCount ? window.offset : 0,
    limit: Math.max(1, Math.min(window.limit, maxSeries)),
    setWindow,
  };
}

/** The Overview's Runners section: one summed series, a headline, and a page of runners. */
export function RunnersSection({ range, picker }: SectionProps) {
  const api = useApiClient();
  const enabled = useAnalyticsGate("runners");
  const { analytics, key, request } = useAnalyticsRange(range);
  const maxSeries = analytics?.maxSeries ?? MAX_ANALYTICS_SERIES;
  const refetchInterval = usePollInterval(POLL_INTERVAL_MS);

  const rollup = useQuery({
    queryKey: analyticsKeys.runners(key),
    queryFn: ({ signal }) =>
      getRunnersAnalytics(api, request(), undefined, signal),
    enabled,
    refetchInterval,
  });

  const rows: readonly RunnerAnalyticsRowDto[] = rollup.data?.rows ?? [];
  const page = usePage(rows.length, maxSeries);
  const visible = rows.slice(page.offset, page.offset + page.limit);
  const ids = visible.map((row) => row.runner);

  const series = useQuery({
    queryKey: analyticsKeys.runnerSeries(ids, key),
    queryFn: ({ signal }) => getRunnersAnalytics(api, request(), ids, signal),
    enabled: enabled && ids.length > 0,
    refetchInterval: ANALYTICS_REFETCH_MS,
    staleTime: ANALYTICS_REFETCH_MS - 5_000,
  });
  const byId = new Map<string, RunnerAnalyticsSeriesDto>(
    (series.data?.seriesByRunner ?? []).map((entry) => [entry.runner, entry]),
  );

  if (!enabled) {
    return null;
  }
  return (
    <Card
      title="Runners"
      actions={picker}
      className="analytics-section"
    >
      <div data-testid="runners-analytics">
        <RangeCaption
          range={rollup.data?.series.range}
          testId="runners-range-caption"
        />
        {rollup.isPending ? (
          <Spinner
            label="Loading runner analytics"
            showLabel
          />
        ) : rollup.isError ? (
          <AnalyticsError
            error={rollup.error}
            title="Could not load runner analytics"
            onRetry={() => void rollup.refetch()}
            testId="runners-range-not-retained"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No runners"
            description="This API reaches no runners, so there is nothing to chart. A runner with nothing in the range still gets a row of zeros."
          />
        ) : (
          <>
            <RunnersHeadline data={rollup.data} />
            <Table label="Runners">
              <thead>
                <tr>
                  <th scope="col">Runner</th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Started
                  </th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Succeeded
                  </th>
                  <th
                    scope="col"
                    className="num"
                    title={FAILED_MEANS}
                  >
                    Failed
                  </th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Timed out / killed
                  </th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Running now
                  </th>
                  <th scope="col">Runs over time</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.runner}
                    data-testid={`runner-analytics-row-${row.runner}`}
                  >
                    <th
                      scope="row"
                      className="queue-name"
                    >
                      {row.runner}
                    </th>
                    <td className="num">{formatNumber(row.totals.started)}</td>
                    <td className="num">
                      {formatNumber(row.totals.succeeded)}
                    </td>
                    <td className="num">{formatNumber(row.totals.failed)}</td>
                    <td className="num">
                      {formatNumber(row.totals.timeout)} /{" "}
                      {formatNumber(row.totals.killed)}
                    </td>
                    <td className="num">{formatNumber(row.runningNow)}</td>
                    <td>
                      <RowSparkline
                        failed={series.isError ? series.error : null}
                        entry={byId.get(row.runner)}
                        render={(entry) => (
                          <Sparkline
                            values={entry.runs.buckets.map(
                              (bucket) => bucket.started,
                            )}
                            secondary={entry.runs.buckets.map(
                              (bucket) => bucket.failed,
                            )}
                            label={`${row.runner}: ${formatNumber(entry.runs.totals.started)} started, ${formatNumber(entry.runs.totals.failed)} failed, ${describeAxis(entry.runs.range)}`}
                          />
                        )}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              label="Runner pages"
              offset={page.offset}
              limit={page.limit}
              total={rows.length}
              itemCount={visible.length}
              maxPageSize={maxSeries}
              onChange={page.setWindow}
            />
            {rollup.data.truncated && (
              <p
                className="notice"
                role="note"
                data-testid="runners-truncated"
              >
                Showing the {plural(rows.length, "busiest runner")} of{" "}
                {formatNumber(rollup.data.totalRows)}, ranked by runs started in
                this range.
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/** The Runners section's headline: the summed series, its totals, and the instantaneous `runningNow`. */
function RunnersHeadline({
  data,
}: {
  /** The roll-up response. */
  data: RunnersAnalyticsDto;
}) {
  const { series, runningNow, truncated } = data;
  return (
    <div className="analytics-headline">
      <dl
        className="stat-grid"
        aria-label="Runner totals"
      >
        <Figure
          label="Started"
          value={formatNumber(series.totals.started)}
        />
        <Figure
          label="Succeeded"
          value={formatNumber(series.totals.succeeded)}
        />
        <Figure
          label="Failed"
          value={formatNumber(series.totals.failed)}
          hint={FAILED_MEANS}
        />
        <Figure
          label="Timed out / killed"
          value={`${formatNumber(series.totals.timeout)} / ${formatNumber(series.totals.killed)}`}
        />
        <Figure
          label="Running now"
          value={formatNumber(runningNow)}
          hint={
            truncated
              ? "From the locks, right now — not a figure about the range. Beyond the runners listed it counts only this process's own."
              : "From the locks, right now — not a figure about the range."
          }
        />
      </dl>
      <div className="analytics-charts">
        <Sparkline
          values={series.buckets.map((bucket) => bucket.started)}
          secondary={series.buckets.map((bucket) => bucket.failed)}
          label={`Every runner: ${formatNumber(series.totals.started)} started, ${formatNumber(series.totals.failed)} failed, ${describeAxis(series.range)}`}
          width={240}
        />
        <Sparkline
          values={derivedInFlight(series.buckets)}
          label={`Runs in flight (derived from started minus finished, and drifting across the range boundary), ${describeAxis(series.range)}`}
          width={240}
        />
        <p className="analytics-note">
          The second line is <strong>derived</strong> from started minus
          finished; it drifts across the range boundary. “Running now” above is
          the honest instantaneous figure.
        </p>
      </div>
    </div>
  );
}

/** The Overview's Workers section: one summed series, a headline, and a page of worker keys. */
export function WorkersSection({ range, picker }: SectionProps) {
  const api = useApiClient();
  const enabled = useAnalyticsGate("workers");
  const { analytics, key, request } = useAnalyticsRange(range);
  const maxSeries = analytics?.maxSeries ?? MAX_ANALYTICS_SERIES;
  const refetchInterval = usePollInterval(POLL_INTERVAL_MS);

  const rollup = useQuery({
    queryKey: analyticsKeys.workers(key),
    queryFn: ({ signal }) =>
      getWorkersAnalytics(api, request(), undefined, signal),
    enabled,
    refetchInterval,
  });

  const rows: readonly WorkerAnalyticsRowDto[] = rollup.data?.rows ?? [];
  const page = usePage(rows.length, maxSeries);
  const visible = rows.slice(page.offset, page.offset + page.limit);
  // The stable key, never the per-incarnation id: a rolling redeploy would
  // otherwise end one series and start another.
  const keys = visible.map((row) => row.key);

  const series = useQuery({
    queryKey: analyticsKeys.workerSeries(keys, key),
    queryFn: ({ signal }) => getWorkersAnalytics(api, request(), keys, signal),
    enabled: enabled && keys.length > 0,
    refetchInterval: ANALYTICS_REFETCH_MS,
    staleTime: ANALYTICS_REFETCH_MS - 5_000,
  });
  const byKey = new Map<string, WorkerAnalyticsSeriesDto>(
    (series.data?.seriesByKey ?? []).map((entry) => [entry.key, entry]),
  );

  if (!enabled) {
    return null;
  }
  return (
    <Card
      title="Workers"
      actions={picker}
      className="analytics-section"
    >
      <div data-testid="workers-analytics">
        <RangeCaption
          range={rollup.data?.series.range}
          testId="workers-range-caption"
        />
        {rollup.isPending ? (
          <Spinner
            label="Loading worker analytics"
            showLabel
          />
        ) : rollup.isError ? (
          <AnalyticsError
            error={rollup.error}
            title="Could not load worker analytics"
            onRetry={() => void rollup.refetch()}
            testId="workers-range-not-retained"
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No workers to show"
            description="No worker is live, and none completed or failed anything over the range shown."
          />
        ) : (
          <>
            <WorkersHeadline data={rollup.data} />
            <Table label="Workers">
              <thead>
                <tr>
                  <th scope="col">Worker</th>
                  <th scope="col">Queue</th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Completed
                  </th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Failed
                  </th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Busy
                  </th>
                  <th scope="col">Jobs over time</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.key}
                    data-testid={`worker-analytics-row-${row.key}`}
                  >
                    <th
                      scope="row"
                      className="queue-name"
                    >
                      {row.key}
                    </th>
                    <td>{row.queue}</td>
                    <td className="num">
                      {formatNumber(row.totals.completed)}
                    </td>
                    <td className="num">{formatNumber(row.totals.failed)}</td>
                    <td className="num">
                      {row.busyness ? (
                        row.busyness.samples === 0 ? (
                          <span
                            className="muted"
                            title="No heartbeat landed in this range, so nothing was sampled — not that it was idle."
                          >
                            —
                          </span>
                        ) : (
                          `${row.busyness.activeMean.toFixed(1)} / ${formatNumber(row.busyness.concurrency)}`
                        )
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <RowSparkline
                        failed={series.isError ? series.error : null}
                        entry={byKey.get(row.key)}
                        render={(entry) => (
                          <Sparkline
                            values={entry.jobs.buckets.map(
                              (bucket) => bucket.completed,
                            )}
                            secondary={entry.jobs.buckets.map(
                              (bucket) => bucket.failed,
                            )}
                            label={`${row.key}: ${formatNumber(entry.jobs.totals.completed)} completed, ${formatNumber(entry.jobs.totals.failed)} failed, ${describeAxis(entry.jobs.range)}`}
                          />
                        )}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pager
              label="Worker pages"
              offset={page.offset}
              limit={page.limit}
              total={rows.length}
              itemCount={visible.length}
              maxPageSize={maxSeries}
              onChange={page.setWindow}
            />
            {rollup.data.truncated && (
              <p
                className="notice"
                role="note"
                data-testid="workers-truncated"
              >
                Showing the {plural(rows.length, "busiest worker key")} of{" "}
                {formatNumber(rollup.data.totalRows)}, ranked by jobs completed
                in this range.
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

/** The Workers section's headline: the summed throughput series and its totals. */
function WorkersHeadline({
  data,
}: {
  /** The roll-up response. */
  data: WorkersAnalyticsDto;
}) {
  const { series } = data;
  return (
    <div className="analytics-headline">
      <dl
        className="stat-grid"
        aria-label="Worker totals"
      >
        <Figure
          label="Completed"
          value={formatNumber(series.totals.completed)}
        />
        <Figure
          label="Failed"
          value={formatNumber(series.totals.failed)}
        />
        <Figure
          label="Worker keys"
          value={formatNumber(data.totalRows)}
          hint="Stable keys, not incarnations: a redeploy keeps one row."
        />
      </dl>
      <div className="analytics-charts">
        <Sparkline
          values={series.buckets.map((bucket) => bucket.completed)}
          secondary={series.buckets.map((bucket) => bucket.failed)}
          label={`Every worker: ${formatNumber(series.totals.completed)} completed, ${formatNumber(series.totals.failed)} failed, ${describeAxis(series.range)}`}
          width={240}
        />
        <p
          className="analytics-note"
          data-testid="workers-rows-note"
        >
          A row is a worker key that did work in this range or is live now — a
          stopped worker keeps its row while its counts are in range, and a live
          one with nothing to show has a row of zeros. It is not a list of
          running workers.
        </p>
      </div>
    </div>
  );
}

/** Props of {@link RowSparkline}. */
interface RowSparklineProps<TEntry> {
  /** The batch entry for this row, or `undefined` while the batch read is in flight. */
  entry: TEntry | undefined;
  /** The batch read's error, or `null` — a failed batch leaves the rows and only loses their sparklines. */
  failed: Error | null;
  /** Draws the sparkline once the entry arrived. */
  render: (entry: TEntry) => ReactNode;
}

/** One row's sparkline cell: the chart, "unavailable" when the batch failed, or a placeholder while it loads. */
function RowSparkline<TEntry>({
  entry,
  failed,
  render,
}: RowSparklineProps<TEntry>) {
  return (
    <span className="sparkline-cell">
      {entry ? (
        render(entry)
      ) : failed ? (
        <span
          className="muted"
          title={failed.message}
        >
          {isRangeNotRetained(failed) ? "not kept" : "unavailable"}
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
