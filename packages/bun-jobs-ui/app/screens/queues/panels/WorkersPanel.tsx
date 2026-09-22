import { useQuery } from "@tanstack/react-query";
import { listQueueWorkers, queueKeys } from "../../../api/queues";
import { EmptyState } from "../../../components/EmptyState";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { Spinner } from "../../../components/Spinner";
import { useApiClient } from "../../../context";
import { useCan } from "../../../meta/hooks";
import { useQueueWorkersLive } from "../../workers/live";
import { useWorkerPagesRouted } from "../../workers/routed";
import { WorkerTable } from "../../workers/WorkerTable";
import { useRefreshInterval } from "../live";

/** Props of {@link WorkersPanel}. */
export interface WorkersPanelProps {
  /** The queue whose live workers are listed. */
  queue: string;
}

/** `GET /queues/:queue/workers`: live workers, with host/pid when the API exposes them. */
export function WorkersPanel({ queue }: WorkersPanelProps) {
  const api = useApiClient();
  const refetchInterval = useRefreshInterval("workers");
  // The server authorizes a worker event as its queue's, so the subscription
  // follows the same permission the queue screen's own subscription does.
  useQueueWorkersLive(queue, useCan("queues.read"));
  const linkKeys = useWorkerPagesRouted();
  const workers = useQuery({
    queryKey: queueKeys.workers(queue),
    queryFn: ({ signal }) => listQueueWorkers(api, queue, signal),
    refetchInterval,
  });
  if (workers.isPending) {
    return (
      <Spinner
        label="Loading workers"
        showLabel
      />
    );
  }
  if (workers.isError) {
    return (
      <ProblemBanner
        error={workers.error}
        title="Could not load workers"
        onRetry={() => void workers.refetch()}
      />
    );
  }
  const items = workers.data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No live workers"
        description="No worker has reported for this queue recently."
      />
    );
  }
  // A queue's panel names the queue already; hosts show when the API exposes them.
  const showHost = items.some(
    (worker) => worker.host !== undefined || worker.pid !== undefined,
  );
  return (
    <WorkerTable
      workers={items}
      label={`Workers of ${queue}`}
      showQueue={false}
      showHost={showHost}
      linkKeys={linkKeys}
    />
  );
}
