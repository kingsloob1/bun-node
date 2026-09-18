import type { AddJobBody, AddJobOptions } from "../../api/types";
import type { JsonEditorState } from "../../components/jsonParse";
import { MAX_JOB_ID_LENGTH } from "@kingsleyweb/bun-jobs/api/contract";

/** The add-job form's shape, its client-side checks, and its request body. */

/** When the job may first run. */
export type AddJobTiming = "now" | "delay" | "runAt";

/** What the add form holds. */
export interface AddJobForm {
  /** The job name. */
  name: string;
  /** The payload editor's state. */
  data: JsonEditorState;
  /** A caller-chosen id; `""` lets the queue mint one. */
  jobId: string;
  /** Priority; `undefined` for the default. */
  priority: number | undefined;
  /** Run now, after a delay, or at a time: `delay` and `runAt` are exclusive. */
  timing: AddJobTiming;
  /** The delay in ms, with `timing: "delay"`. */
  delay: number | undefined;
  /** The run time (epoch ms), with `timing: "runAt"`. */
  runAt: number | undefined;
  /** Attempts allowed in total; `undefined` for the default. */
  attempts: number | undefined;
  /** Fixed delay between attempts, ms; `undefined` for the default. */
  backoff: number | undefined;
  /** Processor timeout, ms; `undefined` for the default. */
  timeout: number | undefined;
}

/** A field of {@link AddJobForm} that can carry an error, keyed as the API's field errors are. */
export type AddJobField =
  | "name"
  | "data"
  | "opts.jobId"
  | "opts.priority"
  | "opts.delay"
  | "opts.runAt"
  | "opts.attempts"
  | "opts.backoff"
  | "opts.timeout";

/** Client-side problems, per field. */
export type AddJobErrors = Partial<Record<AddJobField, string>>;

/** An integer at least `min`, or `undefined` (left out). */
function checkInteger(
  value: number | undefined,
  min: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    return "Enter a whole number.";
  }
  return value < min ? `Enter ${min} or more.` : undefined;
}

/** Why a caller-chosen job id would be refused, or `undefined`. */
export function checkJobId(jobId: string): string | undefined {
  if (jobId === "") {
    return undefined;
  }
  if (jobId.length > MAX_JOB_ID_LENGTH) {
    return `At most ${MAX_JOB_ID_LENGTH} characters (this one has ${jobId.length}).`;
  }
  if (jobId.startsWith(".")) {
    return "An id cannot start with a dot.";
  }
  // Control characters are refused by bun-jobs' `assertJobId`.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(jobId)) {
    return "An id cannot contain control characters.";
  }
  return undefined;
}

/** Checks the form the way the API would. */
export function validateAddForm(form: AddJobForm): AddJobErrors {
  const errors: AddJobErrors = {};
  if (form.name.trim() === "") {
    errors.name = "Pick or enter a job name.";
  } else if (form.name.length > 200) {
    errors.name = "At most 200 characters.";
  }
  if (form.data.error) {
    errors.data = "The data is not valid JSON.";
  } else if (form.data.overLimit) {
    errors.data = "The data is larger than the API accepts.";
  } else if (form.data.value === undefined) {
    errors.data = "Enter the data as JSON (null is allowed).";
  }
  const jobId = checkJobId(form.jobId);
  if (jobId) {
    errors["opts.jobId"] = jobId;
  }
  if (form.priority !== undefined && !Number.isFinite(form.priority)) {
    errors["opts.priority"] = "Enter a number.";
  }
  if (form.timing === "delay") {
    errors["opts.delay"] =
      form.delay === undefined
        ? "Enter the delay in milliseconds."
        : checkInteger(form.delay, 0);
  }
  if (form.timing === "runAt" && form.runAt === undefined) {
    errors["opts.runAt"] = "Pick when it should run.";
  }
  errors["opts.attempts"] = checkInteger(form.attempts, 1);
  errors["opts.backoff"] = checkInteger(form.backoff, 0);
  errors["opts.timeout"] = checkInteger(form.timeout, 0);
  for (const key of Object.keys(errors) as AddJobField[]) {
    if (errors[key] === undefined) {
      delete errors[key];
    }
  }
  return errors;
}

/** The request body for a valid {@link AddJobForm}; empty options are left out. */
export function addBody(form: AddJobForm): AddJobBody {
  const opts: AddJobOptions = {
    ...(form.jobId === "" ? {} : { jobId: form.jobId }),
    ...(form.priority === undefined ? {} : { priority: form.priority }),
    ...(form.timing === "delay" && form.delay !== undefined
      ? { delay: form.delay }
      : {}),
    ...(form.timing === "runAt" && form.runAt !== undefined
      ? { runAt: form.runAt }
      : {}),
    ...(form.attempts === undefined ? {} : { attempts: form.attempts }),
    ...(form.backoff === undefined ? {} : { backoff: form.backoff }),
    ...(form.timeout === undefined ? {} : { timeout: form.timeout }),
  };
  return {
    name: form.name.trim(),
    data: form.data.value,
    ...(Object.keys(opts).length > 0 ? { opts } : {}),
  };
}
