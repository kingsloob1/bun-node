import type { JobDefaultKey } from "../../../../api/contract";
import type { JobDefaultsDto } from "../../../../api/types";
import type {
  BackoffDraft,
  Draft,
  DraftOf,
  NumberKey,
  RetentionDraft,
  RetentionMode,
} from "./draft";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_BOUNDS,
} from "../../../../api/contract";
import { isApiError } from "../../../../api/errors";
import {
  getJobDefaults,
  jobDefaultsKey,
  resetJobDefaults,
  setJobDefaults,
} from "../../../../api/jobDefaults";
import { mutationInvalidations } from "../../../../api/queues";
import { Badge } from "../../../../components/Badge";
import { Button } from "../../../../components/Button";
import { Dialog } from "../../../../components/Dialog";
import { Field } from "../../../../components/Field";
import { NumberInput, Select } from "../../../../components/inputs";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { useApiClient } from "../../../../context";
import { useApiMutation } from "../../../../hooks/useApiMutation";
import { formatMs } from "../../duration";
import {
  describeValue,
  draftOf,
  KEY_KIND,
  KEY_TEXT,
  numberBounds,
  planPatch,
  USE_CODE,
} from "./draft";
import { CODE_SOURCE_HINT, RESET_CANNOT_RESTORE } from "./text";

/** Props of {@link JobDefaultsDialog}. */
export interface JobDefaultsDialogProps {
  /** The queue. */
  queue: string;
  /** The defaults as read when the dialog opened: the form starts from them, and a save sends their `seq` as `expectedSeq`. */
  defaults: JobDefaultsDto;
  /** Asks to close. */
  onClose: () => void;
}

/** The codes a write answers when the stored defaults moved on since they were read. */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  "CONTROL_CONTENDED",
  "DEFAULTS_CHANGED",
]);

/** What saving or resetting says: the change reaches producers within `propagationMs`. */
function propagationNote(result: JobDefaultsDto): string {
  return `Producers pick this up within about ${formatMs(result.propagationMs)}.`;
}

/**
 * Edit a queue's job defaults: every key of `JOB_DEFAULT_KEYS`, bounded by
 * `JOB_DEFAULTS_BOUNDS`, each showing what a job gets now, what the code
 * asks for, and whether the stored override replaces it.
 *
 * A save sends a merge patch — only the changed keys, `null` for one set back
 * to the code's value — with `expectedSeq`, so it cannot silently overwrite a
 * change someone else made meanwhile: that answers 409, and the dialog asks
 * to re-read. Saving never touches jobs already pending; that is the separate
 * Apply to pending jobs… action.
 */
