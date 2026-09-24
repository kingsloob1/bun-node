import type { WorkerConfigOverrideDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { queuePath } from "../../api/queues";
import { listWorkers, workerKeys } from "../../api/workers";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { KeyValue } from "../../components/KeyValue";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { plural } from "../../format";
import { useCan, useUntargetedCanFn } from "../../meta/hooks";
import { Link } from "../../router";
import { useParams } from "../../routing";
import { useQueueWorkersLive, useWorkerRefetchInterval } from "./live";
import { WorkerAnalyticsCard } from "./WorkerAnalyticsCard";
import { WorkerConfigCard } from "./WorkerConfigCard";
import { WorkerJobsCard } from "./WorkerJobsCard";
import { WorkerTable } from "./WorkerTable";
import "./workers.css";

/**
 * Instances per page in the Instances card.
 *
 * Ten, not the 25 a worker *list* pages at: these are the live instances of
 * **one** key, which is one or a few on most deployments, so the card almost
 * never shows a pager — and a key replicated across a large fleet stays a card
 * rather than taking over the page above its configuration.
 */
const INSTANCE_PAGE_SIZE = 10;

/**
 * The override a listing's `offline` entry stores, or `null` when it stores
 * nothing. Resetting a key no instance of which is live **empties** its entry
 * rather than deleting it — the entry keeps its `seq`, so a later write still
 * conflicts correctly — and an entry with no values overrides nothing.
 */
function storedOverride(
  entry: WorkerConfigOverrideDto | undefined,
): WorkerConfigOverrideDto | null {
  return entry !== undefined &&
    Object.values(entry.values).some((value) => value !== undefined)
    ? entry
    : null;
}

/**
 * `/workers/:queue/:key`: one **stable worker key** — every live instance of
 * it with its controls, the configuration the key's override gives them, its
 * throughput and busyness, and the jobs whose last attempt it ran (where the
 * backend records that, `features.jobAttribution`).
 *
 * Addressed by the pair, because a key is unique only within its queue. The
 * route sits inside the queue's `PermissionScope`, since worker actions
 * authorize against the queue. One read, `GET /workers?queue=&key=` with
 * `includeOffline`, gives the instances and, when none is live, the override
 * stored for the key.
 */
export function WorkerScreen() {
  const { queue = "", key = "" } = useParams<{ queue: string; key: string }>();
  const api = useApiClient();
  const canList = useCan("workers.list");
  // The queue link leads to another section, whose route the untargeted map
  // decided; the queue's own answer says nothing about it.
  const canQueues = useUntargetedCanFn()("queues.list");
  const refetchInterval = useWorkerRefetchInterval();
  // A worker event is authorized as its queue's, like the queue panel's.
  useQueueWorkersLive(queue, useCan("queues.read") && canList);
  const workers = useQuery({
    queryKey: workerKeys.ofKey(queue, key),
    queryFn: ({ signal }) =>
      listWorkers(
        api,
        { queue: [queue], key: [key], includeOffline: true },
        signal,
      ),
    refetchInterval,
    enabled: canList,
  });

  if (!canList) {
    return (
      <div className="screen">
        <h1 className="screen-title">{key}</h1>
        <EmptyState
          title="Instances hidden"
          description="You may not list workers on this queue, so its instances and configuration are not shown."
        />
        {/*
          Neither needs `workers.list`: the analytics are `metrics.read` and
          the workers-metrics gate, the jobs `jobs.list`. Each section
          degrades on its own, so hiding the instances hides only them.
        */}
        <WorkerAnalyticsCard
          queue={queue}
          workerKey={key}
        />
        <WorkerJobsCard
          queue={queue}
          workerKey={key}
        />
      </div>
    );
  }

  const instances = workers.data?.items ?? [];
  // `offline` is present only when the API honoured `includeOffline`.
  const offline = workers.data?.offline;
  const stored =
    offline === undefined
      ? undefined
      : storedOverride(
          offline.find(
            (override) => override.queue === queue && override.key === key,
          ),
        );
  const service = instances.find(
    (worker) => worker.service !== undefined,
  )?.service;
  const showHost = instances.some(
    (worker) => worker.host !== undefined || worker.pid !== undefined,
  );

  return (
    <div
      className="screen"
      data-testid="worker-screen"
    >
      <div className="worker-header">
        <h1 className="screen-title">
          <span className="visually-hidden">Worker </span>
          {key}
        </h1>
        <KeyValue
          className="worker-header-facts"
          items={[
            {
              label: "Queue",
              value: canQueues ? (
                <Link to={queuePath(queue)}>{queue}</Link>
              ) : (
                queue
              ),
            },
            {
              label: "Service",
              value:
                instances.length === 0
                  ? null
                  : (service ?? <span className="muted">None named</span>),
              hint:
                instances.length === 0
                  ? "Known once an instance reports."
                  : undefined,
            },
          ]}
        />
      </div>
      {workers.isPending ? (
        <Spinner
          label="Loading this worker"
          showLabel
        />
      ) : workers.isError ? (
        <ErrorView
          error={workers.error}
          title="Could not load this worker"
          onRetry={() => void workers.refetch()}
        />
      ) : (
        <>
          <Card
            title="Instances"
            actions={
              <span className="muted">
                {plural(instances.length, "live instance")}
              </span>
            }
          >
            <div data-testid="worker-instances">
              {instances.length === 0 ? (
                <EmptyState
                  title="No live instance"
                  description="No worker carrying this key is reporting now. One appears here when a process starts it; a stopped worker that lapsed is not listed."
                />
              ) : (
                <WorkerTable
                  workers={instances}
                  label={`Instances of ${key}`}
                  showQueue={false}
                  showHost={showHost}
                  showMemory
                  pageSize={INSTANCE_PAGE_SIZE}
                />
              )}
            </div>
          </Card>
          <WorkerConfigCard
            queue={queue}
            workerKey={key}
            instances={instances}
            stored={stored}
          />
        </>
      )}
      <WorkerAnalyticsCard
        queue={queue}
        workerKey={key}
      />
      <WorkerJobsCard
        queue={queue}
        workerKey={key}
      />
    </div>
  );
}
