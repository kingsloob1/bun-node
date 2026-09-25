/**
 * A runner's actions: trigger, pause/resume, reschedule, edit its settings,
 * kill, reset stats and clear the run history, with their dialogs. The runner screen mounts
 * {@link RunnerActions} in its header; this props interface is the contract
 * between the two, so keep it.
 */
import type { RunnerInfoDto } from "../../../api/types";
import { useState } from "react";
import { isApiError } from "../../../api/errors";
import { pauseRunner } from "../../../api/runnerActions";
import { runnerInvalidations } from "../../../api/runners";
import { Button } from "../../../components/Button";
import { useToast } from "../../../components/toast";
import { useApiClient } from "../../../context";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { useCanMutate } from "../../queues/gating";
import { ConfigEditorDialog } from "./ConfigEditorDialog";
import { explainRunnerError } from "./explain";
import { runnerActionGates } from "./gating";
import { KillDialog, ResetStatsDialog, ResumeDialog } from "./RunnerDialogs";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { TriggerDialog } from "./TriggerDialog";
import "./actions.css";

/** Props of {@link RunnerActions}. */
export interface RunnerActionsProps {
  /** The runner as `GET /runners/:runner` last returned it. */
  runner: RunnerInfoDto;
}

/** Which dialog is open. */
type OpenDialog =
  | "trigger"
  | "resume"
  | "schedule"
  | "config"
  | "kill"
  | "reset"
  | null;

/**
 * The action buttons (and their dialogs) for one runner, each present only
 * when the runner-scoped permission is held and the API is not read-only.
 * Kill and reset stats exist only for a runner registered in the API's
 * process; for one registered in another process a hint says why they are
 * absent. Clearing the history works on any runner.
 */
export function RunnerActions({ runner }: RunnerActionsProps) {
  const api = useApiClient();
  const toast = useToast();
  const canMutate = useCanMutate();
  const [open, setOpen] = useState<OpenDialog>(null);
  const close = () => setOpen(null);
  const gates = runnerActionGates(runner, canMutate);

  const pause = useApiMutation({
    mutationFn: () => pauseRunner(api, runner.id),
    successMessage: runner.isLocal
      ? `Paused ${runner.id}`
      : `Paused ${runner.id}; its owner stops at its next sync`,
    invalidate: runnerInvalidations(runner.id),
    toastErrors: false,
    onError: (error) => {
      toast.error(`Could not pause ${runner.id}`, {
        description: isApiError(error)
          ? (explainRunnerError(error, "pause") ?? error.detail ?? error.title)
          : error.message,
      });
    },
  });

  const any =
    gates.trigger ||
    gates.pause ||
    gates.resume ||
    gates.reschedule ||
    gates.configure ||
    gates.kill ||
    gates.resetStats;
  if (!any && !gates.nonLocalOnly) {
    return null;
  }

  return (
    <div
      className="runner-actions"
      role="group"
      aria-label="Runner actions"
    >
      {gates.trigger && (
        <Button
          variant="primary"
          onClick={() => setOpen("trigger")}
        >
          Trigger…
        </Button>
      )}
      {gates.pause && (
        <Button
          onClick={() => pause.mutate()}
          disabled={pause.isPending}
          aria-busy={pause.isPending || undefined}
        >
          Pause
        </Button>
      )}
      {gates.resume && (
        <Button onClick={() => setOpen("resume")}>Resume…</Button>
      )}
      {gates.reschedule && (
        <Button onClick={() => setOpen("schedule")}>Reschedule…</Button>
      )}
      {gates.configure && (
        <Button onClick={() => setOpen("config")}>Settings…</Button>
      )}
      {gates.resetStats && (
        <Button
          variant="danger"
          onClick={() => setOpen("reset")}
        >
          Reset stats…
        </Button>
      )}
      {gates.kill && (
        <Button
          variant="danger"
          onClick={() => setOpen("kill")}
        >
          Kill…
        </Button>
      )}
      {gates.nonLocalOnly && (
        <p
          className="runner-actions-hint"
          data-testid="runner-non-local-hint"
        >
          Registered in another process: kill and reset stats are only available
          from the API of the process that runs it, and other changes reach it
          at its next sync.
        </p>
      )}
      {open === "trigger" && (
        <TriggerDialog
          runner={runner}
          onClose={close}
        />
      )}
      {open === "resume" && (
        <ResumeDialog
          runner={runner}
          onClose={close}
        />
      )}
      {open === "schedule" && (
        <ScheduleEditorDialog
          runner={runner}
          onClose={close}
        />
      )}
      {open === "config" && runner.config !== undefined && (
        <ConfigEditorDialog
          runner={runner}
          config={runner.config}
          onClose={close}
        />
      )}
      {open === "kill" && (
        <KillDialog
          runner={runner}
          onClose={close}
        />
      )}
      {open === "reset" && (
        <ResetStatsDialog
          runner={runner}
          onClose={close}
        />
      )}
    </div>
  );
}
