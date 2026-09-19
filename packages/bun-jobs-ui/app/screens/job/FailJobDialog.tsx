import type { JobDto } from "../../api/types";
import { useState } from "react";
import {
  FAIL_REASON_MAX_LENGTH,
  failJob,
  mutationInvalidation,
} from "../../api/jobs";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import { TextInput } from "../../components/inputs";
import { useApiClient } from "../../context";
import { formatNumber } from "../../format";
import { useApiMutation } from "../../hooks/useApiMutation";
import { FAIL_CONFIRM_TAIL_LENGTH, failConfirmation } from "./failConfirm";
import { withFriendlyErrors } from "./jobErrors";

/** Props of {@link FailJobDialog}. */
export interface FailJobDialogProps {
  /** The job to fail. */
  job: JobDto;
  /** Whether the dialog is open. The reason resets on each opening. */
  open: boolean;
  /** Called to close it: cancel, Escape, or after a successful fail. */
  onClose: () => void;
}

/** Fails a job for good (`POST /queues/:queue/jobs/:id/fail`), with a required reason. */
export function FailJobDialog(props: FailJobDialogProps) {
  return props.open ? <OpenFailJobDialog {...props} /> : null;
}

/** The mounted dialog; its state lives exactly as long as one opening. */
function OpenFailJobDialog({ job, onClose }: FailJobDialogProps) {
  const api = useApiClient();
  const [reason, setReason] = useState("");
  const fail = useApiMutation({
    mutationFn: async (text: string) => {
      const run = () => failJob(api, job.queue, job.id, text);
      return await withFriendlyErrors("fail", run);
    },
    successMessage: "Job failed: it is dead, with no attempts left",
    invalidate: mutationInvalidation(job.queue),
    // The confirm dialog shows the failure in place.
    toastErrors: false,
  });
  // The API stores the reason exactly as sent, so it is sent as typed: it
  // needs a character other than whitespace (the schema's `\S`) and at
  // most FAIL_REASON_MAX_LENGTH characters, spaces counted.
  const blank = !/\S/.test(reason);
  const tooLong = reason.length > FAIL_REASON_MAX_LENGTH;
  const confirmation = failConfirmation(job.id);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      variant="danger"
      title="Fail this job?"
      description={
        <>
          Job <code>{job.id}</code> goes to dead for good, with your reason as
          its failure, whatever attempts it has left. It gets the{" "}
          <code>failed</code> and <code>dead</code> events and a copy in its
          dead-letter queue.
        </>
      }
      confirmLabel="Fail job"
      pendingLabel="Failing…"
      confirmText={confirmation.text}
      confirmTextLabel={
        confirmation.whole ? undefined : (
          <>
            Type the id's last {FAIL_CONFIRM_TAIL_LENGTH} characters,{" "}
            <code>{confirmation.text}</code>, to confirm
          </>
        )
      }
      confirmDisabled={blank || tooLong}
      onConfirm={() => fail.mutateAsync(reason)}
    >
      {job.state === "active" && (
        <p
          className="job-note job-note-warning"
          data-testid="fail-active-note"
        >
          This job is running. Failing it does not stop its code: its worker
          loses the job's lock at its next heartbeat and the attempt's signal is
          aborted, but the processor runs until it returns, and whatever it
          returns or throws is discarded.
        </p>
      )}
      <Field
        label="Reason"
        required
        hint={`Recorded as the job's failure, exactly as typed. At most ${formatNumber(FAIL_REASON_MAX_LENGTH)} characters.`}
        error={
          fail.fieldErrors.reason ??
          (tooLong
            ? `At most ${formatNumber(FAIL_REASON_MAX_LENGTH)} characters.`
            : reason !== "" && blank
              ? "Spaces alone are not a reason: type some text."
              : undefined)
        }
      >
        <TextInput
          value={reason}
          onChange={setReason}
          disabled={fail.isPending}
        />
      </Field>
    </ConfirmDialog>
  );
}
