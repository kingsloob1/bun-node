import type { KillRunnerBody } from "../../../api/types";
import type { RunnerDialogProps } from "./TriggerDialog";
import { useState } from "react";
import {
  killRunner,
  resetRunnerStats,
  resumeRunner,
} from "../../../api/runnerActions";
import { runnerInvalidations } from "../../../api/runners";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Field } from "../../../components/Field";
import { Checkbox, Select, TextInput } from "../../../components/inputs";
import { useToast } from "../../../components/toast";
import { useApiClient } from "../../../context";
import { plural } from "../../../format";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { explained } from "./explain";

/** The longest kill reason the API accepts (`KillBodySchema`). */
const MAX_KILL_REASON = 200;

/** `POST /runners/:runner/resume`, optionally asking for a run at once. */
export function ResumeDialog({ runner, onClose }: RunnerDialogProps) {
  const api = useApiClient();
  const [triggerNow, setTriggerNow] = useState(false);
  const resume = useApiMutation({
    mutationFn: (now: boolean) => resumeRunner(api, runner.id, now),
    successMessage: (_result, now) =>
      `Resumed ${runner.id}${now ? " and asked for a run" : ""}${
        runner.isLocal ? "" : "; its owner picks it up at its next sync"
      }`,
    invalidate: runnerInvalidations(runner.id),
    toastErrors: false,
  });
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Resume ${runner.id}?`}
      description="Scheduled and manual runs start again, everywhere the runner is registered."
      confirmLabel="Resume"
      pendingLabel="Resuming…"
      onConfirm={async () => {
        try {
          await resume.mutateAsync(triggerNow);
        } catch (error) {
          throw explained(error, "resume");
        }
      }}
    >
      <Checkbox
        checked={triggerNow}
        onChange={setTriggerNow}
        label="Also trigger a run now"
      />
    </ConfirmDialog>
  );
}

/**
 * `POST /runners/:runner/kill`: one active run or all of them, typed
 * confirmation by the runner id. With `wait` the API answers only once the
 * runs settled, which can take the runner's closeTimeout plus killTimeout,
 * so the dialog says it is waiting.
 */
export function KillDialog({ runner, onClose }: RunnerDialogProps) {
  const api = useApiClient();
  const toast = useToast();
  const activeRuns = runner.local?.activeRuns ?? [];
  const [runId, setRunId] = useState("");
  const [force, setForce] = useState(false);
  const [reason, setReason] = useState("");
  const [wait, setWait] = useState(false);
  const kill = useApiMutation({
    mutationFn: (body: KillRunnerBody) => killRunner(api, runner.id, body),
    onSuccess: (result, body) => {
      const count = result.runIds.length;
      if (count === 0) {
        toast.info(`No run was active on ${runner.id}`);
        return;
      }
      toast.success(
        body.wait
          ? `Killed ${plural(count, "run")} on ${runner.id}`
          : `Kill requested for ${plural(count, "run")} on ${runner.id}`,
        { description: result.runIds.join(", ") },
      );
    },
    invalidate: runnerInvalidations(runner.id),
    toastErrors: false,
  });
  const trimmed = reason.trim();
  const waiting = kill.isPending && kill.variables?.wait === true;
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Kill runs of ${runner.id}?`}
      description="Stops the chosen run (or every active run) in this process: it is asked to close, then killed once its timeouts pass. The runs are recorded as killed."
      variant="danger"
      confirmLabel="Kill"
      pendingLabel={wait ? "Waiting for the runs to settle…" : "Killing…"}
      confirmText={runner.id}
      confirmDisabled={trimmed.length > MAX_KILL_REASON}
      onConfirm={async () => {
        try {
          await kill.mutateAsync({
            ...(runId ? { runId } : {}),
            ...(force ? { force: true } : {}),
            ...(trimmed ? { reason: trimmed } : {}),
            ...(wait ? { wait: true } : {}),
          });
        } catch (error) {
          throw explained(error, "kill");
        }
      }}
    >
      <Field label="Run">
        <Select
          options={[
            {
              value: "",
              label: `Every active run (${activeRuns.length})`,
            },
            ...activeRuns.map((run) => ({
              value: run.runId,
              label: `${run.runId} (${run.source}, attempt ${run.attempt})`,
            })),
          ]}
          value={runId}
          onChange={setRunId}
          disabled={kill.isPending}
        />
      </Field>
      <Checkbox
        checked={force}
        onChange={setForce}
        label="Force"
        hint="Skip straight to the end of the kill escalation instead of asking the run to close first."
        disabled={kill.isPending}
      />
      <Field
        label="Reason"
        hint={`Optional, recorded on the run. At most ${MAX_KILL_REASON} characters.`}
        error={
          kill.fieldErrors.reason ??
          (trimmed.length > MAX_KILL_REASON
            ? `At most ${MAX_KILL_REASON} characters.`
            : undefined)
        }
      >
        <TextInput
          value={reason}
          onChange={setReason}
          disabled={kill.isPending}
        />
      </Field>
      <Checkbox
        checked={wait}
        onChange={setWait}
        label="Wait until the runs have settled"
        hint="Answer only once they have stopped. This can take the runner's closeTimeout plus killTimeout."
        disabled={kill.isPending}
      />
      {waiting && (
        <p
          className="runner-note runner-note-pending"
          role="status"
          data-testid="kill-waiting"
        >
          Waiting for the runs to settle. This can take the runner's
          closeTimeout plus killTimeout.
        </p>
      )}
    </ConfirmDialog>
  );
}

/** `POST /runners/:runner/stats/reset` (204): the lifetime counters back to zero. */
export function ResetStatsDialog({ runner, onClose }: RunnerDialogProps) {
  const api = useApiClient();
  const reset = useApiMutation({
    mutationFn: () => resetRunnerStats(api, runner.id),
    successMessage: `Reset the stats of ${runner.id}`,
    invalidate: runnerInvalidations(runner.id),
    toastErrors: false,
  });
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Reset the stats of ${runner.id}?`}
      description="Sets every lifetime counter (success, failed, timeout, killed, skipped, queued, total) back to zero, for every process. History is kept. This cannot be undone."
      variant="danger"
      confirmLabel="Reset stats"
      pendingLabel="Resetting…"
      onConfirm={async () => {
        try {
          await reset.mutateAsync();
        } catch (error) {
          throw explained(error, "resetStats");
        }
      }}
    />
  );
}
