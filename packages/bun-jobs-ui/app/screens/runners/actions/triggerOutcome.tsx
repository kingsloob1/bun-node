import type { RunnerInfoDto, TriggerOutcomeDto } from "../../../api/types";
import type { ToastApi } from "../../../components/toast";
import { CopyButton } from "../../../components/CopyButton";
import { SKIP_REASONS } from "./explain";

/**
 * Toasts a trigger's outcome: started (with the run id to copy), queued
 * (with its position, and for a remote runner who starts it), or skipped
 * (with the reason in words).
 */
export function toastTriggerOutcome(
  toast: ToastApi,
  runner: RunnerInfoDto,
  outcome: TriggerOutcomeDto,
): void {
  switch (outcome.outcome) {
    case "started":
      toast.success(`Run started on ${runner.id}`, {
        description: (
          <span className="run-id">
            <span>
              Run <code>{outcome.runId}</code>
            </span>
            <CopyButton
              text={outcome.runId}
              ariaLabel="Copy run id"
            />
          </span>
        ),
      });
      return;
    case "queued":
      toast.success(`Run queued on ${runner.id}`, {
        description: `Position ${outcome.position} in the trigger queue.${
          runner.isLocal
            ? " It starts when the runner is free."
            : " The process that owns the runner starts it at its next sync."
        }`,
      });
      return;
    case "skipped":
      toast.info(`Run skipped on ${runner.id}`, {
        description: SKIP_REASONS[outcome.reason] ?? outcome.reason,
      });
  }
}
