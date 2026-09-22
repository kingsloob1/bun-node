/**
 * One worker's actions: pause, resume, stop, start and Settings…, with their
 * dialogs. The Workers screen and the queue screen's Workers panel both mount
 * {@link WorkerActions} in a row's last cell, so a worker is controlled the
 * same way wherever it is listed.
 *
 * Lifecycle actions target one running worker (its per-incarnation `id`);
 * Settings… targets the stable `key`, so it reaches every replica carrying it
 * (see {@link WorkerConfigDialog}).
 */
import type { WorkerStopPersistence } from "../../../api/contract";
import type { WorkerControlResultDto, WorkerDto } from "../../../api/types";
import { useState } from "react";
import { isApiError } from "../../../api/errors";
import {
  controlWorker,
  workerInvalidations,
  workerState,
} from "../../../api/workers";
import { Button } from "../../../components/Button";
import { useToast } from "../../../components/toast";
import { useApiClient } from "../../../context";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { explainWorkerError } from "./explain";
import {
  explainsBlock,
  useCanControlWorkers,
  WORKER_BLOCKED_HINT,
  workerActionGates,
} from "./gating";
import { StopWorkerDialog } from "./StopWorkerDialog";
import { WorkerConfigDialog } from "./WorkerConfigDialog";
import "./workerActions.css";

/** Props of {@link WorkerActions}. */
export interface WorkerActionsProps {
  /** The worker as the last worker read returned it. */
  worker: WorkerDto;
}

/** Which dialog is open. */
type OpenDialog = "stop" | "settings" | null;

/** What a successful instruction says, by whether the worker acknowledged it. */
function outcome(applied: boolean, done: string, queued: string): string {
  return applied ? done : queued;
}

/**
 * What a successful Stop says. `applied` means the worker **accepted** the
 * instruction, not that it has finished stopping: a worker holding jobs reads
 * `stopping` (with `control.pending`) until they finish. So the re-read
 * worker the answer carries decides when present — stopped, or accepted with
 * no job to drain — and `applied` only without it. Pause needs no such care: a paused worker stops claiming at once and
 * reads `paused` in the same answer, while the jobs it holds run on.
 */
function stopOutcome(id: string, result: WorkerControlResultDto): string {
  const replicas =
    result.persisted === "key"
      ? "; every replica of it stays stopped until started"
      : "";
  const worker = result.worker;
  // "It finishes its jobs first" is true only of a worker holding jobs. On a
  // driver that polls for instructions the re-read the answer carries can be
  // taken before an IDLE worker has finished parking — it reads `stopping`,
  // pending — though it has nothing to drain and is stopped a moment later.
  // So a worker holding no job counts as stopped once the stop was accepted.
  const stopped =
    worker === undefined
      ? result.applied
      : (workerState(worker) === "stopped" &&
          worker.control?.pending !== true) ||
        (result.applied && worker.active === 0);
  return stopped
    ? `Stopped ${id}${replicas}`
    : `Asked ${id} to stop; it finishes its jobs first${replicas}`;
}

/** The action buttons (and dialogs) for one worker, each present only when its permission is held and the worker is in a state that takes it. */
export function WorkerActions({ worker }: WorkerActionsProps) {
  const api = useApiClient();
  const toast = useToast();
  const canMutate = useCanControlWorkers();
  const [open, setOpen] = useState<OpenDialog>(null);
  const close = () => setOpen(null);
  const gates = workerActionGates(worker, canMutate);

  /** Pause, resume and start: one button each, no dialog (all are reversible). */
  const control = useApiMutation({
    mutationFn: (action: "pause" | "resume" | "start") =>
      controlWorker(api, worker.queue, worker.id, action).then((result) => ({
        action,
        result,
      })),
    invalidate: workerInvalidations(worker.queue),
    successMessage: ({ action, result }) =>
      action === "pause"
        ? outcome(
            result.applied,
            `Paused ${worker.id}`,
            `Asked ${worker.id} to pause; it stops taking jobs shortly`,
          )
        : action === "resume"
          ? outcome(
              result.applied,
              `Resumed ${worker.id}`,
              `Asked ${worker.id} to resume; it takes jobs again shortly`,
            )
          : outcome(
              result.applied,
              `Started ${worker.id}`,
              `Asked ${worker.id} to start; it takes jobs again shortly`,
            ),
    toastErrors: false,
    onError: (error, action) => {
      toast.error(`Could not ${action} ${worker.id}`, {
        description: isApiError(error)
          ? (explainWorkerError(error, action) ?? error.detail ?? error.title)
          : error.message,
      });
    },
  });

  const stop = useApiMutation({
    mutationFn: (persist: WorkerStopPersistence | undefined) =>
      controlWorker(api, worker.queue, worker.id, "stop", { persist }),
    invalidate: workerInvalidations(worker.queue),
    successMessage: (result) => stopOutcome(worker.id, result),
    toastErrors: false,
  });

  const anyLifecycle = gates.pause || gates.resume || gates.stop || gates.start;
  // Say why the lifecycle actions are missing only when it is the worker's
  // doing, not the caller's lack of permission (the ordinary case) — and say
  // it even while Settings… is offered, which it stays mid-transition.
  const hint =
    gates.blocked !== null && explainsBlock(gates, canMutate) ? (
      <span
        className="worker-actions-hint muted"
        data-testid={`worker-blocked-${worker.id}`}
      >
        {WORKER_BLOCKED_HINT[gates.blocked]}
      </span>
    ) : null;
  if (!anyLifecycle && !gates.configure) {
    return hint;
  }

  return (
    <div
      className="worker-actions"
      role="group"
      aria-label={`Actions for worker ${worker.id}`}
    >
      {gates.pause && (
        <Button
          size="sm"
          onClick={() => control.mutate("pause")}
          disabled={control.isPending}
          aria-busy={control.isPending || undefined}
        >
          Pause
        </Button>
      )}
      {gates.resume && (
        <Button
          size="sm"
          onClick={() => control.mutate("resume")}
          disabled={control.isPending}
          aria-busy={control.isPending || undefined}
        >
          Resume
        </Button>
      )}
      {gates.start && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => control.mutate("start")}
          disabled={control.isPending}
          aria-busy={control.isPending || undefined}
        >
          Start
        </Button>
      )}
      {gates.stop && (
        <Button
          size="sm"
          variant="danger"
          onClick={() => setOpen("stop")}
        >
          Stop…
        </Button>
      )}
      {gates.configure && (
        <Button
          size="sm"
          onClick={() => setOpen("settings")}
        >
          Settings…
        </Button>
      )}
      {hint}
      <StopWorkerDialog
        open={open === "stop"}
        onClose={close}
        worker={worker}
        onConfirm={(persist) => stop.mutateAsync(persist)}
      />
      {open === "settings" && (
        <WorkerConfigDialog
          worker={worker}
          onClose={close}
        />
      )}
    </div>
  );
}
