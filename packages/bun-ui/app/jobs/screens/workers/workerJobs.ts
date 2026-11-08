import type { PresetRange, TimeRange } from "../../analytics/range";
import type { JobState } from "../../api/contract";
import type { FinishedWindow, JobListFilters } from "../../api/queues";
import type { StateTab } from "../queues/jobFilters";
import { readRange } from "../../analytics/range";
import { ALL_STATES } from "../queues/jobFilters";
import { clampLimit, intParam, splitList } from "../queues/urlState";

/**
 * The URL state of a worker page's jobs section. Its parameters carry a
 * `job` prefix (and the range is `finished`), since the page's own `range`
 * is its throughput's and a bare `state` would read as the worker's.
 */
export const WORKER_JOB_PARAMS = {
  /** The state tab. */
  state: "jobState",
  /** Exact names, comma-separated. */
  name: "jobName",
  /** Id/name substring. */
  search: "jobSearch",
  /** `asc` for oldest first; absent means newest first. */
  order: "jobOrder",
  /** Rows skipped. */
  offset: "jobOffset",
  /** Page size. */
  limit: "jobLimit",
  /** The `finishedOn` range. */
  finished: "finished",
} as const;

/** The range a worker's jobs are listed over by default: the last 24 hours. */
export const DEFAULT_FINISHED_RANGE: PresetRange = {
  kind: "preset",
  seconds: 86_400,
};

/**
 * The states a `finishedOn` range can match: only a completed or dead job has
 * a `finishedOn`. A waiting, delayed, active or waiting-children job has none,
 * and neither has a failed one (it is waiting for its retry), so the API would
 * match none of them to any range.
 */
const FINISHED_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "completed",
  "dead",
]);

/**
 * Whether the range applies to a state tab: to All (which then lists the
 * finished jobs alone) and to the finished states, never to one a job waits
 * or runs in.
 */
export function rangeApplies(tab: StateTab): boolean {
  return tab === ALL_STATES || FINISHED_STATES.has(tab);
}

/**
 * The jobs range as the URL holds it: `<seconds>s` for a preset, `<from>-<to>`
 * in epoch ms for a custom span, and absent for the default (the last 24
 * hours). Every preset but the default is written, including the analytics
 * default (`3600s`), since this section's default is another one.
 */
export function writeFinishedRange(range: TimeRange): string | null {
  if (range.kind === "preset") {
    return range.seconds === DEFAULT_FINISHED_RANGE.seconds
      ? null
      : `${range.seconds}s`;
  }
  return `${range.from}-${range.to}`;
}

/**
 * The jobs range read back from the URL. A preset reads as the analytics
 * presets do; a custom span needs only its end after its start (the API
 * bounds no `finishedOn` window). Anything else is the default.
 */
export function readFinishedRange(raw: string | null): TimeRange {
  if (raw === null || raw === "") {
    return DEFAULT_FINISHED_RANGE;
  }
  const custom = /^(\d+)-(\d+)$/.exec(raw);
  if (custom) {
    const from = Number(custom[1]);
    const to = Number(custom[2]);
    return Number.isSafeInteger(from) && Number.isSafeInteger(to) && to > from
      ? { kind: "custom", from, to }
      : DEFAULT_FINISHED_RANGE;
  }
  if (/^\d+s$/.test(raw)) {
    const preset = readRange(raw);
    // `readRange` falls back to its own default for a preset nobody offers.
    return preset.kind === "preset" && raw === `${preset.seconds}s`
      ? preset
      : DEFAULT_FINISHED_RANGE;
  }
  return DEFAULT_FINISHED_RANGE;
}

/** The `finishedOn` window a range stands for, kept rolling for a preset. */
export function finishedWindow(range: TimeRange): FinishedWindow {
  return range.kind === "preset"
    ? { kind: "last", ms: range.seconds * 1_000 }
    : { kind: "between", from: range.from, to: range.to };
}

/**
 * Reads a worker page's jobs filters from the URL: the queue table's filters
 * under their prefixed names, newest first by default, never a total, plus
 * the key and — when the tab is one it applies to — the range.
 */
export function readWorkerJobFilters(
  params: URLSearchParams,
  tab: StateTab,
  workerKey: string,
  limits: { defaultPageSize: number; maxPageSize: number },
): JobListFilters {
  const range = readFinishedRange(params.get(WORKER_JOB_PARAMS.finished));
  return {
    state: tab === ALL_STATES ? null : tab,
    offset: intParam(params, WORKER_JOB_PARAMS.offset, 0),
    limit: clampLimit(
      intParam(params, WORKER_JOB_PARAMS.limit, limits.defaultPageSize),
      limits.maxPageSize,
    ),
    order: params.get(WORKER_JOB_PARAMS.order) === "asc" ? "asc" : "desc",
    names: splitList(params.get(WORKER_JOB_PARAMS.name) ?? ""),
    search: params.get(WORKER_JOB_PARAMS.search) ?? "",
    // Never counted: a queue usually has one key, so the count would walk
    // the whole range the page is kept fast by.
    total: false,
    attribution: {
      workerKeys: [workerKey],
      workerIds: [],
      finished: rangeApplies(tab) ? finishedWindow(range) : null,
    },
  };
}
