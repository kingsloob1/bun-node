import type { JobState } from "./contract";
import { JOB_STATES } from "./contract";
import { ApiError } from "./errors";

/**
 * Minimal response-shape guards for the detail reads a screen renders
 * straight into its heading. They are not a schema: each checks only the few
 * fields the screen cannot draw without, so a host answering `{}`, `[]` or a
 * string (a misrouted proxy, a stub, a bug) gets the screen's error state
 * instead of an empty screen or a render crash.
 */

/** A record's fields, for a shape check. */
export type ShapeFields = Readonly<Record<string, unknown>>;

/** Whether a value is a plain JSON object (not an array, not `null`). */
function isRecord(value: unknown): value is ShapeFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns `value` as `T` when it is a JSON object passing `check`; otherwise
 * throws an {@link ApiError} of kind `parse`, code `UNEXPECTED_RESPONSE`, so
 * the screen shows its error view (with Retry). `what` names the expected
 * thing ("a job"), `path` the API path read. Guarded reads are `GET`s the API
 * answers `200`, which is the status the error carries.
 */
export function assertShape<T>(
  value: unknown,
  check: (fields: ShapeFields) => boolean,
  what: string,
  path: string,
): T {
  if (isRecord(value) && check(value)) {
    return value as T;
  }
  throw new ApiError({
    kind: "parse",
    status: 200,
    code: "UNEXPECTED_RESPONSE",
    title: "The API answered an unexpected response",
    detail: `Expected ${what}, got ${describe(value)}.`,
    instance: path,
  });
}

/** A short description of what arrived instead. */
function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return "an array";
  }
  if (value === null) {
    return "null";
  }
  if (isRecord(value)) {
    return "an object without the expected fields";
  }
  return `a ${typeof value}`;
}

/** Whether every named field is a string. */
export function hasStrings(
  fields: ShapeFields,
  ...names: readonly string[]
): boolean {
  return names.every((name) => typeof fields[name] === "string");
}

/** Whether a value is one of the {@link JOB_STATES}. */
export function isJobState(value: unknown): value is JobState {
  return (JOB_STATES as readonly unknown[]).includes(value);
}
