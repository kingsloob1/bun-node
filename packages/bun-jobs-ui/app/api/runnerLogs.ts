import type { QueryKey } from "@tanstack/react-query";
import type { ApiClient } from "./client";
import type { ApiError } from "./errors";
import type {
  EventWire,
  RunLogLineDto,
  RunLogPageDto,
  RunLogsQuery,
  RunLogStream,
  RunRecordDto,
} from "./types";
import { segment } from "./client";
import { isApiError } from "./errors";
import { runnerKeys } from "./runners";

/**
 * One run's captured output: `GET /runners/:runner/runs/:runId/logs`
 * (operation `getRunLogs`, action `runners.logs`), and the tail state the
 * view keeps.
 *
 * Organised like `api/jobs.ts`' log reads — the keys sit under the runner's
 * own prefix ({@link runnerKeys.runner}), so one runner invalidation
 * refreshes its run logs too — but the read is a **tail**, not a pager: the
 * page's `lastSeq` goes back as the next request's exclusive `since`, and
 * {@link mergeRunLogPage} folds each page into the lines already read. That
 * accumulation lives in the query cache (the merge takes the cached tail and
 * returns the next one), not in component state, so a view that unmounts and
 * comes back resumes where it was instead of re-reading from the start.
 */

/**
 * How often a live run's log is re-read, ms, while live updates are off.
 *
 * With them on, the runner's `logs` event (see {@link runLogHint}) says when
 * the log grew and a read follows it, so this is relaxed the way every other
 * poll in the app is (`usePollInterval`) and becomes the fallback: a missed
 * hint only delays a line until the next read, and `since` means that read
 * still returns everything after what the view holds.
 */
export const RUN_LOG_POLL_MS = 2_000;

/**
 * How long after a page that reported `hasMore` the next one is asked for,
 * ms: short, because this is catching up on a backlog rather than waiting
 * for new output.
 */
export const RUN_LOG_CATCHUP_MS = 100;

/**
 * Most lines one tail keeps in memory. A run's log is capped by the backend
 * (1,000 lines and 1 MiB by default), so this only bites on a deployment
 * with much larger caps; when it does, the oldest lines go and
 * {@link RunLogTail.trimmed} counts them, so the view can say so.
 */
export const RUN_LOG_TAIL_MAX = 2_000;

/** The page size a tail asks for: the API's own default, `min(100, limits.maxLogPage)`. */
export function runLogPageLimit(maxLogPage: number): number {
  return Math.max(1, Math.min(100, maxLogPage));
}

/** Query keys of one run's log, all under `["runner", id]`. */
export const runLogKeys = {
  /** Everything about one run: `["runner", runner, "run", runId]`. */
  run: (runner: string, runId: string) =>
    [...runnerKeys.runner(runner), "run", runId] as const,
  /** One run's log tail, per stream filter (`null` = every stream). */
  logs: (runner: string, runId: string, stream?: RunLogStream) =>
    [
      ...runLogKeys.run(runner, runId),
      "logs",
      { stream: stream ?? null },
    ] as const,
};

/**
 * What a read of one run's log refreshes. Nothing the UI sends writes run
 * output, so this is only for a caller that knows the log moved (a trigger,
 * a kill); the runner's own invalidation ({@link runnerKeys.runner}) already
 * covers it, and the merge keeps the lines already read either way.
 */
export function runLogInvalidations(runner: string, runId: string): QueryKey[] {
  return [runLogKeys.run(runner, runId)];
}

/** `/runners/:runner/runs/:runId/logs`, each part percent-encoded. */
export function runLogsPath(runner: string, runId: string): string {
  return `/runners/${segment(runner)}/runs/${segment(runId)}/logs`;
}

/** `GET /runners/:runner/runs/:runId/logs`. */
export function getRunLogs(
  api: ApiClient,
  runner: string,
  runId: string,
  query: RunLogsQuery = {},
  signal?: AbortSignal,
): Promise<RunLogPageDto> {
  return api.request<RunLogPageDto>("GET", runLogsPath(runner, runId), {
    query: {
      since: query.since,
      offset: query.offset,
      limit: query.limit,
      order: query.order,
      stream: query.stream,
    },
    signal,
  });
}

/** The lines read so far, and what the last page said about the run. */
export interface RunLogTail {
  /** Every line read so far, oldest first, at most {@link RUN_LOG_TAIL_MAX}. */
  lines: RunLogLineDto[];
  /** The exclusive `since` of the next read: the highest `seq` this tail has accounted for. */
  cursor: number;
  /** How many of the run's lines the backend's caps have dropped, oldest first (the run's own number, unfiltered). */
  dropped: number;
  /** Whether a cap is trimming this run's log right now, so what is here is a tail of it. */
  capped: boolean;
  /** Whether the run is still going, so more lines may follow. */
  live: boolean;
  /** The highest `seq` the run's log holds (the run's own, unfiltered by the stream filter). */
  lastSeq: number;
  /** Whether the last page left more to read at once, so the next read is a catch-up rather than a poll. */
  hasMore: boolean;
  /** How many lines this view itself let go to stay within {@link RUN_LOG_TAIL_MAX}. */
  trimmed: number;
}

