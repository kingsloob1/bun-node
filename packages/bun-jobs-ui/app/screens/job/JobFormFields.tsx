import type { AddJobField, AddJobForm, AddJobTiming } from "./addJobForm";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { MAX_JOB_ID_LENGTH } from "../../api/contract";
import { jobKeys, listDefinitions } from "../../api/jobs";
import { Field } from "../../components/Field";
import {
  DateTimeInput,
  NumberInput,
  Select,
  TextInput,
} from "../../components/inputs";
import { JsonEditor } from "../../components/JsonEditor";
import { useApiClient } from "../../context";
import { useCan } from "../../meta/hooks";

/**
 * The fields of one job to add, shared by the add-job dialog and each job of
 * the add-flow dialog: its name, its data and its options.
 */

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
export interface JobNameFieldProps {
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
export function JobNameField({
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

/** Props of {@link JobDataField}. */
export interface JobDataFieldProps {
  /** The editor's text. */
  value: string;
  /** Called with the editor's new state. */
  onChange: (data: AddJobForm["data"]) => void;
  /** The error to show under it. */
  error: string | undefined;
  /** `limits.maxJobDataBytes`, metered as the data is typed. */
  maxBytes: number;
  /** Visible rows. Defaults to 8. */
  rows?: number;
}

/** The job's data, as JSON (`null` allowed). */
export function JobDataField({
  value,
  onChange,
  error,
  maxBytes,
  rows = 8,
}: JobDataFieldProps) {
  return (
    <Field
      label="Data"
      required
      hint="JSON; null is allowed."
      error={error}
    >
      <JsonEditor
        value={value}
        onChange={onChange}
        maxBytes={maxBytes}
        rows={rows}
      />
    </Field>
  );
}

/** Props of {@link JobOptionsFields}. */
export interface JobOptionsFieldsProps {
  /** The form whose options are shown. */
  form: AddJobForm;
  /** Called with the fields that changed. */
  patch: (next: Partial<AddJobForm>) => void;
  /** The error to show under a field, if any. */
  fieldError: (field: AddJobField) => string | undefined;
  /** The run-time input's own problem (out of range, unparseable), or `undefined` once it has none. */
  onRunAtProblem: (problem: string | undefined) => void;
}

/** The options `POST /queues/:queue/jobs` accepts, in a fieldset of their own. */
export function JobOptionsFields({
  form,
  patch,
  fieldError,
  onRunAtProblem,
}: JobOptionsFieldsProps) {
  return (
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
            onProblem={onRunAtProblem}
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
  );
}
