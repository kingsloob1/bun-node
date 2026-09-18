import type { FormEvent } from "react";
import type { QueueLimitsBody, QueueLimitsDto } from "../../../api/types";
import type { LimitsDraftRow } from "./limitsDraft";
import { useState } from "react";
import { isApiError } from "../../../api/errors";
import { mutationInvalidations, setQueueLimits } from "../../../api/queues";
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Field } from "../../../components/Field";
import { NumberInput, TextInput } from "../../../components/inputs";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { useApiClient } from "../../../context";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { formatMs } from "../duration";
import { draftFromLimits, limitsBodyFromDraft } from "./limitsDraft";

/** Props of {@link LimitsPanel}. */
export interface LimitsPanelProps {
  /** The queue. */
  queue: string;
  /** Its stored limits (`null` for none). */
  limits: QueueLimitsDto | null;
  /** Whether the caller may change them (`queues.limits`, not read-only). */
  editable: boolean;
}

/** The queue's limits: a read-only summary, or an editor when permitted. */
export function LimitsPanel({ queue, limits, editable }: LimitsPanelProps) {
  if (!editable) {
    return <LimitsSummary limits={limits} />;
  }
  // Remounts when the stored limits change, so the form starts from them.
  return (
    <LimitsEditor
      key={JSON.stringify(limits)}
      queue={queue}
      limits={limits}
    />
  );
}

/** The stored limits as text. */
function LimitsSummary({ limits }: { limits: QueueLimitsDto | null }) {
  if (!limits || Object.keys(limits).length === 0) {
    return <p className="muted">No limits are set on this queue.</p>;
  }
  const describe = (row: {
    rate?: { max: number; duration: number };
    concurrency?: number;
  }) =>
    [
      row.rate && `${row.rate.max} per ${formatMs(row.rate.duration)}`,
      row.concurrency !== undefined && `${row.concurrency} at once`,
    ]
      .filter(Boolean)
      .join(", ") || "none";
  return (
    <dl className="limits-summary">
      <dt>Queue</dt>
      <dd>{describe(limits)}</dd>
      {Object.entries(limits.names ?? {}).map(([name, row]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{describe(row)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Props of {@link LimitsRowFields}. */
interface LimitsRowFieldsProps {
  /** The row. */
  row: LimitsDraftRow;
  /** Replaces the row. */
  onChange: (row: LimitsDraftRow) => void;
  /** The field-error key prefix, e.g. `""` or `"names.email."`. */
  prefix: string;
  /** Field errors from the last save. */
  errors: Record<string, string>;
  /** Label prefix, e.g. "Queue" or the job name. */
  label: string;
}

/** Rate max, rate window and concurrency inputs for one row. */
function LimitsRowFields({
  row,
  onChange,
  prefix,
  errors,
  label,
}: LimitsRowFieldsProps) {
  const error = (key: string) => errors[`${prefix}${key}`];
  return (
    <div className="field-row limits-row">
      <Field
        label={`${label}: rate max`}
        error={error("rate.max") ?? error("rate")}
      >
        <NumberInput
          value={row.rateMax}
          onChange={(rateMax) => onChange({ ...row, rateMax })}
          min={1}
        />
      </Field>
      <Field
        label={`${label}: rate window`}
        hint="ms, or e.g. “1 minute”"
        error={error("rate.duration")}
      >
        <TextInput
          value={row.rateDuration}
          onChange={(rateDuration) => onChange({ ...row, rateDuration })}
          maxLength={100}
        />
      </Field>
      <Field
        label={`${label}: concurrency`}
        error={error("concurrency")}
      >
        <NumberInput
          value={row.concurrency}
          onChange={(concurrency) => onChange({ ...row, concurrency })}
          min={1}
        />
      </Field>
    </div>
  );
}

/** The editor: `PUT` the form, or `PUT null` to remove every limit. */
function LimitsEditor({
  queue,
  limits,
}: {
  queue: string;
  limits: QueueLimitsDto | null;
}) {
  const api = useApiClient();
  const [draft, setDraft] = useState(() => draftFromLimits(limits));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useApiMutation({
    mutationFn: (body: QueueLimitsBody | null) =>
      setQueueLimits(api, queue, body),
    successMessage: (_result, body) =>
      body === null
        ? `Removed the limits of ${queue}`
        : `Saved the limits of ${queue}`,
    invalidate: mutationInvalidations(queue),
    toastErrors: false,
  });
  const submit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    save.mutate(limitsBodyFromDraft(draft));
  };
  const contended =
    isApiError(save.error) && save.error.code === "LIMITS_CONTENDED";
  const bannerError =
    save.error && Object.keys(save.fieldErrors).length === 0
      ? save.error
      : null;
  const nextKey = draft.names.reduce(
    (max, row) => Math.max(max, row.key + 1),
    0,
  );

  return (
    <>
      <form
        className="limits-editor"
        aria-label="Queue limits"
        onSubmit={submit}
      >
        <LimitsRowFields
          row={draft.queue}
          onChange={(row) => setDraft({ ...draft, queue: row })}
          prefix=""
          errors={save.fieldErrors}
          label="Queue"
        />
        <fieldset className="limits-names">
          <legend>Per-name limits</legend>
          {draft.names.length === 0 && <p className="muted">None.</p>}
          {draft.names.map((row, index) => (
            <div
              key={row.key}
              className="limits-name"
            >
              <Field label={`Name ${index + 1}`}>
                <TextInput
                  value={row.name}
                  onChange={(name) =>
                    setDraft({
                      ...draft,
                      names: draft.names.map((item) =>
                        item.key === row.key ? { ...item, name } : item,
                      ),
                    })
                  }
                  maxLength={200}
                />
              </Field>
              <LimitsRowFields
                row={row}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    names: draft.names.map((item) =>
                      item.key === row.key ? { ...item, ...next } : item,
                    ),
                  })
                }
                prefix={`names.${row.name.trim()}.`}
                errors={save.fieldErrors}
                label={row.name.trim() || `Name ${index + 1}`}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDraft({
                    ...draft,
                    names: draft.names.filter((item) => item.key !== row.key),
                  })
                }
              >
                Remove {row.name.trim() || `name ${index + 1}`}
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            onClick={() =>
              setDraft({
                ...draft,
                names: [
                  ...draft.names,
                  {
                    key: nextKey,
                    name: "",
                    rateMax: undefined,
                    rateDuration: "",
                    concurrency: undefined,
                  },
                ],
              })
            }
          >
            Add a name
          </Button>
        </fieldset>
        {bannerError !== null && (
          <ProblemBanner
            error={bannerError}
            title={
              contended
                ? "The limits changed while saving. Retry to save again."
                : "Could not save the limits"
            }
            onRetry={contended ? () => submit() : undefined}
          />
        )}
        <div className="form-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={save.isPending}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? "Saving…" : "Save limits"}
          </Button>
          {limits !== null && (
            <Button
              variant="danger"
              onClick={() => setConfirmRemove(true)}
              disabled={save.isPending}
            >
              Remove all limits…
            </Button>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove every limit on ${queue}?`}
        description="Workers stop rate-limiting and capping this queue once they refresh their limits."
        variant="danger"
        confirmLabel="Remove limits"
        onConfirm={() => save.mutateAsync(null)}
      />
    </>
  );
}
