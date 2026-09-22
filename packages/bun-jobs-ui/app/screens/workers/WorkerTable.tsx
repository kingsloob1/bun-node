import type { WorkerState } from "../../api/contract";
import type { WorkerDto } from "../../api/types";
import type { BadgeTone } from "../../components/Badge";
import { queuePath } from "../../api/queues";
import { isStale, workerPath, workerState } from "../../api/workers";
import { Badge } from "../../components/Badge";
import { RelativeTime } from "../../components/RelativeTime";
import { Table } from "../../components/Table";
import { formatNumber } from "../../format";
import { Link } from "../../router";
import { WorkerActions } from "./actions";
import {
  explainsBlock,
  useCanControlWorkers,
  workerActionGates,
} from "./actions/gating";

/**
 * The one worker table, shared by the Workers screen (grouped by server) and
 * the queue screen's Workers panel, so a worker looks and behaves the same
 * wherever it is listed — controls included.
 */

/** How each state shows, and what it means. */
const STATE_BADGE: Readonly<
  Record<WorkerState, { label: string; tone: BadgeTone; hint: string }>
> = {
  running: {
    label: "Running",
    tone: "success",
    hint: "Taking jobs from its queue.",
  },
  paused: {
    label: "Paused",
    tone: "warning",
    hint: "Its loop runs, but it takes no new jobs until it is resumed.",
  },
  stopping: {
    label: "Stopping",
    tone: "neutral",
    hint: "Finishing the jobs it holds; it takes no more.",
  },
  stopped: {
    label: "Stopped",
    tone: "neutral",
    hint: "Parked, and still listed, so it can be started again.",
  },
  restarting: {
    label: "Restarting",
    tone: "accent",
    hint: "Taking up changed settings; this lasts milliseconds.",
  },
};

/** Props of {@link WorkerTable}. */
export interface WorkerTableProps {
  /** The workers to list, already ordered. */
  workers: readonly WorkerDto[];
  /** The table's accessible name, e.g. `Workers of emails`. */
  label: string;
  /** Whether to show the queue column (the Workers screen spans queues; a queue's panel does not). Defaults to `true`. */
  showQueue?: boolean;
  /** Whether a queue name links to its screen (`queues.list`). Defaults to `false`. */
  linkQueues?: boolean;
  /** Whether to show the host and pid columns (a server's group already names them). Defaults to `false`. */
  showHost?: boolean;
  /**
   * Whether a worker's stable key links to its worker page
   * (`/workers/:queue/:key`) — pass `useWorkerPagesRouted()`. Every instance
   * of a key links to the same page; a worker reporting no `key` gets no
   * link. Defaults to `false` (the worker page itself lists one key).
   */
  linkKeys?: boolean;
}

/** A worker's state, plus a note when its record has lapsed. */
function StateCell({ worker }: { worker: WorkerDto }) {
  const badge = STATE_BADGE[workerState(worker)];
  return (
    <>
      <Badge
        tone={badge.tone}
        title={badge.hint}
      >
        {badge.label}
      </Badge>{" "}
      {worker.control?.pending === true && (
        <Badge
          tone="accent"
          title="A change was recorded and this worker has not taken it up yet. It applies within seconds."
        >
          Change pending
        </Badge>
      )}{" "}
      {isStale(worker) && (
        <Badge
          tone="danger"
          title="This worker stopped reporting. Its record lapses unless it reports again."
        >
          Not reporting
        </Badge>
      )}
    </>
  );
}

/**
 * One of a worker's cumulative counters, or a muted dash when it reports none.
 *
 * **Absent is not zero.** A worker older than the counters reports neither
 * field; showing `0` would claim it did nothing. The figure is per
 * incarnation — a restart starts it again — which the column header says.
 */
function CounterCell({
  value,
}: {
  /** `WorkerDto.completed` or `.failed`: absent on a worker that does not report it. */
  value: number | undefined;
}) {
  return (
    <td className="num">
      {value === undefined ? (
        <span
          className="muted"
          title="This worker does not report its counts (it predates them)."
        >
          —
        </span>
      ) : (
        formatNumber(value)
      )}
    </td>
  );
}

/**
 * Live workers: id, queue, state, load, what this incarnation completed and
 * failed, the times it reported, and its actions.
 */
export function WorkerTable({
  workers,
  label,
  showQueue = true,
  linkQueues = false,
  showHost = false,
  linkKeys = false,
}: WorkerTableProps) {
  const canMutate = useCanControlWorkers();
  // The counters ride the heartbeat, so they cost no read; the columns exist
  // only when some worker here reports them, and an older worker that does
  // not shows a dash rather than a zero it never claimed.
  const showCounts = workers.some(
    (worker) => worker.completed !== undefined || worker.failed !== undefined,
  );
  // The actions column exists only when some worker here offers something,
  // or says why it offers nothing: a caller with no worker mutations sees the
  // table it saw before.
  const showActions = workers.some((worker) => {
    const gates = workerActionGates(worker, canMutate);
    return (
      gates.pause ||
      gates.resume ||
      gates.stop ||
      gates.start ||
      gates.configure ||
      explainsBlock(gates, canMutate)
    );
  });
  return (
    <Table label={label}>
      <thead>
        <tr>
          <th scope="col">Worker</th>
          {showQueue && <th scope="col">Queue</th>}
          {showHost && <th scope="col">Host</th>}
          {showHost && (
            <th
              scope="col"
              className="num"
            >
              Pid
            </th>
          )}
          <th scope="col">State</th>
          <th
            scope="col"
            className="num"
          >
            Active / concurrency
          </th>
          {showCounts && (
            <th
              scope="col"
              className="num"
              title="Jobs this incarnation completed since it started; a restart starts it again."
            >
              Completed
            </th>
          )}
          {showCounts && (
            <th
              scope="col"
              className="num"
              title="Attempts this incarnation failed since it started; a restart starts it again."
            >
              Failed
            </th>
          )}
          <th scope="col">Started</th>
          <th scope="col">Heartbeat</th>
          {showActions && <th scope="col">Actions</th>}
        </tr>
      </thead>
      <tbody>
        {workers.map((worker) => (
          <tr
            key={`${worker.queue}/${worker.id}`}
            data-testid={`worker-row-${worker.id}`}
          >
            <th scope="row">
              <code>{worker.id}</code>
              {linkKeys && worker.key !== undefined && (
                <div className="worker-key">
                  <Link
                    to={workerPath(worker.queue, worker.key)}
                    title={`Every instance of ${worker.key}, its settings and its numbers`}
                    data-testid={`worker-key-link-${worker.id}`}
                  >
                    {worker.key}
                  </Link>
                </div>
              )}
            </th>
            {showQueue && (
              <td>
                {linkQueues ? (
                  <Link to={queuePath(worker.queue)}>{worker.queue}</Link>
                ) : (
                  worker.queue
                )}
              </td>
            )}
            {showHost && <td>{worker.host ?? "—"}</td>}
            {showHost && <td className="num">{worker.pid ?? "—"}</td>}
            <td>
              <StateCell worker={worker} />
            </td>
            <td className="num">
              {formatNumber(worker.active)} / {formatNumber(worker.concurrency)}
            </td>
            {showCounts && <CounterCell value={worker.completed} />}
            {showCounts && <CounterCell value={worker.failed} />}
            <td>
              <RelativeTime value={worker.startedAt} />
            </td>
            <td>
              <RelativeTime value={worker.heartbeatAt} />
            </td>
            {showActions && (
              <td>
                <WorkerActions worker={worker} />
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
