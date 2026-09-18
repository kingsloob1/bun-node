import type { JobDto } from "../../api/types";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  jobKeys,
  mutationInvalidation,
  promoteJob,
  queueScreenPath,
  removeJob,
  retryJob,
} from "../../api/jobs";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Checkbox } from "../../components/inputs";
import { useApiClient } from "../../context";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useNavigate } from "../../routing";
import { withFriendlyErrors } from "./jobErrors";
import { useJobActionGates } from "./jobGates";
import { UpdateJobDialog } from "./UpdateJobDialog";

/** The dialog currently open, if any. */
type OpenDialog = "retry" | "remove" | "update" | null;

/** The job's action buttons and their dialogs. Renders nothing when no action is allowed. */
export function JobActions({ job }: { job: JobDto }) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const gates = useJobActionGates(job);
  const [open, setOpen] = useState<OpenDialog>(null);
  const [resetAttempts, setResetAttempts] = useState(true);
  const invalidate = mutationInvalidation(job.queue);

  const retry = useApiMutation({
    mutationFn: async (reset: boolean) => {
      const run = () => retryJob(api, job.queue, job.id, reset);
      return await withFriendlyErrors("retry", run);
    },
    successMessage: "Job retried: it is waiting to run again",
    invalidate,
    // The confirm dialog shows the failure in place.
    toastErrors: false,
  });
  const promote = useApiMutation({
    mutationFn: () =>
      withFriendlyErrors("promote", () => promoteJob(api, job.queue, job.id)),
    successMessage: "Job promoted: it can run now",
    errorTitle: "Could not promote the job",
    invalidate,
  });
  const remove = useApiMutation({
    mutationFn: () =>
      withFriendlyErrors("remove", () => removeJob(api, job.queue, job.id)),
    successMessage: "Job removed",
    invalidate,
    toastErrors: false,
    onSuccess: async () => {
      // Drop the job's cache first, so the invalidation after this does not
      // re-read a job that no longer exists.
      await queryClient.cancelQueries({
        queryKey: jobKeys.job(job.queue, job.id),
      });
      queryClient.removeQueries({ queryKey: jobKeys.job(job.queue, job.id) });
      navigate(queueScreenPath(job.queue));
    },
  });

  if (!gates.retry && !gates.promote && !gates.remove && !gates.update) {
    return null;
  }
  return (
    <div
      className="job-actions"
      role="group"
      aria-label="Job actions"
    >
      {gates.retry && (
        <Button
          onClick={() => {
            setResetAttempts(true);
            setOpen("retry");
          }}
        >
          Retry
        </Button>
      )}
      {gates.promote && (
        <Button
          disabled={promote.isPending}
          aria-busy={promote.isPending || undefined}
          onClick={() => promote.mutate()}
        >
          {promote.isPending ? "Promoting…" : "Promote"}
        </Button>
      )}
      {gates.update && <Button onClick={() => setOpen("update")}>Edit</Button>}
      {gates.remove && (
        <Button
          variant="danger"
          onClick={() => setOpen("remove")}
        >
          Remove
        </Button>
      )}

      <ConfirmDialog
        open={open === "retry"}
        onClose={() => setOpen(null)}
        title="Retry this job?"
        description="It goes back to waiting and runs again."
        confirmLabel="Retry"
        pendingLabel="Retrying…"
        onConfirm={() => retry.mutateAsync(resetAttempts)}
      >
        <Checkbox
          checked={resetAttempts}
          onChange={setResetAttempts}
          label="Reset attempts"
          hint="Count attempts from zero again, so it gets its full allowance of retries."
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={open === "remove"}
        onClose={() => setOpen(null)}
        variant="danger"
        title="Remove this job?"
        description={
          <>
            Job <code>{job.id}</code> and its logs are deleted. This cannot be
            undone.
          </>
        }
        confirmLabel="Remove"
        pendingLabel="Removing…"
        onConfirm={() => remove.mutateAsync()}
      />

      <UpdateJobDialog
        job={job}
        open={open === "update"}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}
