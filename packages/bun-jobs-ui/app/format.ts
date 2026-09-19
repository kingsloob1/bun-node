import type { JobState } from "./api/contract";

/** One shared integer formatter in the browser's locale. */
const integerFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

/** Formats a count, e.g. `12,345`. */
export function formatNumber(value: number): string {
  return integerFormat.format(value);
}

/** Display labels of the job states. */
export const STATE_LABELS: Readonly<Record<JobState, string>> = {
  waiting: "Waiting",
  delayed: "Delayed",
  active: "Active",
  completed: "Completed",
  failed: "Failed",
  dead: "Dead",
  "waiting-children": "Waiting children",
};

/** `1 queue`, `2 queues`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** What {@link displayText} shows for a value that is not text. */
export const INVALID_TEXT = "(invalid)";

/**
 * A field the API types as a string, made safe to render as text: a string
 * as-is, a number or boolean stringified, anything else (an object, which
 * React would refuse to render as a child, `null`, `undefined`)
 * {@link INVALID_TEXT}. For names drawn from list responses the app does
 * not shape-check.
 */
export function displayText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return INVALID_TEXT;
}
