import type { QueueDemandDto } from "../../../api/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { demandKeys, demandUrls, getQueueDemand } from "../../../api/demand";
import { CopyButton } from "../../../components/CopyButton";
import { KeyValue } from "../../../components/KeyValue";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { RelativeTime } from "../../../components/RelativeTime";
import { Spinner } from "../../../components/Spinner";
import { useApiClient } from "../../../context";
import { formatNumber } from "../../../format";
import { useRefreshInterval } from "../live";
import {
  DEMAND_FIGURES,
  demandFigureHint,
  formatDemandFigure,
  qualify,
} from "./demand";

/** Props of {@link DemandPanel}. */
export interface DemandPanelProps {
  /** The queue. */
  queue: string;
}

/**
 * `GET /queues/:queue/demand`: the figures a scaler polls to decide how many
 * workers to run, as this API answers them now, and the URLs it would poll.
 *
 * Every figure is written as the answer qualifies it (see `./demand`): "≥"
 * when a count reached the cap, "≈" when the backend's fallback produced it.
 * A paused queue reads demand and outstanding as 0 over its unchanged
 * backlog, which a note says, so a 0 is not mistaken for an empty queue.
 */
export function DemandPanel({ queue }: DemandPanelProps) {
  const api = useApiClient();
  const refetchInterval = useRefreshInterval("demand");
  const demand = useQuery({
    queryKey: demandKeys.queue(queue),
    queryFn: ({ signal }) => getQueueDemand(api, queue, signal),
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  if (demand.isPending) {
    return (
      <Spinner
        label="Loading demand"
        showLabel
      />
    );
  }
  if (demand.isError) {
    return (
      <ProblemBanner
        error={demand.error}
        title="Could not load demand"
        onRetry={() => void demand.refetch()}
      />
    );
  }
  return (
    <DemandReading
      reading={demand.data}
      urls={demandUrls(api.base, queue, window.location.origin)}
    />
  );
}

/** Props of {@link DemandReading}. */
interface DemandReadingProps {
  /** The answer. */
  reading: QueueDemandDto;
  /** Where a scaler reads it. */
  urls: { json: string; prometheus: string };
}

/** One demand answer, its qualifications, and the scaler URLs. */
function DemandReading({ reading, urls }: DemandReadingProps) {
  const approximate = DEMAND_FIGURES.some(
    ({ figure }) => qualify(reading, figure).approximate,
  );
  return (
    <div
      className="demand-panel"
      data-testid="queue-demand"
    >
      {reading.paused && (
        <p
          className="notice"
          role="note"
          data-testid="demand-paused"
        >
          The queue is paused, so it demands nothing: demand and outstanding
          read 0 whatever is waiting, and a scaler polling them scales to zero.
        </p>
      )}
      {reading.capped && (
        <p
          className="notice"
          role="note"
          data-testid="demand-capped"
        >
          At least these many: a count reached the backend's cap, so every
          figure is a lower bound (≥).
        </p>
      )}
      {approximate && (
        <p
          className="notice"
          role="note"
          data-testid="demand-approximate"
        >
          Approximate (≈): this backend cannot count demand directly, so due now
          is only 1 or 0, stalled counts every active job while no worker is
          live, and the next due time is known only while nothing is due. Right
          as a trigger, not as a count.
        </p>
      )}
      <KeyValue
        items={[
          ...DEMAND_FIGURES.map(({ figure, label, hint }) => ({
            key: figure,
            label,
            value: (
              <span
                className="num"
                title={demandFigureHint(reading, figure)}
                data-testid={`demand-${figure}`}
              >
                {formatDemandFigure(reading, figure)}
              </span>
            ),
            hint,
          })),
          {
            key: "workers",
            label: "Workers",
            value: (
              <span
                className="num"
                data-testid="demand-workers"
              >
                {formatNumber(reading.workers)}
              </span>
            ),
            hint: "Live workers on the queue, from their heartbeats, paused ones included. 0 on a backend that keeps no worker records.",
          },
          {
            key: "nextDueAt",
            label: "Next due",
            value: (
              <span data-testid="demand-next-due">
                {reading.nextDueAt === null ? (
                  "None scheduled"
                ) : (
                  <RelativeTime
                    value={reading.nextDueAt}
                    hint={
                      reading.exact
                        ? undefined
                        : "Approximate: known only while nothing is due."
                    }
                  />
                )}
              </span>
            ),
            hint: "The earliest delayed job or retry still in the future.",
          },
          {
            key: "at",
            label: "Read",
            value: <RelativeTime value={reading.at} />,
          },
        ]}
      />
      <div className="demand-urls">
        <p className="muted">
          A scaler reads the same figures from these URLs (JSON, and the
          Prometheus text format), with the credentials this API asks for.
        </p>
        <DemandUrl
          label="JSON"
          url={urls.json}
          testId="demand-url-json"
        />
        <DemandUrl
          label="Prometheus"
          url={urls.prometheus}
          testId="demand-url-prometheus"
        />
      </div>
    </div>
  );
}

/** One scaler URL with a copy button. */
function DemandUrl({
  label,
  url,
  testId,
}: {
  /** What format it serves. */
  label: string;
  /** The absolute URL. */
  url: string;
  /** Its test id. */
  testId: string;
}) {
  return (
    <div className="demand-url">
      <span className="demand-url-label">{label}</span>
      <code data-testid={testId}>{url}</code>
      <CopyButton
        text={url}
        ariaLabel={`Copy the ${label} demand URL`}
      />
    </div>
  );
}
