import type { JsonEditorState } from "../../../../kit/components/jsonParse";
import { ApiError, isApiError } from "../../../api/errors";

/**
 * A failed change to one repeat series (disable, enable, edit), with a 404
 * `REPEATABLE_NOT_FOUND` explained in plain words. Anything else is returned
 * unchanged.
 */
export function explainSeriesError(error: unknown, key: string): unknown {
  if (!isApiError(error) || error.code !== "REPEATABLE_NOT_FOUND") {
    return error;
  }
  return new ApiError({
    kind: error.kind,
    status: error.status,
    code: error.code,
    title: error.title,
    detail: `The repeat series “${key}” no longer exists: somebody removed it, or it ended. Refresh to see the series there are now.`,
    type: error.type,
    issues: error.issues,
    context: error.context,
    instance: error.instance,
    cause: error,
  });
}

/**
 * What is wrong with the edited data before it is sent, or `undefined`: valid
 * JSON within the API's size limit. `null` is a payload like any other.
 */
export function repeatableDataProblem(
  data: JsonEditorState,
): string | undefined {
  if (data.error) {
    return "The data is not valid JSON.";
  }
  if (data.overLimit) {
    return "The data is larger than the API accepts.";
  }
  if (data.value === undefined) {
    return "Enter the new data as JSON (null is allowed).";
  }
  return undefined;
}
