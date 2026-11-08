import type { WorkerStopPersistence } from "../../../api/contract";
import type { WorkerDto } from "../../../api/types";
import { useState } from "react";
import { WORKER_STOP_PERSISTENCE } from "../../../api/contract";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Field } from "../../../components/Field";
import { Select } from "../../../components/inputs";

/** What each persistence choice does, as the dialog puts it. */
const PERSISTENCE_LABEL: Readonly<Record<WorkerStopPersistence, string>> = {
  process: "Until this process restarts",
  key: "Until somebody starts it again",
};

/** The sentence under each choice. */
const PERSISTENCE_HINT: Readonly<Record<WorkerStopPersistence, string>> = {
  process:
    "A redeploy or a restart brings this worker back running, because the stop is recorded against this incarnation only.",
  key: "Recorded against the worker's stable key, so every replica of it — including one started later — comes up stopped.",
};

/** Props of {@link StopWorkerDialog}. */
export interface StopWorkerDialogProps {
  /** Whether it is showing. */
  open: boolean;
  /** Asks to close. */
  onClose: () => void;
  /** The worker to stop, as the last read returned it. */
  worker: WorkerDto;
  /** Stops it; `persist` is sent only when the deployment lets it be chosen. */
  onConfirm: (persist?: WorkerStopPersistence) => unknown;
}

/**
 * Stop one worker: it finishes the jobs it holds and parks its loop, staying
 * in the registry so Start can bring it back.
 *
 * How long the stop survives is the deployment's setting
 * (`control.stopPersistence`). When it allows a per-stop choice
 * (`stopPersistenceOverridable`) this offers both, preselecting the
 * configured one; otherwise it states what will happen.
 */
export function StopWorkerDialog({
  open,
  onClose,
  worker,
  onConfirm,
}: StopWorkerDialogProps) {
  const configured = worker.control?.stopPersistence ?? "process";
  const choosable = worker.control?.stopPersistenceOverridable === true;
  const [persist, setPersist] = useState<WorkerStopPersistence>(configured);
  const active = worker.active;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Stop worker ${worker.id}?`}
      description={
        active > 0
          ? `It finishes the ${active === 1 ? "job it is running" : `${active} jobs it is running`} and takes no more. It stays listed, so you can start it again.`
          : "It parks its loop and takes no jobs. It stays listed, so you can start it again."
      }
      confirmLabel="Stop worker"
      pendingLabel="Stopping…"
      variant="danger"
      onConfirm={() => onConfirm(choosable ? persist : undefined)}
    >
      {choosable ? (
        <Field
          label="How long it stays stopped"
          hint={PERSISTENCE_HINT[persist]}
        >
          <Select
            value={persist}
            onChange={setPersist}
            options={WORKER_STOP_PERSISTENCE.map((value) => ({
              value,
              label: PERSISTENCE_LABEL[value],
            }))}
          />
        </Field>
      ) : (
        <p className="muted">{PERSISTENCE_HINT[configured]}</p>
      )}
    </ConfirmDialog>
  );
}
