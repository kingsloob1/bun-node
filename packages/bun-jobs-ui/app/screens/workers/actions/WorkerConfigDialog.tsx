import type { WorkerConfigBody, WorkerConfigKey } from "../../../api/contract";
import type { WorkerDto } from "../../../api/types";
import { useState } from "react";
import {
  WORKER_CONFIG_BOUNDS,
  WORKER_CONFIG_KEYS,
} from "../../../api/contract";
import {
  configureWorkers,
  resetWorkerConfig,
  workerInvalidations,
} from "../../../api/workers";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { NumberInput } from "../../../components/inputs";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { useApiClient } from "../../../context";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { explained } from "./explain";
import { SETTING_HINT } from "./settingHints";

/** The form's value for each setting: a number, or `undefined` while the box is empty. */
type Draft = Partial<Record<WorkerConfigKey, number | undefined>>;

/** Props of {@link WorkerConfigDialog}. */
export interface WorkerConfigDialogProps {
  /** The worker whose settings are edited; its `key` is what the override is stored against. */
  worker: WorkerDto;
  /** Asks to close. */
  onClose: () => void;
}

/**
 * Edit the settings of every worker sharing one stable key.
 *
 * An override is stored against the worker's `key`, not its `id`, so it
 * reaches every live replica carrying that key and every replica started
 * later, until it is reset. The dialog says so, and each input shows what the
 * process's own code asked for, so an override is recognisable as one.
 *
 * Changes are applied in place: a worker does not drain or restart, and the
 * jobs it holds keep their locks.
 */
export function WorkerConfigDialog({
  worker,
  onClose,
}: WorkerConfigDialogProps) {
  const api = useApiClient();
  const config = worker.config;
  const key = worker.key ?? worker.id;
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<unknown>(null);

  /** The value shown for a setting: what has been typed, else what the worker runs with. */
  const valueOf = (setting: WorkerConfigKey): number | undefined =>
    setting in draft ? draft[setting] : config?.effective[setting];

  /** Only the settings whose value differs from what the worker runs with, as a merge patch. */
  const patch = (): WorkerConfigBody => {
    const body: WorkerConfigBody = {};
    for (const setting of WORKER_CONFIG_KEYS) {
      if (!(setting in draft)) {
        continue;
      }
      const next = draft[setting];
      if (next === undefined) {
        // An emptied box clears that setting's override.
        if (config?.overridden.includes(setting)) {
          body[setting] = null;
        }
        continue;
      }
      if (next !== config?.effective[setting]) {
        body[setting] = next;
      }
    }
    if (config) {
      body.expectedSeq = config.seq;
    }
    return body;
  };

  const save = useApiMutation({
    mutationFn: () => configureWorkers(api, worker.queue, key, patch()),
    invalidate: workerInvalidations(worker.queue),
    successMessage: (result) =>
      result.instances.length > 1
        ? `Saved the settings of ${key}; ${result.instances.length} workers carry it`
        : `Saved the settings of ${key}`,
    toastErrors: false,
    onSuccess: onClose,
    onError: (cause) => setError(explained(cause, "configure")),
  });

  const reset = useApiMutation({
    mutationFn: () => resetWorkerConfig(api, worker.queue, key),
    invalidate: workerInvalidations(worker.queue),
    successMessage: `Reset ${key} to the values in its code`,
    toastErrors: false,
    onSuccess: onClose,
    onError: (cause) => setError(explained(cause, "configure")),
  });

  const pending = save.isPending || reset.isPending;
  const changes = Object.keys(patch()).filter(
    (field) => field !== "expectedSeq",
  );

  return (
    <Dialog
      open
      onClose={onClose}
      closeOnEscape={!pending}
      size="lg"
      title={`Settings of ${key}`}
      description={
        <>
          Stored against the worker&rsquo;s key, so this reaches every worker
          carrying <code>{key}</code> — including ones started later — until you
          reset it. Changes apply in place: nothing drains or restarts.
        </>
      }
      footer={
        <>
          <Button
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          {config && config.overridden.length > 0 && (
            <Button
              variant="danger"
              onClick={() => reset.mutate()}
              disabled={pending}
              aria-busy={reset.isPending || undefined}
            >
              {reset.isPending ? "Resetting…" : "Reset to code values"}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={pending || changes.length === 0}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
        </>
      }
    >
      {error !== null && <ProblemBanner error={error} />}
      {worker.control?.pending === true && (
        <p
          className="worker-config-note"
          data-testid="worker-config-pending"
        >
          A change is waiting to be taken up, so the values below are the ones
          this worker still runs with. Saving now replaces the waiting change.
        </p>
      )}
      {config === undefined ? (
        <p className="worker-config-note">
          This worker does not report its settings, so there is nothing to show
          yet. It reports them at its next heartbeat.
        </p>
      ) : (
        <div className="worker-config-form">
          {WORKER_CONFIG_KEYS.map((setting) => {
            const bounds = WORKER_CONFIG_BOUNDS[setting];
            const overridden = config.overridden.includes(setting);
            const code = config.code[setting];
            return (
              <div
                className="worker-config-row"
                key={setting}
              >
                <Field
                  label={setting}
                  hint={
                    <>
                      {SETTING_HINT[setting]} {bounds.min}–{bounds.max}.{" "}
                      {overridden
                        ? `Overridden; its code asks for ${code}.`
                        : `Its code asks for ${code}.`}
                    </>
                  }
                >
                  <NumberInput
                    value={valueOf(setting)}
                    min={bounds.min}
                    max={bounds.max}
                    onChange={(next) =>
                      setDraft((current) => ({ ...current, [setting]: next }))
                    }
                  />
                </Field>
                {overridden && (
                  <Button
                    size="sm"
                    onClick={() =>
                      setDraft((current) => ({ ...current, [setting]: code }))
                    }
                    disabled={pending}
                  >
                    Use code value
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
