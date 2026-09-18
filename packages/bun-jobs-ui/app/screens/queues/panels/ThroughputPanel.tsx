import type { QueueThroughputDto } from "../../../api/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { getThroughput, queueKeys } from "../../../api/queues";
import { Select } from "../../../components/inputs";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { Spinner } from "../../../components/Spinner";
import { useApiClient } from "../../../context";
import { formatNumber } from "../../../format";
import { useRefreshInterval } from "../live";
import { useUrlParams } from "../urlState";
import {
  DEFAULT_WINDOW,
  formatMinute,
  parseWindowParam,
  PLOT_HEIGHT,
  SEGMENT_GAP,
  THROUGHPUT_WINDOWS,
  WINDOW_LABELS,
} from "./throughput";

/** Props of {@link ThroughputPanel}. */
export interface ThroughputPanelProps {
  /** The queue charted. */
  queue: string;
}

/** `GET /queues/:queue/throughput`: completed and failed per minute, with a window picker (in the URL as `window`). */
export function ThroughputPanel({ queue }: ThroughputPanelProps) {
  const api = useApiClient();
  const [params, update] = useUrlParams();
  const minutes = parseWindowParam(params.get("window"));
  const selectId = useId();
  const refetchInterval = useRefreshInterval("throughput");
  const throughput = useQuery({
    queryKey: queueKeys.throughput(queue, minutes),
    queryFn: ({ signal }) => getThroughput(api, queue, minutes, signal),
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  return (
    <div className="throughput-panel">
      <div className="throughput-controls">
        <label htmlFor={selectId}>Window</label>
        <Select
          id={selectId}
          options={THROUGHPUT_WINDOWS.map((window) => ({
            value: String(window),
            label: WINDOW_LABELS[window],
          }))}
          value={String(minutes)}
          onChange={(value) =>
            update({ window: value === String(DEFAULT_WINDOW) ? null : value })
          }
        />
      </div>
      {throughput.isPending ? (
        <Spinner
          label="Loading throughput"
          showLabel
        />
      ) : throughput.isError ? (
        <ProblemBanner
          error={throughput.error}
          title="Could not load throughput"
          onRetry={() => void throughput.refetch()}
        />
      ) : (
        <ThroughputChart
          data={throughput.data}
          label={`${queue}: jobs per minute, ${WINDOW_LABELS[minutes].toLowerCase()}`}
        />
      )}
    </div>
  );
}

/** Props of {@link ThroughputChart}. */
export interface ThroughputChartProps {
  /** The buckets, oldest first. */
  data: QueueThroughputDto;
  /** Accessible name of the chart. */
  label: string;
}

/**
 * Stacked bars, completed below failed, one per minute. The SVG is a picture
 * (`role="img"` with a summary); the numbers are in a visually hidden table
 * beside it, and each bar carries a `<title>` for hover.
 */
export function ThroughputChart({ data, label }: ThroughputChartProps) {
  const { buckets } = data;
  const peak = Math.max(1, ...buckets.map((b) => b.completed + b.failed));
  const width = Math.max(1, buckets.length) * 10;
  const scale = (value: number) => (value / peak) * PLOT_HEIGHT;
  const summary = `${label}: ${formatNumber(data.completed)} completed, ${formatNumber(data.failed)} failed, peak ${formatNumber(peak)} per minute.`;
  return (
    <figure className="throughput-chart">
      <div
        className="throughput-legend"
        aria-hidden="true"
      >
        <span>
          <span className="swatch swatch-completed" /> Completed{" "}
          {formatNumber(data.completed)}
        </span>
        <span>
          <span className="swatch swatch-failed" /> Failed{" "}
          {formatNumber(data.failed)}
        </span>
        <span className="muted">Peak {formatNumber(peak)}/min</span>
      </div>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${width} ${PLOT_HEIGHT}`}
        preserveAspectRatio="none"
        className="throughput-svg"
      >
        <line
          x1={0}
          x2={width}
          y1={PLOT_HEIGHT}
          y2={PLOT_HEIGHT}
          className="throughput-baseline"
        />
        {buckets.map((bucket, index) => {
          const x = index * 10 + 1;
          const completed = scale(bucket.completed);
          const failed = scale(bucket.failed);
          const gap = completed > 0 && failed > 0 ? SEGMENT_GAP : 0;
          return (
            <g key={bucket.at}>
              <title>{`${formatMinute(bucket.at)}: ${bucket.completed} completed, ${bucket.failed} failed`}</title>
              <rect
                x={x - 1}
                y={0}
                width={10}
                height={PLOT_HEIGHT}
                className="throughput-hit"
              />
              {completed > 0 && (
                <rect
                  x={x}
                  y={PLOT_HEIGHT - completed}
                  width={8}
                  height={completed}
                  rx={1}
                  className="bar-completed"
                />
              )}
              {failed > 0 && (
                <rect
                  x={x}
                  y={PLOT_HEIGHT - completed - gap - failed}
                  width={8}
                  height={failed}
                  rx={1}
                  className="bar-failed"
                />
              )}
            </g>
          );
        })}
      </svg>
      {buckets.length > 0 && (
        <figcaption
          className="throughput-axis"
          aria-hidden="true"
        >
          <span>{formatMinute(buckets[0]!.at)}</span>
          <span>{formatMinute(buckets.at(-1)!.at)}</span>
        </figcaption>
      )}
      <table className="visually-hidden">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Minute</th>
            <th scope="col">Completed</th>
            <th scope="col">Failed</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.at}>
              <th scope="row">{formatMinute(bucket.at)}</th>
              <td>{bucket.completed}</td>
              <td>{bucket.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