/**
 * Folds one page into the tail read so far: new lines are appended (a line
 * whose `seq` is already there is ignored, so a retried request cannot
 * duplicate one), and the cursor advances.
 *
 * **The cursor is the page's `lastSeq` only when the page holds everything up
 * to it.** With `hasMore` the page stopped at its `limit`, so the cursor is
 * the last line actually received; resuming from `lastSeq` there would skip
 * the rest. `lastSeq` is the run's own, unfiltered by `stream`, which is what
 * makes it the right cursor for a filtered tail once the page is complete.
 */
export function mergeRunLogPage(
  previous: RunLogTail | undefined,
  page: RunLogPageDto,
): RunLogTail {
  const seen = new Set(previous?.lines.map((line) => line.seq) ?? []);
  const fresh = page.items.filter((line) => !seen.has(line.seq));
  const merged = [...(previous?.lines ?? []), ...fresh].sort(
    (left, right) => left.seq - right.seq,
  );
  const overflow = Math.max(0, merged.length - RUN_LOG_TAIL_MAX);
  const lastReceived = page.items.at(-1)?.seq ?? 0;
  const hasMore = page.page.hasMore;
  const reached = hasMore
    ? lastReceived
    : Math.max(page.lastSeq, lastReceived, previous?.cursor ?? 0);
  return {
    lines: overflow > 0 ? merged.slice(overflow) : merged,
    cursor: Math.max(previous?.cursor ?? 0, reached),
    dropped: page.dropped,
    capped: page.capped,
    live: page.live,
    lastSeq: page.lastSeq,
    hasMore,
    trimmed: (previous?.trimmed ?? 0) + overflow,
  };
}

/**
 * The tail's refetch interval: a short catch-up while a page reported more
 * to read, `poll` while the run is live, and no polling at all once a
 * finished run's log has been read to its end.
 *
 * `poll` defaults to {@link RUN_LOG_POLL_MS}; the view passes it relaxed by
 * `usePollInterval` while live updates are on, because the `logs` hint then
 * drives the reads and the poll is only the fallback. The catch-up is never
 * relaxed: it is draining a backlog the last page already reported.
 */
export function runLogsRefetchInterval(
  tail: RunLogTail | undefined,
  poll: number | false = RUN_LOG_POLL_MS,
): number | false {
  if (!tail) {
    return false;
  }
  if (tail.hasMore) {
    return RUN_LOG_CATCHUP_MS;
  }
  return tail.live ? poll : false;
}

/**
 * The `lastSeq` a runner's `logs` event announces for one run, or
 * `undefined` when the event is not that: another type, another runner, or
 * another run.
 *
 * The event is a **hint, never the lines**: it carries `{ runId, lastSeq }`
 * and nothing of what was logged, so the only thing to do with it is read
 * the log again from the view's own cursor.
 */
export function runLogHint(
  event: EventWire,
  runner: string,
  runId: string,
): number | undefined {
  if (
    event.kind !== "runner" ||
    event.type !== "logs" ||
    event.target !== runner ||
    event.payload.runId !== runId
  ) {
    return undefined;
  }
  return event.payload.lastSeq;
}

/**
 * Whether a hint announcing `lastSeq` is worth a read: the view has not read
 * anything yet, or its cursor is behind. The cursor is the run's own
 * `lastSeq` once a page is complete (unfiltered by the stream filter), so a
 * hint the view has already caught up with — the one sent as a run settles,
 * typically — costs nothing.
 */
export function runLogHintNeedsRead(
  tail: RunLogTail | undefined,
  lastSeq: number,
): boolean {
  return tail === undefined || tail.cursor < lastSeq;
}

/**
 * Whether a run's log is worth offering: it has lines, it is still going and
 * may yet write some, or its record does not say.
 *
 * Three cases, and only one of them hides the log:
 *
 * - `logLines > 0`, or the run is `running` — offered. The count lags by up
 *   to 250 ms while a run is live (capture flushes on a timer), so a live
 *   run qualifies whatever it reports.
 * - `logLines` **absent** — offered. The field is optional on the wire, and a
 *   record that omits it says nothing about the run; the read itself is then
 *   the honest answer (a 200 with no lines means the run was quiet). Whether
 *   the backend stores run logs at all is `meta.features.runnerLogs`, which
 *   gates the whole feature, and the API states it again as 409
 *   `LOGS_NOT_RETAINED`.
 * - `logLines === 0` on a finished run — not offered: the run was quiet, and
 *   the caller says so instead.
 */
export function hasRunLogs(
  run: Pick<RunRecordDto, "logLines" | "status">,
): boolean {
  return (
    run.logLines === undefined || run.logLines > 0 || run.status === "running"
  );
}

/**
 * Whether the API answered 409 `LOGS_NOT_RETAINED`: this backend keeps no
 * run logs at all, which is exactly `meta.features.runnerLogs === false`. A
 * 200 with no lines is a different thing — the log is kept, and the run
 * logged nothing.
 */
export function isLogsNotRetained(error: unknown): error is ApiError {
  return isApiError(error) && error.code === "LOGS_NOT_RETAINED";
}

/**
 * Whether the API answered 404 `RUN_NOT_FOUND`. The route answers it for a
 * run neither the history nor the log store has heard of — which today also
 * covers a run that has aged out of what the runner keeps, since nothing
 * tells the two apart. The copy has to be true of both.
 */
export function isRunNotFound(error: unknown): error is ApiError {
  return isApiError(error) && error.code === "RUN_NOT_FOUND";
}
