import type { FormEvent } from "react";
import type { JobDto, JobState, UpdateJobBody } from "../../api/types";
import type { UpdateJobForm } from "./updateJobForm";
import { useId, useState } from "react";
import { JOB_STATES } from "../../api/contract";
import { isApiError } from "../../api/errors";
import { mutationInvalidation, updateJob } from "../../api/jobs";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import { Checkbox, DateTimeInput, NumberInput } from "../../components/inputs";
import { JsonEditor } from "../../components/JsonEditor";
import { jsonEditorState } from "../../components/jsonParse";
import { ProblemBanner } from "../../components/ProblemBanner";
import { useApiClient } from "../../context";
import { STATE_LABELS } from "../../format";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useFieldProblems } from "../../hooks/useFieldProblems";
import { useMeta } from "../../meta/hooks";
import { withFriendlyErrors } from "./jobErrors";
import { updateBody, validateUpdateForm } from "./updateJobForm";

/** Props of {@link UpdateJobDialog}. */
export interface UpdateJobDialogProps {
  /** The job being edited; its current values seed the form. */
  job: JobDto;
  /** Whether the dialog is open. The form resets on each opening. */
  open: boolean;
  /** Called to close it: cancel, Escape, or after a successful update. */
  onClose: () => void;
}

/** Edits a stored job's data, priority or run time (`PATCH /queues/:queue/jobs/:id`). */
export function UpdateJobDialog(props: UpdateJobDialogProps) {
  return props.open ? <OpenUpdateJobDialog {...props} /> : null;
}

/** The mounted dialog; its state lives exactly as long as one opening. */
function OpenUpdateJobDialog({ job, onClose }: UpdateJobDialogProps) {
  const api = useApiClient();
  const { limits } = useMeta();
  const formId = useId();
  const maxBytes = limits.maxJobDataBytes;
  const [form, setForm] = useState<UpdateJobForm>(() => ({
    changeData: false,
    data: jsonEditorState(JSON.stringify(job.data ?? null, null, 2), {
      maxBytes,
    }),
    priority: undefined,
    runAt: undefined,
    conditional: false,
    onlyIn: [job.state],
  }));
  const [submitted, setSubmitted] = useState(false);
  const times = useFieldProblems<"runAt">();
  const update = useApiMutation({
    mutationFn: async (body: UpdateJobBody) => {
      const run = () => updateJob(api, job.queue, job.id, body);
      return await withFriendlyErrors("update", run);
    },
    successMessage: "Job updated",
    invalidate: mutationInvalidation(job.queue),
    toastErrors: false,
    onSuccess: () => onClose(),
  });

  const clientErrors = submitted ? validateUpdateForm(form) : {};
  const serverErrors = update.fieldErrors;
  const fieldError = (key: "data" | "priority" | "runAt" | "onlyIn") =>
    (key === "runAt" ? times.problems.runAt : undefined) ??
    clientErrors[key] ??
    serverErrors[key];
  // A problem that is not a per-field VALIDATION issue is shown as a banner.
  const bannerError =
    update.error &&
    !(isApiError(update.error) && Object.keys(serverErrors).length > 0)
      ? update.error
      : null;
  const bodyError = serverErrors.body;

  const patch = (next: Partial<UpdateJobForm>) =>
    setForm((current) => ({ ...current, ...next }));

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (times.blocked || Object.keys(validateUpdateForm(form)).length > 0) {
      return;
    }
    update.mutate(updateBody(form));
  };

  const toggleState = (state: JobState, checked: boolean) =>
    setForm((current) => ({
      ...current,
      onlyIn: checked
        ? JOB_STATES.filter(
            (candidate) =>
              candidate === state || current.onlyIn.includes(candidate),
          )
        : current.onlyIn.filter((candidate) => candidate !== state),
    }));

  const close = () => {
    if (!update.isPending) {
      onClose();
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Edit job"
      description="Change what you tick or fill in; everything else stays as it is."
      size="lg"
      closeOnEscape={!update.isPending}
      closeOnBackdrop={!update.isPending}
      footer={
        <>
          <Button
            onClick={close}
            disabled={update.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={update.isPending || times.blocked}
            aria-busy={update.isPending || undefined}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="job-form"
        onSubmit={onSubmit}
        noValidate
      >
        <Checkbox
          checked={form.changeData}
          onChange={(changeData) => patch({ changeData })}
          label="Replace the data"
        />
        {form.changeData && (
          <Field
            label="Data"
            hint="JSON; null is allowed."
            error={fieldError("data")}
          >
            <JsonEditor
              value={form.data.text}
              onChange={(data) => patch({ data })}
              maxBytes={maxBytes}
              rows={8}
            />
          </Field>
        )}
        <Field
          label="Priority"
          hint={`Lower runs first. Now ${job.priority}; leave empty to keep it.`}
          error={fieldError("priority")}
        >
          <NumberInput
            value={form.priority}
            onChange={(priority) => patch({ priority })}
            step="any"
            placeholder={String(job.priority)}
          />
        </Field>
        <Field
          label="Run at"
          hint="Moves only a waiting or delayed job. Leave empty to keep it."
          error={fieldError("runAt")}
        >
          <DateTimeInput
            value={form.runAt}
            onChange={(runAt) => patch({ runAt })}
            onProblem={(problem) => times.report("runAt", problem)}
          />
        </Field>
        <Checkbox
          checked={form.conditional}
          onChange={(conditional) => patch({ conditional })}
          label="Only if the job is still in one of these states"
          hint="The change is skipped (and reported) if the job has moved on."
        />
        {form.conditional && (
          <fieldset
            className="job-states-picker"
            aria-invalid={Boolean(fieldError("onlyIn")) || undefined}
          >
            <legend>Only in</legend>
            {JOB_STATES.map((state) => (
              <Checkbox
                key={state}
                checked={form.onlyIn.includes(state)}
                onChange={(checked) => toggleState(state, checked)}
                label={STATE_LABELS[state]}
              />
            ))}
            {fieldError("onlyIn") && (
              <p className="field-error">{fieldError("onlyIn")}</p>
            )}
          </fieldset>
        )}
        {(clientErrors.form ?? bodyError) && (
          <p
            className="field-error job-form-error"
            role="alert"
          >
            {clientErrors.form ?? bodyError}
          </p>
        )}
        {bannerError && <ProblemBanner error={bannerError} />}
      </form>
    </Dialog>
  );
}
