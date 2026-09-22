import type { JobState } from "../../api/types";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { isApiError } from "../../api/errors";
import { clearJobLogs, jobKeys } from "../../api/jobs";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useApiClient } from "../../context";
import { plural } from "../../format";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useCanMutate } from "../queues/gating";
import { clearLogsBlocker } from "./clearLogs";
import { withFriendlyErrors } from "./jobErrors";

/** Props of {@link ClearLogsButton}. */
export interface ClearLogsButtonProps {
  /** The job's queue. */
  queue: string;
  /** The job's id. */
  id: string;
  /** The job's state: an `active` job's log cannot be cleared (409 `JOB_ACTIVE`). */
  state: JobState;
  /** How many lines the log holds, from the last page read; `null` until the first page has loaded. */
  total: number | null;
  /** Called after a successful clear, e.g. to go back to the first page. */
  onCleared?: () => void;
}

/**
 * "Clear logs…" and its confirmation (`DELETE /queues/:queue/jobs/:id/logs`),
 * offered when `jobs.clearLogs` is granted on a writable API. It stays in
 * place, disabled with its reason shown, while the job is active or the log
 * is empty, so the action does not appear and vanish as the job moves.
 */
export function ClearLogsButton({
  queue,
  id,
  state,
  total,
  onCleared,
}: ClearLogsButtonProps) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const canMutate = useCanMutate();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const clear = useApiMutation({
    mutationFn: () =>
      withFriendlyErrors("clearLogs", () => clearJobLogs(api, queue, id)),
    successMessage: (result) => `Cleared ${plural(result.removed, "line")}`,
    invalidate: [jobKeys.logsAll(queue, id)],
    toastErrors: false,
    onSuccess: () => onCleared?.(),
    onError: (error) => {
      // The job became active (or went away) since it was read: re-read it,
      // so the button shows why it is disabled.
      if (
        isApiError(error) &&
        (error.code === "JOB_ACTIVE" || error.code === "JOB_NOT_FOUND")
      ) {
        void queryClient.invalidateQueries({
          queryKey: jobKeys.job(queue, id),
        });
      }
    },
  });

  if (!canMutate("jobs.clearLogs")) {
    return null;
  }
  const blocker = clearLogsBlocker(state, total);
  return (
    <span className="job-logs-clear">
      <Button
        variant="danger"
        size="sm"
        disabled={blocker !== null || total === null}
        aria-describedby={blocker ? reasonId : undefined}
        onClick={() => setOpen(true)}
      >
        Clear logs…
      </Button>
      {blocker && (
        <span
          id={reasonId}
          className="muted job-logs-clear-reason"
          data-testid="clear-logs-reason"
        >
          {blocker}
        </span>
      )}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        variant="danger"
        title={`Clear the ${plural(total ?? 0, "log line")} of this job?`}
        description={
          <>
            Job <code>{id}</code>'s log is emptied, and its next line is
            numbered 1 again. The job itself, its state and its counters are
            untouched. This cannot be undone.
          </>
        }
        confirmLabel="Clear logs"
        pendingLabel="Clearing…"
        onConfirm={() => clear.mutateAsync()}
      />
    </span>
  );
}