export function JobDefaultsDialog({
  queue,
  defaults: initial,
  onClose,
}: JobDefaultsDialogProps) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [defaults, setDefaults] = useState(initial);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<unknown>(null);
  const [rereading, setRereading] = useState(false);
  const resetNoteId = useId();

  const plan = planPatch(defaults, draft);
  const invalid = Object.keys(plan.errors).length > 0;

  const save = useApiMutation({
    mutationFn: () => setJobDefaults(api, queue, plan.body),
    invalidate: mutationInvalidations(queue),
    successMessage: (result) =>
      `Saved the job defaults of ${queue}. ${propagationNote(result)}`,
    toastErrors: false,
    onSuccess: onClose,
    onError: setError,
  });
  const reset = useApiMutation({
    mutationFn: () => resetJobDefaults(api, queue, defaults.seq),
    invalidate: mutationInvalidations(queue),
    successMessage: (result) =>
      `Reset the job defaults of ${queue} to the code values. ${propagationNote(result)}`,
    toastErrors: false,
    onSuccess: onClose,
    onError: setError,
  });
  const pending = save.isPending || reset.isPending || rereading;
  const conflict = isApiError(error) && CONFLICT_CODES.has(error.code);

  /** Reads the defaults again and starts the form over from them. */
  const reread = async () => {
    setRereading(true);
    try {
      const fresh = await getJobDefaults(api, queue);
      queryClient.setQueryData(jobDefaultsKey(queue), fresh);
      setDefaults(fresh);
      setDraft({});
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setRereading(false);
    }
  };

  /** Replaces one key's draft. */
  const edit = <K extends JobDefaultKey>(
    key: K,
    value: DraftOf<K> | typeof USE_CODE,
  ) => setDraft((current) => ({ ...current, [key]: value }));

  /** Forgets one key's edit, so it is left as it is. */
  const undo = (key: JobDefaultKey) =>
    setDraft((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

  /** The form value shown for a key: its edit, else what a job gets now. */
  const shown = <K extends JobDefaultKey>(key: K): DraftOf<K> => {
    const edited = draft[key];
    return edited !== undefined && edited !== USE_CODE
      ? (edited as DraftOf<K>)
      : draftOf(key, defaults.effective[key]);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      closeOnEscape={!pending}
      closeOnBackdrop={!pending}
      size="lg"
      title={`Job defaults of ${queue}`}
      description={
        <>
          What a job added to <code>{queue}</code> gets for an option its{" "}
          <code>add()</code> does not pass. A stored value here beats the
          code&rsquo;s defaults, <code>define()</code> defaults included; only
          an option passed explicitly on <code>add()</code> wins. Saving changes
          jobs added from now on; jobs already waiting keep their values unless
          you apply the defaults to them.
        </>
      }
      footer={
        <>
          <Button
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setError(null);
              save.mutate();
            }}
            disabled={pending || invalid || plan.changed.length === 0}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? "Saving…" : "Save defaults"}
          </Button>
        </>
      }
    >
      {error !== null &&
        (conflict ? (
          <div
            className="job-defaults-conflict"
            role="alert"
          >
            <p>
              The job defaults changed since you opened them — someone else
              saved or reset them. Nothing was saved. Re-read them, then make
              your change again.
            </p>
            <Button
              size="sm"
              onClick={() => void reread()}
              disabled={rereading}
              aria-busy={rereading || undefined}
            >
              {rereading ? "Re-reading…" : "Re-read the defaults"}
            </Button>
          </div>
        ) : (
          <ProblemBanner
            error={error}
            title="Could not save the job defaults"
          />
        ))}
      <p className="job-defaults-note muted">{CODE_SOURCE_HINT}</p>
      <div className="job-defaults-form">
        {JOB_DEFAULT_KEYS.map((key) => {
          const overridden = defaults.overridden.includes(key);
          const usesCode = draft[key] === USE_CODE;
          const code = describeValue(key, defaults.code[key]);
          const serverError =
            save.fieldErrors[key] ??
            Object.entries(save.fieldErrors).find(([path]) =>
              path.startsWith(`${key}.`),
            )?.[1];
          const error = plan.errors[key] ?? serverError;
          return (
            <fieldset
              key={key}
              className="job-defaults-row"
              data-testid={`job-default-${key}`}
            >
              <legend>
                {KEY_TEXT[key].label}{" "}
                {overridden && <Badge tone="accent">Overridden</Badge>}
              </legend>
              <p className="job-defaults-values muted">
                Now: {describeValue(key, defaults.effective[key])} · Code:{" "}
                {code}
              </p>
              {usesCode ? (
                <p className="job-defaults-uses-code">
                  Will use the code value ({code}) once saved.{" "}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => undo(key)}
                    disabled={pending}
                  >
                    Keep the stored value
                  </Button>
                </p>
              ) : (
                <KeyEditor
                  keyName={key}
                  value={shown(key)}
                  onChange={(value) => edit(key, value)}
                  error={error}
                />
              )}
              {overridden && !usesCode && (
                <Button
                  size="sm"
                  onClick={() => edit(key, USE_CODE)}
                  disabled={pending}
                >
                  Use code value
                </Button>
              )}
            </fieldset>
          );
        })}
      </div>
      {defaults.overridden.length > 0 && (
        <div className="job-defaults-reset">
          <Button
            variant="danger"
            onClick={() => {
              setError(null);
              reset.mutate();
            }}
            disabled={pending}
            aria-busy={reset.isPending || undefined}
            aria-describedby={resetNoteId}
          >
            {reset.isPending ? "Resetting…" : "Reset to code values"}
          </Button>
          <p
            id={resetNoteId}
            className="job-defaults-reset-note"
          >
            {RESET_CANNOT_RESTORE}
          </p>
        </div>
      )}
    </Dialog>
  );
}

/** Props of {@link KeyEditor}. */
interface KeyEditorProps {
  /** The key edited. */
  keyName: JobDefaultKey;
  /** Its form value. */
  value: DraftOf<JobDefaultKey>;
  /** Called with the new form value. */
  onChange: (value: DraftOf<JobDefaultKey>) => void;
  /** Why the value cannot be saved, if it cannot. */
  error: string | undefined;
}

/** The inputs of one key, by its kind. */
function KeyEditor({ keyName, value, onChange, error }: KeyEditorProps) {
  const kind = KEY_KIND[keyName];
  if (kind === "backoff") {
    return (
      <BackoffEditor
        value={value as BackoffDraft}
        onChange={onChange}
        error={error}
      />
    );
  }
  if (kind === "retention") {
    return (
      <RetentionEditor
        label={KEY_TEXT[keyName].label}
        hint={KEY_TEXT[keyName].hint}
        value={value as RetentionDraft}
        onChange={onChange}
        error={error}
      />
    );
  }
  const bounds = numberBounds(keyName as NumberKey);
  return (
    <Field
      label={KEY_TEXT[keyName].label}
      hint={`${KEY_TEXT[keyName].hint} ${bounds.min}–${bounds.max}.`}
      error={error}
    >
      <NumberInput
        value={value as number | undefined}
        min={bounds.min}
        max={bounds.max}
        onChange={onChange}
      />
    </Field>
  );
}

