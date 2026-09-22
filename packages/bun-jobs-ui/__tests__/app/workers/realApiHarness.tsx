import { useQuery } from "@tanstack/react-query";
import { listWorkers, workerKeys } from "../../../app/api/workers";
import { useApiClient } from "../../../app/context";
import { WorkerTable } from "../../../app/screens/workers/WorkerTable";

/** Props of {@link WorkersHarness}. */
export interface WorkersHarnessProps {
  /** The queue whose workers are listed; workers of every other queue are dropped, so one driver never sees another test's worker. */
  queue: string;
  /** How often `GET /workers` is re-read, in ms, so the row keeps up with what the live worker reports (the Workers screen polls the same read). */
  pollMs: number;
}

/**
 * Lists one queue's workers from `GET /workers` and renders the real
 * {@link WorkerTable}, which mounts a row's `WorkerActions`. The read sits
 * under `workerKeys.all`, so every worker write's invalidation refreshes it,
 * exactly as it does on the Workers screen.
 */
export function WorkersHarness({ queue, pollMs }: WorkersHarnessProps) {
  const api = useApiClient();
  const query = useQuery({
    queryKey: workerKeys.list(),
    queryFn: ({ signal }) => listWorkers(api, {}, signal),
    refetchInterval: pollMs,
  });
  if (!query.data) {
    return null;
  }
  return (
    <div data-testid="worker-actions-host">
      <WorkerTable
        workers={query.data.items.filter((worker) => worker.queue === queue)}
        label={`Workers of ${queue}`}
        showQueue={false}
      />
    </div>
  );
}
