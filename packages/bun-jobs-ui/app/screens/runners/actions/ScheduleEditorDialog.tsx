import type { FormEvent } from "react";
import type { ScheduleRunnerBody } from "../../../api/types";
import type {
  IntervalUnit,
  ScheduleErrors,
  ScheduleField,
  ScheduleForm,
  ScheduleMode,
} from "./schedule";
import type { RunnerDialogProps } from "./TriggerDialog";
import { useId, useMemo, useState } from "react";
import { isApiError } from "../../../api/errors";
import { rescheduleRunner } from "../../../api/runnerActions";
import { runnerInvalidations } from "../../../api/runners";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import {
  DateTimeInput,
  NumberInput,
  Select,
  TextInput,
} from "../../../components/inputs";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { RelativeTime } from "../../../components/RelativeTime";
import { useToast } from "../../../components/toast";
import { useApiClient } from "../../../context";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { useNow } from "../../../hooks/useNow";
import { explained } from "./explain";
import {
  formFromSchedule,
  invalidScheduleField,
  MAX_CRON_LENGTH,
  MAX_TZ_LENGTH,
  scheduleBody,
  scheduleFieldErrors,
  supportedTimeZones,
  validateScheduleForm,
} from "./schedule";

/** The modes, as the radio group offers them. */
const MODES: readonly { value: ScheduleMode; label: string }[] = [
  { value: "cron", label: "Cron" },
  { value: "every", label: "Every" },
  { value: "at", label: "Once" },
  { value: "none", label: "None" },
];

/** Units of the interval. */
const UNITS: readonly { value: IntervalUnit; label: string }[] = [
  { value: "seconds", label: "seconds" },
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
];

/**
 * `PUT /runners/:runner/schedule`: a cron expression (+ time zone), an
 * interval (+ anchor), a one-off time, or none (manual only). Prefilled from
 * the stored schedule; the success toast shows when it next fires, from the
 * response.
 */
