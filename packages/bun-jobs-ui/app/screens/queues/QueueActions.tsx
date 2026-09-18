import type { CleanQueueBody, RetryAllBody } from "../../api/types";
import type { DurationUnit } from "./duration";
import { useState } from "react";
import { isApiError } from "../../api/errors";
import {
  cleanQueue,
  drainQueue,
  mutationInvalidations,
  pauseQueue,
  resumeQueue,
  retryAllJobs,
} from "../../api/queues";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Field } from "../../components/Field";
import {
  Checkbox,
  NumberInput,
  Select,
  TextInput,
} from "../../components/inputs";
import { useToast } from "../../components/toast";
import { useApiClient } from "../../context";
import { formatNumber, plural, STATE_LABELS } from "../../format";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useMeta } from "../../meta/hooks";
import { toMs } from "./duration";
import { useCanMutate } from "./gating";
import { listIds } from "./queueFormat";

/** The states `clean` accepts. */
const CLEAN_STATES: readonly CleanQueueBody["state"][] = [
  "completed",
  "failed",
  "dead",
  "waiting",
  "delayed",
  "waiting-children",
];

/** The states `retry-all` accepts. */
const RETRY_ALL_STATES: readonly RetryAllBody["state"][] = [
  "failed",
  "dead",
  "completed",
];

/** Units offered for the clean age. */
const UNIT_OPTIONS: readonly { value: DurationUnit; label: string }[] = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

/** Which dialog is open. */
type OpenDialog = "drain" | "clean" | "retryAll" | null;

/** Props of {@link QueueActions}. */
export interface QueueActionsProps {
  /** The queue acted on. */
  queue: string;
  /** Whether it is paused (picks Pause or Resume); `undefined` while unknown. */
  paused: boolean | undefined;
}

/**
 * The queue-wide actions: pause/resume, drain, clean and retry-all, each
 * present only when permitted and the API is not read-only. The destructive
 * ones confirm by typing the queue name.
 */
export function QueueActions({ queue, paused }: QueueActionsProps) {
  const api = useApiClient();
  const canMutate = useCanMutate();
  const [open, setOpen] = useState<OpenDialog>(null);
  const close = () => setOpen(null);
  const invalidate = mutationInvalidations(queue);

  const pause = useApiMutation({
    mutationFn: () => pauseQueue(api, queue),
    successMessage: `Paused ${queue}`,
    errorTitle: `Could not pause ${queue}`,
    invalidate,
  });
  const resume = useApiMutation({
    mutationFn: () => resumeQueue(api, queue),
    successMessage: `Resumed ${queue}`,
    errorTitle: `Could not resume ${queue}`,
    invalidate,
  });

  const showPause = paused === false && canMutate("queues.pause");
  const showResume = paused === true && canMutate("queues.resume");
  const showDrain = canMutate("queues.drain");
  const showClean = canMutate("queues.clean");
  const showRetryAll = canMutate("jobs.retryAll");
  if (!showPause && !showResume && !showDrain && !showClean && !showRetryAll) {
    return null;
  }

  return (
    <div
      className="queue-actions"
      role="group"
      aria-label="Queue actions"
    >
      {showPause && (
        <Button
          onClick={() => pause.mutate()}
          disabled={pause.isPending}
          aria-busy={pause.isPending || undefined}
        >
          Pause
        </Button>
      )}
      {showResume && (
        <Button
          variant="primary"
          onClick={() => resume.mutate()}
          disabled={resume.isPending}
          aria-busy={resume.isPending || undefined}
        >
          Resume
        </Button>
      )}
      {showRetryAll && (
        <Button onClick={() => setOpen("retryAll")}>Retry all…</Button>
      )}
      {showClean && (
        <Button
          variant="danger"
          onClick={() => setOpen("clean")}
        >
          Clean…
        </Button>
      )}
      {showDrain && (
        <Button
          variant="danger"
          onClick={() => setOpen("drain")}
        >
          Drain…
        </Button>
      )}
      {open === "drain" && (
        <DrainDialog
          queue={queue}
          onClose={close}
        />
      )}
      {open === "clean" && (
        <CleanDialog
          queue={queue}
          onClose={close}
        />
      )}
      {open === "retryAll" && (
        <RetryAllDialog
          queue={queue}
          onClose={close}
        />
      )}
    </div>
  );
}

/** Props of one action dialog. */
interface ActionDialogProps {
  /** The queue acted on. */
  queue: string;
  /** Closes the dialog. */
  onClose: () => void;
}

