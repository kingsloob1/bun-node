import type { JobState, UpdateJobBody } from "../../api/types";
import type { JsonEditorState } from "../../components/jsonParse";

/** What the form holds. */
export interface UpdateJobForm {
  /** Whether the data is being replaced. */
  changeData: boolean;
  /** The data editor's state. */
  data: JsonEditorState;
  /** The new priority, or `undefined` to keep it. */
  priority: number | undefined;
  /** The new run time (epoch ms), or `undefined` to keep it. */
  runAt: number | undefined;
  /** Whether the change is conditional on the job's state. */
  conditional: boolean;
  /** The states it is conditional on. */
  onlyIn: JobState[];
}

/** Client-side problems with an {@link UpdateJobForm}, keyed like the API's field errors. */
export type UpdateJobErrors = Partial<
  Record<"form" | "data" | "priority" | "runAt" | "onlyIn", string>
>;

/**
 * Checks the form the way the API would, so the common mistakes never make a
 * round trip: at least one of data, priority or run time, valid JSON within
 * the size limit, a finite priority, and at least one state when the change
 * is conditional.
 */
export function validateUpdateForm(form: UpdateJobForm): UpdateJobErrors {
  const errors: UpdateJobErrors = {};
  if (
    !form.changeData &&
    form.priority === undefined &&
    form.runAt === undefined
  ) {
    errors.form = "Change at least one of data, priority or run time.";
  }
  if (form.changeData) {
    if (form.data.error) {
      errors.data = "The data is not valid JSON.";
    } else if (form.data.overLimit) {
      errors.data = "The data is larger than the API accepts.";
    } else if (form.data.value === undefined) {
      errors.data = "Enter the new data as JSON (null is allowed).";
    }
  }
  if (form.priority !== undefined && !Number.isFinite(form.priority)) {
    errors.priority = "Enter a number.";
  }
  if (form.conditional && form.onlyIn.length === 0) {
    errors.onlyIn = "Pick at least one state, or untick the condition.";
  }
  return errors;
}

/** The request body for a valid {@link UpdateJobForm}. */
export function updateBody(form: UpdateJobForm): UpdateJobBody {
  return {
    ...(form.changeData ? { data: form.data.value } : {}),
    ...(form.priority === undefined ? {} : { priority: form.priority }),
    ...(form.runAt === undefined ? {} : { runAt: form.runAt }),
    ...(form.conditional ? { onlyIn: form.onlyIn } : {}),
  };
}
