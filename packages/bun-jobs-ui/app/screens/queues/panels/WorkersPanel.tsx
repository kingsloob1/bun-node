import { useQuery } from "@tanstack/react-query";
import { listQueueWorkers, queueKeys } from "../../../api/queues";
import { Badge } from "../../../components/Badge";
import { EmptyState } from "../../../components/EmptyState";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { RelativeTime } from "../../../components/RelativeTime";
import { Spinner } from "../../../components/Spinner";
import { Table } from "../../../components/Table";
import { useApiClient } from "../../../context";
import { formatNumber } from "../../../format";
import { refreshInterval } from "../live";

/** Props of {@link WorkersPanel}. */
export interface WorkersPanelProps {
  /** The queue whose live workers are listed. */
  queue: string;
}

/** `GET /queues/:queue/workers`: live workers, with host/pid when the API exposes them. */
export function WorkersPanel({ queue }: WorkersPanelProps) {
  const api = useApiClient();
  const workers = useQuery({
    queryKey: queueKeys.workers(queue),
    queryFn: ({ signal }) => listQueueWorkers(api, queue, signal),
    refetchInterval: refreshInterval("workers"),
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
  const hosts = items.some(
    (worker) => worker.host !== undefined || worker.pid !== undefined,
  );
  return (
    <Table label={`Workers of ${queue}`}>
      <thead>
        <tr>
          <th scope="col">Worker</th>
          {hosts && <th scope="col">Host</th>}
          {hosts && (
            <th
              scope="col"
              className="num"
            >
              Pid
            </th>
          )}
          <th
            scope="col"
            className="num"
          >
            Active / concurrency
          </th>
          <th scope="col">Started</th>
          <th scope="col">Heartbeat</th>
        </tr>
      </thead>
      <tbody>
        {items.map((worker) => (
          <tr
            key={worker.id}
            data-testid={`worker-row-${worker.id}`}
          >
            <th scope="row">
              <code>{worker.id}</code>
              {worker.paused && <Badge tone="warning">Paused</Badge>}
            </th>
            {hosts && <td>{worker.host ?? "—"}</td>}
            {hosts && <td className="num">{worker.pid ?? "—"}</td>}
            <td className="num">
              {formatNumber(worker.active)} / {formatNumber(worker.concurrency)}
            </td>
            <td>
              <RelativeTime value={worker.startedAt} />
            </td>
            <td>
              <RelativeTime value={worker.heartbeatAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