/** `POST /queues/:queue/drain`, with the `delayed` option. */
function DrainDialog({ queue, onClose }: ActionDialogProps) {
  const api = useApiClient();
  const [delayed, setDelayed] = useState(false);
  const drain = useApiMutation({
    mutationFn: (withDelayed: boolean) => drainQueue(api, queue, withDelayed),
    successMessage: (result) =>
      `Drained ${plural(result.count, "job")} from ${queue}`,
    invalidate: mutationInvalidations(queue),
    toastErrors: false,
  });
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Drain ${queue}?`}
      description="Removes every waiting job (and, if chosen, every delayed one). Running jobs are not touched. This cannot be undone."
      variant="danger"
      confirmLabel="Drain"
      pendingLabel="Draining…"
      confirmText={queue}
      onConfirm={() => drain.mutateAsync(delayed)}
    >
      <Checkbox
        checked={delayed}
        onChange={setDelayed}
        label="Also remove delayed jobs"
      />
    </ConfirmDialog>
  );
}

/** `POST /queues/:queue/clean`: a state, an age and a limit. */
function CleanDialog({ queue, onClose }: ActionDialogProps) {
  const api = useApiClient();
  const { limits } = useMeta();
  const toast = useToast();
  const [state, setState] = useState<CleanQueueBody["state"]>("completed");
  const [age, setAge] = useState<number | undefined>(1);
  const [unit, setUnit] = useState<DurationUnit>("days");
  const [limit, setLimit] = useState<number | undefined>(
    Math.min(1000, limits.maxClean),
  );
  const clean = useApiMutation({
    mutationFn: (body: CleanQueueBody) => cleanQueue(api, queue, body),
    onSuccess: (result) => {
      toast.success(`Cleaned ${plural(result.count, "job")} from ${queue}`, {
        description:
          result.ids.length > 0 ? `Removed: ${listIds(result.ids)}` : undefined,
      });
    },
    invalidate: mutationInvalidations(queue),
    toastErrors: false,
  });
  const olderThan = toMs(age, unit);
  const limitValid =
    limit !== undefined &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= limits.maxClean;
  const fieldError = (key: string) => clean.fieldErrors[key];
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Clean ${queue}?`}
      description="Removes jobs in one state that are older than the age you give, up to the limit. This cannot be undone."
      variant="danger"
      confirmLabel="Clean"
      pendingLabel="Cleaning…"
      confirmText={queue}
      confirmDisabled={olderThan === undefined || !limitValid}
      onConfirm={() =>
        clean.mutateAsync({ state, olderThan: olderThan ?? 0, limit })
      }
    >
      <Field
        label="State"
        error={fieldError("state")}
      >
        <Select
          options={CLEAN_STATES.map((value) => ({
            value,
            label: STATE_LABELS[value],
          }))}
          value={state}
          onChange={setState}
        />
      </Field>
      <div className="field-row">
        <Field
          label="Older than"
          error={fieldError("olderThan")}
          required
        >
          <NumberInput
            value={age}
            onChange={setAge}
            min={0}
            step="any"
          />
        </Field>
        <Field label="Unit">
          <Select
            options={UNIT_OPTIONS}
            value={unit}
            onChange={setUnit}
          />
        </Field>
      </div>
      <Field
        label="Limit"
        hint={`At most ${formatNumber(limits.maxClean)}.`}
        error={
          fieldError("limit") ??
          (limitValid
            ? undefined
            : `Between 1 and ${formatNumber(limits.maxClean)}.`)
        }
      >
        <NumberInput
          value={limit}
          onChange={setLimit}
          min={1}
          max={limits.maxClean}
        />
      </Field>
    </ConfirmDialog>
  );
}

/** `POST /queues/:queue/jobs/retry-all`: synchronous, so the dialog stays pending until it answers. */
function RetryAllDialog({ queue, onClose }: ActionDialogProps) {
  const api = useApiClient();
  const { limits } = useMeta();
  const toast = useToast();
  const [state, setState] = useState<RetryAllBody["state"]>("failed");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [limit, setLimit] = useState<number | undefined>(limits.maxRetryAll);
  const [resetAttempts, setResetAttempts] = useState(true);
  const retryAll = useApiMutation({
    mutationFn: (body: RetryAllBody) => retryAllJobs(api, queue, body),
    onSuccess: (result) => {
      toast.success(`Retried ${plural(result.count, "job")} in ${queue}`, {
        description:
          result.ids.length === 0
            ? undefined
            : `${listIds(result.ids)}${result.truncated ? " (the list of ids is truncated)" : ""}`,
      });
    },
    invalidate: mutationInvalidations(queue),
    toastErrors: false,
  });
  const limitValid =
    limit !== undefined &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= limits.maxRetryAll;
  const inProgress =
    isApiError(retryAll.error) &&
    retryAll.error.code === "OPERATION_IN_PROGRESS";
  const fieldError = (key: string) => retryAll.fieldErrors[key];
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Retry every ${STATE_LABELS[state].toLowerCase()} job in ${queue}?`}
      description="Moves matching jobs back to waiting. It runs to completion before answering, which can take a while on a large queue."
      confirmLabel="Retry all"
      pendingLabel="Retrying… this can take a while"
      confirmText={queue}
      confirmDisabled={!limitValid}
      onConfirm={() =>
        retryAll.mutateAsync({
          state,
          name: name.trim() || undefined,
          reason: reason.trim() || undefined,
          limit,
          resetAttempts,
        })
      }
    >
      <Field
        label="State"
        error={fieldError("state")}
      >
        <Select
          options={RETRY_ALL_STATES.map((value) => ({
            value,
            label: STATE_LABELS[value],
          }))}
          value={state}
          onChange={setState}
        />
      </Field>
      <Field
        label="Job name"
        hint="Optional: only jobs with exactly this name."
        error={fieldError("name")}
      >
        <TextInput
          value={name}
          onChange={setName}
          maxLength={200}
        />
      </Field>
      <Field
        label="Failure reason contains"
        hint="Optional: a plain substring of “ErrorName: message”."
        error={fieldError("reason")}
      >
        <TextInput
          value={reason}
          onChange={setReason}
          maxLength={500}
        />
      </Field>
      <Field
        label="Limit"
        hint={`At most ${formatNumber(limits.maxRetryAll)}.`}
        error={
          fieldError("limit") ??
          (limitValid
            ? undefined
            : `Between 1 and ${formatNumber(limits.maxRetryAll)}.`)
        }
      >
        <NumberInput
          value={limit}
          onChange={setLimit}
          min={1}
          max={limits.maxRetryAll}
        />
      </Field>
      <Checkbox
        checked={resetAttempts}
        onChange={setResetAttempts}
        label="Reset attempts"
      />
      {inProgress && (
        <p
          className="notice"
          role="note"
          data-testid="retry-all-in-progress"
        >
          A retry-all is already running on this queue. Only one runs per queue
          at a time; wait for it to finish, then try again.
        </p>
      )}
    </ConfirmDialog>
  );
}
