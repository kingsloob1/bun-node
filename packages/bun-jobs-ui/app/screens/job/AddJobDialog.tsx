import type { FormEvent } from "react";
import type { AddJobBody, AddJobResultDto } from "../../api/types";
import type { AddJobField, AddJobForm } from "./addJobForm";
import { useId, useState } from "react";
import { isApiError } from "../../api/errors";
import { addJob, jobScreenPath, mutationInvalidation } from "../../api/jobs";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ProblemBanner } from "../../components/ProblemBanner";
import { useToast } from "../../components/toast";
import { useApiClient } from "../../context";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useFieldProblems } from "../../hooks/useFieldProblems";
import { useMeta } from "../../meta/hooks";
import { useNavigate } from "../../routing";
import { addBody, emptyAddForm, validateAddForm } from "./addJobForm";
import { explainJobError } from "./jobErrors";
import { JobDataField, JobNameField, JobOptionsFields } from "./JobFormFields";
import "./job.css";

/** Props of {@link AddJobDialog}. This interface is the contract between the two screens: keep it. */
export interface AddJobDialogProps {
  /** The queue the job is added to. */
  queue: string;
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to close it: cancel, Escape, or after a successful add. */
  onClose: () => void;
}

/** Adds a job to a queue (`POST /queues/:queue/jobs`). */
export function AddJobDialog(props: AddJobDialogProps) {
  return props.open ? <OpenAddJobDialog {...props} /> : null;
}

/** The mounted dialog; its state lives exactly as long as one opening. */
function OpenAddJobDialog({ queue, onClose }: AddJobDialogProps) {
  const api = useApiClient();
  const meta = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const formId = useId();
  const maxBytes = meta.limits.maxJobDataBytes;
  const addableNames = meta.addableNames;
  const nothingAddable = addableNames !== null && addableNames.length === 0;
  const [form, setForm] = useState<AddJobForm>(() =>
    emptyAddForm({ addableNames, maxBytes }),
  );
  const [submitted, setSubmitted] = useState(false);
  const times = useFieldProblems<"opts.runAt">();

  const add = useApiMutation({
    mutationFn: (body: AddJobBody) => addJob(api, queue, body),
    invalidate: mutationInvalidation(queue),
    toastErrors: false,
    onSuccess: (result: AddJobResultDto) => {
      const view = {
        label: "View job",
        onClick: () => navigate(jobScreenPath(queue, result.job.id)),
      };
      if (result.added) {
        toast.success(`Job added to ${queue}`, {
          description: `Id ${result.job.id}`,
          action: view,
        });
      } else {
        toast.info("A job with this id already exists", {
          description: `Nothing was added; ${result.job.id} is the existing job.`,
          action: view,
        });
      }
      onClose();
    },
  });

  const clientErrors = submitted ? validateAddForm(form) : {};
  const serverErrors = add.fieldErrors;
  const apiError = isApiError(add.error) ? add.error : null;
  // NAME_NOT_ADDABLE belongs to the name, SERIALIZATION to the data.
  const inlineCode =
    apiError?.code === "NAME_NOT_ADDABLE" || apiError?.code === "SERIALIZATION"
      ? apiError.code
      : null;
  const fieldError = (key: AddJobField): string | undefined =>
    (key === "opts.runAt" ? times.problems["opts.runAt"] : undefined) ??
    clientErrors[key] ??
    serverErrors[key] ??
    (key === "name" && inlineCode === "NAME_NOT_ADDABLE" && apiError
      ? (explainJobError(apiError, "add") ?? apiError.detail)
      : undefined) ??
    (key === "data" && inlineCode === "SERIALIZATION" && apiError
      ? (explainJobError(apiError, "add") ?? apiError.detail)
      : undefined);
  const bannerError =
    add.error && !inlineCode && Object.keys(serverErrors).length === 0
      ? add.error
      : null;
  const bodyError = serverErrors.body ?? serverErrors.opts;

  const patch = (next: Partial<AddJobForm>) =>
    setForm((current) => ({ ...current, ...next }));

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (
      nothingAddable ||
      times.blocked ||
      Object.keys(validateAddForm(form)).length > 0
    ) {
      return;
    }
    add.mutate(addBody(form));
  };

  const close = () => {
    if (!add.isPending) {
      onClose();
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title={
        <>
          Add a job to <code>{queue}</code>
        </>
      }
      size="lg"
      closeOnEscape={!add.isPending}
      closeOnBackdrop={!add.isPending}
      footer={
        <>
          <Button
            onClick={close}
            disabled={add.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={add.isPending || nothingAddable || times.blocked}
            aria-busy={add.isPending || undefined}
          >
            {add.isPending ? "Adding…" : "Add job"}
          </Button>
        </>
      }
    >
      {nothingAddable ? (
        <EmptyState
          title="No job can be added here"
          description="This API accepts no job names: adding jobs is switched off (the jobs.add action is not enabled, or the API is read-only), or no name is allowed. Ask whoever runs it to list the names in addableNames."
        />
      ) : (
        <form
          id={formId}
          className="job-form"
          onSubmit={onSubmit}
          noValidate
        >
          <JobNameField
            value={form.name}
            onChange={(name) => patch({ name })}
            error={fieldError("name")}
            addableNames={addableNames}
          />
          <JobDataField
            value={form.data.text}
            onChange={(data) => patch({ data })}
            error={fieldError("data")}
            maxBytes={maxBytes}
          />
          <JobOptionsFields
            form={form}
            patch={patch}
            fieldError={fieldError}
            onRunAtProblem={(problem) => times.report("opts.runAt", problem)}
          />
          {bodyError && (
            <p
              className="field-error job-form-error"
              role="alert"
            >
              {bodyError}
            </p>
          )}
          {bannerError && <ProblemBanner error={bannerError} />}
        </form>
      )}
    </Dialog>
  );
}