/** Props of {@link BackoffEditor}. */
interface BackoffEditorProps {
  /** The backoff as the form holds it. */
  value: BackoffDraft;
  /** Called with the new backoff. */
  onChange: (value: BackoffDraft) => void;
  /** Why it cannot be saved, if it cannot. */
  error: string | undefined;
}

/** Strategy, delay, longest delay and jitter. */
function BackoffEditor({ value, onChange, error }: BackoffEditorProps) {
  const delay = JOB_DEFAULTS_BOUNDS.backoffDelay;
  const max = JOB_DEFAULTS_BOUNDS.backoffMax;
  const jitter = JOB_DEFAULTS_BOUNDS.backoffJitter;
  return (
    <div className="field-row job-defaults-backoff">
      <Field
        label="Backoff strategy"
        hint="Fixed waits the delay every time; exponential doubles it after each attempt. Other strategies can be set only in code."
      >
        <Select
          options={JOB_DEFAULT_BACKOFF_TYPES.map((type) => ({ value: type }))}
          value={value.type}
          onChange={(type) => onChange({ ...value, type })}
        />
      </Field>
      <Field
        label="Backoff delay (ms)"
        hint={`${delay.min}–${delay.max}.`}
        error={error}
      >
        <NumberInput
          value={value.delay}
          min={delay.min}
          max={delay.max}
          onChange={(next) => onChange({ ...value, delay: next })}
        />
      </Field>
      <Field
        label="Backoff longest delay (ms)"
        hint={`Optional, at least the delay; empty means uncapped. Up to ${max.max}.`}
      >
        <NumberInput
          value={value.max}
          min={max.min}
          max={max.max}
          onChange={(next) => onChange({ ...value, max: next })}
        />
      </Field>
      <Field
        label="Backoff jitter"
        hint={`Optional fraction of each delay randomised, ${jitter.min}–${jitter.max}.`}
      >
        <NumberInput
          value={value.jitter}
          min={jitter.min}
          max={jitter.max}
          step="any"
          onChange={(next) => onChange({ ...value, jitter: next })}
        />
      </Field>
    </div>
  );
}

/** The retention modes, in the select's order. */
const RETENTION_OPTIONS: readonly { value: RetentionMode; label: string }[] = [
  { value: "keep", label: "Keep forever" },
  { value: "limit", label: "Keep the newest, or for a while" },
  { value: "remove", label: "Remove at once" },
];

/** Props of {@link RetentionEditor}. */
interface RetentionEditorProps {
  /** The key's label, e.g. "Completed jobs". */
  label: string;
  /** What it is. */
  hint: string;
  /** The retention as the form holds it. */
  value: RetentionDraft;
  /** Called with the new retention. */
  onChange: (value: RetentionDraft) => void;
  /** Why it cannot be saved, if it cannot. */
  error: string | undefined;
}

/** Keep forever, remove at once, or keep a count and/or an age. */
function RetentionEditor({
  label,
  hint,
  value,
  onChange,
  error,
}: RetentionEditorProps) {
  const count = JOB_DEFAULTS_BOUNDS.retentionCount;
  const ttl = JOB_DEFAULTS_BOUNDS.retentionTtl;
  return (
    <div className="field-row job-defaults-retention">
      <Field
        label={label}
        hint={
          value.mode === "remove"
            ? `${hint} Removing at once discards every result (or failure) as the job settles.`
            : hint
        }
        error={value.mode === "limit" ? undefined : error}
      >
        <Select
          options={RETENTION_OPTIONS}
          value={value.mode}
          onChange={(mode) => onChange({ ...value, mode })}
        />
      </Field>
      {value.mode === "limit" && (
        <>
          <Field
            label={`${label}: most kept`}
            hint={`Optional, ${count.min}–${count.max}.`}
            error={error}
          >
            <NumberInput
              value={value.count}
              min={count.min}
              max={count.max}
              onChange={(next) => onChange({ ...value, count: next })}
            />
          </Field>
          <Field
            label={`${label}: kept for (ms)`}
            hint={`Optional, up to ${ttl.max} (a year).`}
          >
            <NumberInput
              value={value.ttl}
              min={ttl.min}
              max={ttl.max}
              onChange={(next) => onChange({ ...value, ttl: next })}
            />
          </Field>
        </>
      )}
    </div>
  );
}