export function ScheduleEditorDialog({ runner, onClose }: RunnerDialogProps) {
  const api = useApiClient();
  const toast = useToast();
  const formId = useId();
  const zonesId = useId();
  const zones = useMemo(() => supportedTimeZones(), []);
  const now = useNow();
  const [form, setForm] = useState<ScheduleForm>(() =>
    formFromSchedule(runner.schedule),
  );
  const [submitted, setSubmitted] = useState(false);
  const patch = (next: Partial<ScheduleForm>) =>
    setForm((current) => ({ ...current, ...next }));

  const save = useApiMutation({
    mutationFn: (schedule: ScheduleRunnerBody["schedule"]) =>
      rescheduleRunner(api, runner.id, schedule),
    onSuccess: (result) => {
      toast.success(
        result.schedule === null
          ? `${runner.id} is unscheduled`
          : `Rescheduled ${runner.id}`,
        {
          description:
            result.nextRunAt === null ? (
              "No run is scheduled; it runs only when triggered."
            ) : (
              <span data-testid="schedule-next-run">
                Next run <RelativeTime value={result.nextRunAt} />
              </span>
            ),
        },
      );
      onClose();
    },
    invalidate: runnerInvalidations(runner.id),
    toastErrors: false,
  });

  const clientErrors: ScheduleErrors = submitted
    ? validateScheduleForm(form, zones)
    : {};
  const server = scheduleFieldErrors(save.fieldErrors, form.mode);
  const apiError = isApiError(save.error) ? save.error : null;
  const invalidField =
    apiError?.code === "INVALID_SCHEDULE"
      ? invalidScheduleField(form.mode, apiError.detail)
      : null;
  const fieldError = (field: ScheduleField): string | undefined =>
    clientErrors[field] ??
    server.fields[field] ??
    (invalidField === field
      ? (apiError?.detail ?? apiError?.title)
      : undefined);
  const hasServerFieldError =
    Object.keys(server.fields).length > 0 || invalidField !== null;
  const bannerError =
    save.error && !hasServerFieldError
      ? (server.other ?? explained(save.error, "reschedule"))
      : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(validateScheduleForm(form, zones)).length > 0) {
      return;
    }
    save.mutate(scheduleBody(form));
  };

  const close = () => {
    if (!save.isPending) {
      onClose();
    }
  };

  const atInPast = form.at !== undefined && form.at <= now;

  return (
    <Dialog
      open
      onClose={close}
      title={
        <>
          Reschedule <code>{runner.id}</code>
        </>
      }
      description="Replaces the stored schedule for every process running this runner."
      size="md"
      closeOnEscape={!save.isPending}
      closeOnBackdrop={!save.isPending}
      footer={
        <>
          <Button
            onClick={close}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={save.isPending}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? "Saving…" : "Save schedule"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="runner-form"
        onSubmit={onSubmit}
        noValidate
      >
        <fieldset className="schedule-modes">
          <legend>Schedule</legend>
          {MODES.map((mode) => (
            <label
              key={mode.value}
              className="schedule-mode"
            >
              <input
                type="radio"
                name={`${formId}-mode`}
                value={mode.value}
                checked={form.mode === mode.value}
                onChange={() => patch({ mode: mode.value })}
              />
              {mode.label}
            </label>
          ))}
        </fieldset>

        {form.mode === "cron" && (
          <>
            <Field
              label="Cron expression"
              required
              hint="5 fields (minute hour day month weekday), 6 with seconds first, or a nickname such as @daily."
              error={fieldError("cron")}
            >
              <TextInput
                value={form.cron}
                onChange={(cron) => patch({ cron })}
                maxLength={MAX_CRON_LENGTH}
                autoComplete="off"
                spellCheck={false}
                placeholder="0 9 * * MON-FRI"
              />
            </Field>
            <Field
              label="Time zone"
              hint="Optional IANA name, e.g. Europe/London. Empty: the owner's local time (the zone of the process that runs it)."
              error={fieldError("tz")}
            >
              <TextInput
                value={form.tz}
                onChange={(tz) => patch({ tz })}
                maxLength={MAX_TZ_LENGTH}
                autoComplete="off"
                spellCheck={false}
                list={zones ? zonesId : undefined}
              />
            </Field>
            {zones && (
              <datalist id={zonesId}>
                {zones.map((zone) => (
                  <option
                    key={zone}
                    value={zone}
                  />
                ))}
              </datalist>
            )}
          </>
        )}

        {form.mode === "every" && (
          <>
            <div className="runner-form-row">
              <Field
                label="Interval"
                required
                error={fieldError("every")}
              >
                <NumberInput
                  value={form.everyAmount}
                  onChange={(everyAmount) => patch({ everyAmount })}
                  min={0}
                  step="any"
                />
              </Field>
              <Field label="Unit">
                <Select
                  options={UNITS}
                  value={form.everyUnit}
                  onChange={(everyUnit) => patch({ everyUnit })}
                />
              </Field>
            </div>
            <Field
              label="Anchor"
              hint="Optional: runs stay on this time's grid. Without one, each interval counts from when the schedule is applied."
              error={fieldError("anchor")}
            >
              <DateTimeInput
                value={form.anchor}
                onChange={(anchor) => patch({ anchor })}
                withSeconds
              />
            </Field>
          </>
        )}

        {form.mode === "at" && (
          <Field
            label="Run at"
            required
            hint={
              atInPast
                ? "This time has passed: the runner will not fire."
                : "One run at this time, then none."
            }
            error={fieldError("at")}
          >
            <DateTimeInput
              value={form.at}
              onChange={(at) => patch({ at })}
              withSeconds
            />
          </Field>
        )}

        {form.mode === "none" && (
          <p
            className="runner-note"
            role="note"
          >
            No schedule: the runner runs only when triggered.
          </p>
        )}

        {bannerError !== null && <ProblemBanner error={bannerError} />}
      </form>
    </Dialog>
  );
}
