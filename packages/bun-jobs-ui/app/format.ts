import type { JobState } from "./api/contract";

/** One shared integer formatter in the browser's locale. */
const integerFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

/** Formats a count, e.g. `12,345`. */
export function formatNumber(value: number): string {
  return integerFormat.format(value);
}

/**
 * The units {@link formatBytes} steps through, each 1024× the one before —
 * the binary units the rest of the app already prints (`jsonParse`, the
 * socket docs), since a memory figure is a 1024-based one.
 */
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** One shared formatter for a size above a kilobyte: always exactly one decimal, so a column lines up. */
const byteFormat = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Formats a size in bytes in the browser's locale: `0 B`, `912 B`,
 * `1.5 KiB`, `412.3 MiB`, `2.0 GiB` — whole bytes below a kilobyte, then one
 * decimal in the largest unit that fits.
 *
 * **A missing size is not `0 B`.** `undefined`, `null` and anything not a
 * finite, non-negative number (an older worker reports no memory at all) give
 * `fallback` rather than a figure that was never measured.
 */
export function formatBytes(
  value: number | null | undefined,
  fallback = "—",
): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  let size = value;
  let index = 0;
  while (size >= 1024 && index < BYTE_UNITS.length - 1) {
    size /= 1024;
    index += 1;
  }
  const unit = BYTE_UNITS[index] ?? "B";
  return index === 0
    ? `${formatNumber(size)} ${unit}`
    : `${byteFormat.format(size)} ${unit}`;
}

/**
 * Display labels of the job states — the one place a state's label is
 * spelled. `failed` reads **"Retrying"**: in bun-jobs it is a job that failed
 * an attempt and waits for its retry (one that exhausts its attempts goes to
 * `dead`), so "Failed" misled. Only the label: the value stays `failed` in
 * every request, URL, query key, class name and test id.
 */
export const STATE_LABELS: Readonly<Record<JobState, string>> = {
  waiting: "Waiting",
  delayed: "Delayed",
  active: "Active",
  completed: "Completed",
  failed: "Retrying",
  dead: "Dead",
  "waiting-children": "Waiting children",
};

/**
 * A short explanation of a state whose label alone could mislead, for a
 * tooltip (the state badge's and the state tab's `title`); absent for the
 * rest. Tells someone hunting for "failed" jobs where they are.
 */
export const STATE_HINTS: Readonly<Partial<Record<JobState, string>>> = {
  failed:
    "Failed an attempt, waiting to retry (the API calls this state failed). Jobs that gave up are under Dead.",
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
