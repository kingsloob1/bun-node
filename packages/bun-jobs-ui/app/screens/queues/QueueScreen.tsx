import type { ReactNode } from "react";
import type { QueueLimitsDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { JOB_STATES } from "../../api/contract";
import { getQueue, getQueueCounts, queueKeys } from "../../api/queues";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { RelativeTime } from "../../components/RelativeTime";
import { Spinner } from "../../components/Spinner";
import { UrlTabs } from "../../components/Tabs";
import { useApiClient } from "../../context";
import { formatNumber } from "../../format";
import { useUrlTab } from "../../hooks/useUrlTab";
import { useCan, useMeta, usePermissionsSettled } from "../../meta/hooks";
import { Link } from "../../router";
import { useParams } from "../../routing";
import { AddJobDialog } from "../job";
import { canAddJobs, useCanMutate } from "./gating";
import { JobsTable } from "./JobsTable";
import { useQueueLive, useRefreshInterval } from "./live";
import { LimitsPanel } from "./panels/LimitsPanel";
import { RepeatablesPanel } from "./panels/RepeatablesPanel";
import { ThroughputPanel } from "./panels/ThroughputPanel";
import { WorkersPanel } from "./panels/WorkersPanel";
import { QueueActions } from "./QueueActions";
import "./queues.css";

/** A panel below the jobs table. */
export type PanelId = "limits" | "workers" | "throughput" | "repeatables";

/** `/queues/:queue`: header and actions, the jobs table, and the panels. */
export function QueueScreen() {
  const { queue = "" } = useParams<{ queue: string }>();
  const api = useApiClient();
  const meta = useMeta();
  const canRead = useCan("queues.read");
  const canListJobs = useCan("jobs.list");
  const canAdd = useCan("jobs.add");
  const canRepeatables = useCan("repeatables.list");
  const settled = usePermissionsSettled();
  const detailInterval = useRefreshInterval("detail");
  const countsInterval = useRefreshInterval("counts");
  // Subscribes once the queue's own permissions have answered, and only
  // while its detail is readable.
  useQueueLive(queue, {
    enabled: canRead && settled,
    jobs: canListJobs,
    repeatables: canRepeatables,
  });
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const detail = useQuery({
    queryKey: queueKeys.detail(queue),
    queryFn: ({ signal }) => getQueue(api, queue, signal),
    refetchInterval: detailInterval,
    enabled: canRead,
  });
  const counts = useQuery({
    queryKey: queueKeys.counts(queue),
    queryFn: ({ signal }) => getQueueCounts(api, queue, signal),
    refetchInterval: countsInterval,
    enabled: canRead,
  });

  if (canRead && detail.isError && !detail.data) {
    return (
      <div className="screen">
        <ErrorView
          error={detail.error}
          title={`Could not load the queue ${queue}`}
          onRetry={() => void detail.refetch()}
        />
      </div>
    );
  }

  const total = counts.data
    ? JOB_STATES.reduce((sum, state) => sum + counts.data[state], 0)
    : detail.data?.total;

  return (
    <div
      className="screen queue-screen"
      data-testid="queue-screen"
    >
      <nav
        aria-label="Breadcrumb"
        className="breadcrumb"
      >
        <Link to="/queues">Queues</Link>
        <span aria-hidden="true"> / </span>
      </nav>
      <header className="queue-header">
        <div className="queue-heading">
          <h1 className="screen-title">{queue}</h1>
          {detail.data?.paused && <Badge tone="warning">Paused</Badge>}
          {total !== undefined && (
            <span
              className="queue-total"
              data-testid="queue-total"
            >
              {formatNumber(total)} jobs
            </span>
          )}
          {counts.dataUpdatedAt > 0 && (
            <span className="muted queue-updated">
              Updated <RelativeTime value={counts.dataUpdatedAt} />
            </span>
          )}
        </div>
        <div className="queue-toolbar">
          {canAddJobs(meta, canAdd) && (
            <Button
              ref={addButtonRef}
              variant="primary"
              onClick={() => setAdding(true)}
            >
              Add job
            </Button>
          )}
          <QueueActions
            queue={queue}
            paused={detail.data?.paused}
          />
        </div>
      </header>
      {canAddJobs(meta, canAdd) && (
        <AddJobDialog
          queue={queue}
          open={adding}
          onClose={() => {
            setAdding(false);
            addButtonRef.current?.focus();
          }}
        />
      )}
      {canListJobs ? (
        <Card title="Jobs">
          <JobsTable
            queue={queue}
            counts={counts.data}
          />
        </Card>
      ) : (
        <EmptyState
          title="Jobs hidden"
          description="You may not list this queue's jobs."
        />
      )}
      <QueuePanels
        queue={queue}
        limits={detail.data ? detail.data.limits : undefined}
        detailLoading={canRead && detail.isPending}
      />
    </div>
  );
}

/** Props of {@link QueuePanels}. */
interface QueuePanelsProps {
  /** The queue. */
  queue: string;
  /** `QueueDetailDto.limits`: `undefined` when the backend cannot store limits (the key is absent) or the detail is not loaded. */
  limits: QueueLimitsDto | null | undefined;
  /** Whether the detail is still loading (the limits panel waits for it). */
  detailLoading: boolean;
}

/** The panels the backend and the caller allow; a pruned one is absent, not disabled. */
function QueuePanels({ queue, limits, detailLoading }: QueuePanelsProps) {
  const meta = useMeta();
  const canMutate = useCanMutate();
  const canWorkers = useCan("workers.list");
  const canMetrics = useCan("metrics.read");
  const canRepeatables = useCan("repeatables.list");

  const panels: { value: PanelId; label: string; render: () => ReactNode }[] =
    [];
  if (meta.features.limits && (limits !== undefined || detailLoading)) {
    panels.push({
      value: "limits",
      label: "Limits",
      render: () =>
        limits === undefined ? (
          <Spinner
            label="Loading limits"
            showLabel
          />
        ) : (
          <LimitsPanel
            queue={queue}
            limits={limits}
            editable={canMutate("queues.limits")}
          />
        ),
    });
  }
  if (meta.features.workers && canWorkers) {
    panels.push({
      value: "workers",
      label: "Workers",
      render: () => <WorkersPanel queue={queue} />,
    });
  }
  if (meta.features.throughput && canMetrics) {
    panels.push({
      value: "throughput",
      label: "Throughput",
      render: () => <ThroughputPanel queue={queue} />,
    });
  }
  if (canRepeatables) {
    panels.push({
      value: "repeatables",
      label: "Repeatables",
      render: () => (
        <RepeatablesPanel
          queue={queue}
          canRemove={canMutate("repeatables.remove")}
          canDisable={canMutate("repeatables.disable")}
          canEnable={canMutate("repeatables.enable")}
        />
      ),
    });
  }
  const first = panels[0]?.value ?? "limits";
  const selected = useUrlTab<PanelId>("panel", panels, first);
  if (panels.length === 0) {
    return null;
  }
  const current =
    panels.find((panel) => panel.value === selected) ?? panels[0]!;
  return (
    <Card
      title="Details"
      className="queue-panels"
    >
      <UrlTabs
        tabs={panels.map(({ value, label }) => ({ value, label }))}
        param="panel"
        defaultValue={first}
        label="Queue details"
      >
        {current.render()}
      </UrlTabs>
    </Card>
  );
}
