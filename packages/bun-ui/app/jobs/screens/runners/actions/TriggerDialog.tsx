import type { RunnerInfoDto, TriggerRunnerBody } from "../../../api/types";
import type { JsonEditorState } from "../../../components/jsonParse";
import { useState } from "react";
import { triggerRunner } from "../../../api/runnerActions";
import { runnerInvalidations } from "../../../api/runners";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Field } from "../../../components/Field";
import { Checkbox } from "../../../components/inputs";
import { JsonEditor } from "../../../components/JsonEditor";
import { jsonEditorState } from "../../../components/jsonParse";
import { useToast } from "../../../components/toast";
import { useApiClient } from "../../../context";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { useMeta } from "../../../meta/hooks";
import { explained } from "./explain";
import { toastTriggerOutcome } from "./triggerOutcome";

/** Props of one runner action dialog. */
export interface RunnerDialogProps {
  /** The runner acted on. */
  runner: RunnerInfoDto;
  /** Closes the dialog. */
  onClose: () => void;
}

/** `POST /runners/:runner/trigger`: force, and args only when the API accepts them. */
export function TriggerDialog({ runner, onClose }: RunnerDialogProps) {
  const api = useApiClient();
  const meta = useMeta();
  const toast = useToast();
  const maxBytes = meta.limits.maxJobDataBytes;
  const [force, setForce] = useState(false);
  const [args, setArgs] = useState<JsonEditorState>(() =>
    jsonEditorState("", { maxBytes, allowEmpty: true }),
  );
  const trigger = useApiMutation({
    mutationFn: (body: TriggerRunnerBody) =>
      triggerRunner(api, runner.id, body),
    onSuccess: (outcome) => toastTriggerOutcome(toast, runner, outcome),
    invalidate: runnerInvalidations(runner.id),
    toastErrors: false,
  });
  const argsAllowed = meta.runnerTriggerArgs;
  const argsInvalid = argsAllowed && (!args.valid || args.overLimit);

  const confirm = async () => {
    const body: TriggerRunnerBody = {
      ...(force ? { force: true } : {}),
      ...(argsAllowed && args.value !== undefined ? { args: args.value } : {}),
    };
    try {
      await trigger.mutateAsync(body);
    } catch (error) {
      throw explained(error, "trigger");
    }
  };

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Trigger ${runner.id}?`}
      description="Asks for a run now. It starts at once, waits in the trigger queue, or is skipped, depending on the runner's state and options."
      confirmLabel="Trigger"
      pendingLabel="Triggering…"
      confirmDisabled={argsInvalid}
      onConfirm={confirm}
    >
      <Checkbox
        checked={force}
        onChange={setForce}
        label="Run even while paused"
        hint="Force skips only the pause check. A busy runner, a lock held elsewhere, the concurrency cap and a full trigger queue still apply."
      />
      {argsAllowed && (
        <Field
          label="Arguments"
          hint="Optional JSON handed to this run; leave empty for the runner's own args."
        >
          <JsonEditor
            value={args.text}
            onChange={setArgs}
            maxBytes={maxBytes}
            allowEmpty
            rows={6}
          />
        </Field>
      )}
      {!runner.isLocal && (
        <p
          className="runner-note"
          role="note"
          data-testid="trigger-non-local-note"
        >
          This runner is registered in another process, so the run is queued for
          it: its owner starts it at its next sync.
        </p>
      )}
    </ConfirmDialog>
  );
}
