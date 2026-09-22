import type { RunLogLevel, RunLogStream } from "../../api/types";
import type { BadgeTone } from "../../components/Badge";
import {
  DEFAULT_REDACT_REPLACEMENT,
  RUN_LOG_HINT_MS,
  RUN_LOG_LEVELS,
  RUN_LOG_STREAMS,
} from "../../api/contract";

/**
 * How a run's captured output is labelled: the streams a filter offers, the
 * severity colours, and a line's clock time.
 *
 * Every list here is built from the contract's own (`RUN_LOG_STREAMS`,
 * `RUN_LOG_LEVELS`), so a stream or a level the API adds appears with no
 * change on this side.
 */

/**
 * What capture sees and what it never does, stated wherever a run's log is
 * shown. It is a documented limit of how bun-jobs captures output, not a gap
 * in this view: a quiet log does not prove a quiet run.
 *
 * Every mode captures its console now: a spawned run through its pipes, a
 * `worker` or `in-process` run by attributing each `console` call to the run
 * that made it (so two runs at once each keep their own). What escapes is
 * what bypasses both; the note names the gaps a user will actually hit, and
 * the README carries the full list.
 */
export const CAPTURE_GAP_NOTE =
  "A run's console output is captured whichever way it runs: console.log, info and debug as stdout, warn and error as stderr, beside its ctx.log() lines. Output written by native code, by a program the run launched with its own output, or, in a worker or in-process run, straight to process.stdout or process.stderr is not captured here.";

/**
 * That a stored line may not read exactly as the run printed it: capture
 * redacts values that look like secrets before storing a line, by default.
 * Deliberately no list of what it catches — the defaults are the backend's
 * and may change, and a list here would go stale.
 */
export const REDACTION_NOTE = `Values that look like secrets are replaced with ${DEFAULT_REDACT_REPLACEMENT} before a line is stored, by default, so some lines may not read exactly as the run printed them.`;

/**
 * The note on a live run's log saying how it is followed: by the runner's
 * `logs` hint, with `poll` as the fallback, while live updates have relaxed
 * the poll beyond `base`; by polling every `base` otherwise.
 */
export function followingNote(poll: number | false, base: number): string {
  // A live run's record carries no line count until the run settles, so while
  // it runs the log itself is the count — nothing on screen lags behind it.
  const count =
    "While the run is going, its history row shows no line count yet: the lines here are the count.";
  if (poll === false || poll <= base) {
    return `Following this run: re-read every ${base / 1000} s. Live updates are not reaching this view, so this is a poll. ${count}`;
  }
  return `Following this run: each time its log grows the live socket says so (at most every ${RUN_LOG_HINT_MS / 1000} s), and the new lines are read at once. A re-read every ${poll / 1000} s is the fallback, in case a notice goes missing. ${count}`;
}

/** What the stream filter is called in the URL. */
export const STREAM_PARAM = "logStream";

/** What the `logs` URL parameter holds: the run id whose log is open. */
export const LOGS_PARAM = "logs";

/** The label each stream is shown under; an unlisted one shows its own name. */
const STREAM_LABELS: Readonly<Record<string, string>> = {
  stdout: "stdout",
  stderr: "stderr",
  log: "logger",
};

/** How a stream is labelled in the filter and beside a line. */
export function streamLabel(stream: RunLogStream): string {
  return STREAM_LABELS[stream] ?? stream;
}

/** The stream filter's choices: every stream, then one per `RUN_LOG_STREAMS` in the order it offers them. */
export function streamOptions(): { value: string; label: string }[] {
  return [
    { value: "", label: "Every stream" },
    ...RUN_LOG_STREAMS.map((stream) => ({
      value: stream,
      label: streamLabel(stream),
    })),
  ];
}

/** Whether `value` names a stream the API knows; anything else means no filter. */
export function isRunLogStream(
  value: string | null | undefined,
): value is RunLogStream {
  return (
    value !== null &&
    value !== undefined &&
    (RUN_LOG_STREAMS as readonly string[]).includes(value)
  );
}

/**
 * The badge colour of a level, by its place in `RUN_LOG_LEVELS` (increasing
 * severity): `error` and above are danger, `warn` warning, `info` info, the
 * quieter ones neutral. A level the list does not hold is neutral, so a
 * logger that grows a level still renders.
 */
export function levelTone(level: RunLogLevel): BadgeTone {
  const rank = (RUN_LOG_LEVELS as readonly string[]).indexOf(level);
  if (rank < 0) {
    return "neutral";
  }
  if (rank >= RUN_LOG_LEVELS.indexOf("error")) {
    return "danger";
  }
  if (rank >= RUN_LOG_LEVELS.indexOf("warn")) {
    return "warning";
  }
  return rank >= RUN_LOG_LEVELS.indexOf("info") ? "info" : "neutral";
}

/** Two digits, for {@link formatClockTime}. */
function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/**
 * A line's local clock time, `HH:MM:SS.mmm` — the time of day, not a
 * relative age: consecutive lines are milliseconds apart, and "now" would
 * say nothing about their order. The ISO instant goes in the `<time>`'s
 * `dateTime` and `title` beside it.
 */
export function formatClockTime(at: number): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) {
    return "--:--:--.---";
  }
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.${pad(when.getMilliseconds(), 3)}`;
}

/** The ISO instant of a line, or `undefined` when its `at` is not a time. */
export function isoTime(at: number): string | undefined {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? undefined : when.toISOString();
}
