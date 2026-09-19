import type { FormEvent } from "react";
import type { AddJobBody, AddJobResultDto } from "../../api/types";
import type { AddJobField, AddJobForm, AddJobTiming } from "./addJobForm";
import { MAX_JOB_ID_LENGTH } from "@kingsleyweb/bun-jobs/api/contract";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { isApiError } from "../../api/errors";
import {
  addJob,
  jobKeys,
  jobScreenPath,
  listDefinitions,
  mutationInvalidation,
} from "../../api/jobs";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { Field } from "../../components/Field";
import {
  DateTimeInput,
  NumberInput,
  Select,
  TextInput,
} from "../../components/inputs";
import { JsonEditor } from "../../components/JsonEditor";
import { jsonEditorState } from "../../components/jsonParse";
import { ProblemBanner } from "../../components/ProblemBanner";
import { useToast } from "../../components/toast";
import { useApiClient } from "../../context";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useFieldProblems } from "../../hooks/useFieldProblems";
import { useCan, useMeta } from "../../meta/hooks";
import { useNavigate } from "../../routing";
import { addBody, validateAddForm } from "./addJobForm";
import { explainJobError } from "./jobErrors";
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

/** The timing choices. */
const TIMING_OPTIONS = [
  { value: "now", label: "Now" },
  { value: "delay", label: "After a delay" },
  { value: "runAt", label: "At a time" },
] as const satisfies readonly { value: AddJobTiming; label: string }[];

/**
 * Select values that cannot be job names in practice (bun-jobs refuses
 * control characters in names' ids, and no sane name starts with NUL):
 * "nothing picked yet" and "type another name".
 */
const PICK_NAME = "\u0000pick";
/** See {@link PICK_NAME}. */
const OTHER_NAME = "\u0000other";

/** Props of {@link JobNameField}. */
interface JobNameFieldProps {
  /** The chosen name. */
  value: string;
  /** Called with a new name. */
  onChange: (name: string) => void;
  /** The error to show under it. */
  error: string | undefined;
  /** `MetaDto.addableNames`: `null` for any name. */
  addableNames: string[] | null;
}

/**
 * The name picker: the allowed names when the API lists them; otherwise the
 * defined names (from `/definitions`) plus free text, since any name goes.
 */
function JobNameField({
  value,
  onChange,
  error,
  addableNames,
}: JobNameFieldProps) {
  const api = useApiClient();
  const canDefinitions = useCan("definitions.list");
  const anyName = addableNames === null;
  const definitions = useQuery({
    queryKey: jobKeys.definitions(),
    queryFn: ({ signal }) => listDefinitions(api, signal),
    enabled: anyName && canDefinitions,
    staleTime: 60_000,
  });
  const [typing, setTyping] = useState(false);

  if (!anyName) {
    return (
      <Field
        label="Name"
        required
        error={error}
      >
        <Select
          options={[
            { value: "", label: "Pick a name…", disabled: true },
            ...addableNames.map((name) => ({ value: name })),
          ]}
          value={value}
          onChange={onChange}
        />
      </Field>
    );
  }

  const defined = definitions.data?.items.map((item) => item.name) ?? [];
  const freeText = typing || defined.length === 0;
  return (
    <>
      {defined.length > 0 && (
        <Field
          label="Name"
          required
          hint="Any name is accepted; the defined ones are listed."
          error={freeText ? undefined : error}
        >
          <Select
            options={[
              { value: PICK_NAME, label: "Pick a name…", disabled: true },
              ...defined.map((name) => ({ value: name })),
              { value: OTHER_NAME, label: "Another name…" },
            ]}
            value={
              freeText
                ? OTHER_NAME
                : defined.includes(value)
                  ? value
                  : PICK_NAME
            }
            onChange={(chosen) => {
              if (chosen === OTHER_NAME) {
                setTyping(true);
                onChange("");
              } else {
                setTyping(false);
                onChange(chosen);
              }
            }}
          />
        </Field>
      )}
      {freeText && (
        <Field
          label={defined.length > 0 ? "Another name" : "Name"}
          required
          hint={
            defined.length > 0
              ? undefined
              : "Any name is accepted. A worker must handle it for the job to run."
          }
          error={error}
        >
          <TextInput
            value={value}
            onChange={onChange}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
    </>
  );
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
  const [form, setForm] = useState<AddJobForm>(() => ({
    name: addableNames?.length === 1 ? addableNames[0]! : "",
    data: jsonEditorState("{}", { maxBytes }),
    jobId: "",
    priority: undefined,
    timing: "now",
    delay: undefined,
    runAt: undefined,
    attempts: undefined,
    backoff: undefined,
    timeout: undefined,
  }));
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
          <Field
            label="Data"
            required
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
          <fieldset className="job-form-options">
            <legend>Options</legend>
            <Field
              label="Job id"
              hint={`Optional, at most ${MAX_JOB_ID_LENGTH} characters. An id that already exists returns that job instead.`}
              error={fieldError("opts.jobId")}
            >
              <TextInput
                value={form.jobId}
                onChange={(jobId) => patch({ jobId })}
                maxLength={MAX_JOB_ID_LENGTH}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Priority"
              hint="Lower runs first."
              error={fieldError("opts.priority")}
            >
              <NumberInput
                value={form.priority}
                onChange={(priority) => patch({ priority })}
                step="any"
              />
            </Field>
            <Field label="Run">
              <Select
                options={TIMING_OPTIONS}
                value={form.timing}
                onChange={(timing) => patch({ timing })}
              />
            </Field>
            {form.timing === "delay" && (
              <Field
                label="Delay (ms)"
                required
                error={fieldError("opts.delay")}
              >
                <NumberInput
                  value={form.delay}
                  onChange={(delay) => patch({ delay })}
                  min={0}
                />
              </Field>
            )}
            {form.timing === "runAt" && (
              <Field
                label="Run at"
                required
                error={fieldError("opts.runAt")}
              >
                <DateTimeInput
                  value={form.runAt}
                  onChange={(runAt) => patch({ runAt })}
                  onProblem={(problem) => times.report("opts.runAt", problem)}
                />
              </Field>
            )}
            <Field
              label="Attempts"
              hint="Attempts allowed in total, 1 or more."
              error={fieldError("opts.attempts")}
            >
              <NumberInput
                value={form.attempts}
                onChange={(attempts) => patch({ attempts })}
                min={1}
              />
            </Field>
            <Field
              label="Backoff (ms)"
              hint="Fixed delay between attempts."
              error={fieldError("opts.backoff")}
            >
              <NumberInput
                value={form.backoff}
                onChange={(backoff) => patch({ backoff })}
                min={0}
              />
            </Field>
            <Field
              label="Timeout (ms)"
              hint="How long one attempt may run."
              error={fieldError("opts.timeout")}
            >
              <NumberInput
                value={form.timeout}
                onChange={(timeout) => patch({ timeout })}
                min={0}
              />
            </Field>
          </fieldset>
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
