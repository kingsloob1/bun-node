import { useQuery } from "@tanstack/react-query";
import { AnalyticsError } from "../../analytics/AnalyticsError";
import { RangeCaption } from "../../analytics/RangeCaption";
import { RangePicker } from "../../analytics/RangePicker";
import { useAnalyticsRange } from "../../analytics/useAnalyticsRange";
import { useRange } from "../../analytics/useRange";
import {
  analyticsKeys,
  describeAxis,
  getWorkerAnalytics,
} from "../../api/analytics";
import { Card } from "../../components/Card";
import { Sparkline } from "../../components/Sparkline";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { formatNumber } from "../../format";
import { usePollInterval } from "../../live";
import { POLL_INTERVAL_MS } from "../../queryClient";
import { useAnalyticsGate } from "../overview/gate";

/** Props of {@link WorkerAnalyticsCard}. */
export interface WorkerAnalyticsCardProps {
  /** The queue the key's workers consume. */
  queue: string;
  /** The stable key the series is recorded under — never an incarnation id. */
  workerKey: string;
}

/**
 * One worker key's throughput and busyness over a chosen range
 * (`GET /queues/:queue/analytics/workers/:key`), keyed by the stable key so a
 * redeploy does not end the series.
 *
 * Throughput and busyness come back with **their own** ranges: busyness is
 * sampled from heartbeats and served coarser. Each is captioned from its own
 * response's `range`, never from what was asked for. Rendered only where the
 * Overview's Workers section would be (`metrics.read`,
 * `features.workerMetrics`, `meta.analytics`, recording workers).
 */
export function WorkerAnalyticsCard({
  queue,
  workerKey,
}: WorkerAnalyticsCardProps) {
  const api = useApiClient();
  const enabled = useAnalyticsGate("workers");
  const [range, setRange] = useRange("range");
  const { analytics, key, request } = useAnalyticsRange(range);
  const refetchInterval = usePollInterval(POLL_INTERVAL_MS);
  const series = useQuery({
    queryKey: analyticsKeys.worker(queue, workerKey, key),
    queryFn: ({ signal }) =>
      getWorkerAnalytics(api, queue, workerKey, request(), signal),
    enabled,
    refetchInterval,
  });

  if (!enabled) {
    return null;
  }
  return (
    <Card
      title="Throughput and busyness"
      className="analytics-section"
      actions={
        <RangePicker
          range={range}
          onChange={setRange}
          label="Range for this worker's numbers"
          maxSpan={analytics?.maxSpanMs}
        />
      }
    >
      <div
        className="worker-analytics"
        data-testid="worker-analytics"
      >
        {series.isPending ? (
          <Spinner
            label="Loading this worker's numbers"
            showLabel
          />
        ) : series.isError ? (
          <AnalyticsError
            error={series.error}
            title="Could not load this worker's numbers"
            onRetry={() => void series.refetch()}
            testId="worker-range-not-retained"
          />
        ) : (
          <>
            <section aria-label="Throughput">
              <h3 className="worker-analytics-title">Throughput</h3>
              <RangeCaption
                range={series.data.jobs.range}
                always
                testId="worker-jobs-range-caption"
              />
              <div className="analytics-headline">
                <dl
                  className="stat-grid"
                  aria-label="Throughput totals"
                >
                  <div className="stat">
                    <dt className="stat-label">Completed</dt>
                    <dd className="stat-value">
                      {formatNumber(series.data.jobs.totals.completed)}
                    </dd>
                  </div>
                  <div className="stat">
                    <dt className="stat-label">Failed</dt>
                    <dd className="stat-value">
                      {formatNumber(series.data.jobs.totals.failed)}
                    </dd>
                    <dd className="stat-hint">Attempts that failed.</dd>
                  </div>
                </dl>
                <div className="analytics-charts">
                  <Sparkline
                    values={series.data.jobs.buckets.map(
                      (bucket) => bucket.completed,
                    )}
                    secondary={series.data.jobs.buckets.map(
                      (bucket) => bucket.failed,
                    )}
                    label={`${workerKey}: ${formatNumber(series.data.jobs.totals.completed)} completed, ${formatNumber(series.data.jobs.totals.failed)} failed, ${describeAxis(series.data.jobs.range)}`}
                    width={240}
                  />
                </div>
              </div>
            </section>
            {series.data.busyness ? (
              <section aria-label="Busyness">
                <h3 className="worker-analytics-title">Busyness</h3>
                <RangeCaption
                  range={series.data.busyness.range}
                  always
                  testId="worker-busyness-range-caption"
                />
                {series.data.busyness.totals.samples === 0 ? (
                  <p
                    className="muted"
                    data-testid="worker-busyness-no-samples"
                  >
                    No heartbeat landed in this range, so nothing was sampled —
                    the worker was not reporting, which is not the same as idle.
                  </p>
                ) : (
                  <div className="analytics-headline">
                    <dl
                      className="stat-grid"
                      aria-label="Busyness totals"
                    >
                      <div className="stat">
                        <dt className="stat-label">Mean in flight</dt>
                        <dd className="stat-value">
                          {series.data.busyness.totals.activeMean.toFixed(1)} /{" "}
                          {formatNumber(
                            series.data.busyness.totals.concurrency,
                          )}
                        </dd>
                        <dd className="stat-hint">
                          Against the concurrency of the last sample.
                        </dd>
                      </div>
                      <div className="stat">
                        <dt className="stat-label">Most in flight</dt>
                        <dd className="stat-value">
                          {formatNumber(series.data.busyness.totals.activeMax)}
                        </dd>
                      </div>
                      <div className="stat">
                        <dt className="stat-label">Samples</dt>
                        <dd className="stat-value">
                          {formatNumber(series.data.busyness.totals.samples)}
                        </dd>
                        <dd className="stat-hint">Heartbeats in the range.</dd>
                      </div>
                    </dl>
                    <div className="analytics-charts">
                      <Sparkline
                        values={series.data.busyness.buckets.map(
                          (bucket) => bucket.activeMean,
                        )}
                        secondary={series.data.busyness.buckets.map(
                          (bucket) => bucket.concurrency,
                        )}
                        label={`${workerKey}: mean jobs in flight against its concurrency, ${describeAxis(series.data.busyness.range)}`}
                        width={240}
                      />
                    </div>
                  </div>
                )}
              </section>
            ) : (
              <p
                className="muted"
                data-testid="worker-busyness-absent"
              >
                This backend records no busyness for workers.
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
