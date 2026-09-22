import type { RunLogTail } from "../../api/runnerLogs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import {
  getRunLogs,
  isLogsNotRetained,
  isRunNotFound,
  mergeRunLogPage,
  RUN_LOG_POLL_MS,
  RUN_LOG_TAIL_MAX,
  runLogHintNeedsRead,
  runLogKeys,
  runLogPageLimit,
  runLogsRefetchInterval,
} from "../../api/runnerLogs";
import { Badge } from "../../components/Badge";
import { cx } from "../../components/classNames";
import { EmptyState } from "../../components/EmptyState";
import { Select } from "../../components/inputs";
import { ProblemBanner } from "../../components/ProblemBanner";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { formatNumber, plural } from "../../format";
import { usePollInterval } from "../../live";
import { useMeta } from "../../meta/hooks";
import { LogLines } from "../logs/LogLines";
import { useUrlParams } from "../queues/urlState";
import { useRunLogHints } from "./live";
import {
  CAPTURE_GAP_NOTE,
  followingNote,
  formatClockTime,
  isoTime,
  isRunLogStream,
  levelTone,
  REDACTION_NOTE,
  STREAM_PARAM,
  streamLabel,
  streamOptions,
} from "./runLogFormat";

/** What the per-line cut marker says, and what it means. */
const TRUNCATED_HINT =
  "Capture cut this line at its 8 KiB limit, so it is shorter than what the run printed.";

/** Props of {@link RunLogs}. */
export interface RunLogsProps {
  /** The runner's id. */
  runner: string;
  /** The run's id. */
  runId: string;
  /** Whether to read the log and follow it. Defaults to `true`. */
  enabled?: boolean;
}

/**
 * One run's captured output, tailed.
 *
 * Each read asks for the lines above the last `seq` this view has
 * accounted for (`?since=`, an exclusive bound), and the page is folded into
 * the ones already read.
 *
 * **What makes it move.** While the run is live, the runner's `logs` event
 * on `runner/<runner>` — a hint carrying `{ runId, lastSeq }`, never a line —
 * triggers a read for this run whenever its `lastSeq` is past the cursor;
 * hints for the runner's other runs are ignored. A poll stays underneath as
 * the fallback: every {@link RUN_LOG_POLL_MS} while live updates are off,
 * relaxed by `usePollInterval` while they are on, because then a missed hint
 * only delays a line until the next read (which, being `since` the cursor,
 * still returns it). Once the run has finished and its log has been read to
 * the end, both stop.
 *
 * The stream filter lives in the URL (`logStream`), and each filter keeps
 * its own tail: `since` is a raw sequence number, so switching the filter
 * re-reads from the start of what is kept rather than resuming mid-stream.
 *
 * **A line is a line, not an event.** A spawned run's pretty-printed logger
 * arrives as several `stdout` lines and is shown as several; nothing here
 * tries to join them back together, which is what makes the stream filter
 * worth having (`log` alone is the handler's own narrative). A `log` line's
 * fields are already rendered into its text at capture, and a line may carry
 * no level at all, so neither is treated as structure to unpack.
 */
export function RunLogs({ runner, runId, enabled = true }: RunLogsProps) {
  const api = useApiClient();
  const { limits } = useMeta();
  const queryClient = useQueryClient();
  const [params, update] = useUrlParams();
  const filterId = useId();
  const raw = params.get(STREAM_PARAM);
  const stream = isRunLogStream(raw) ? raw : undefined;
  const limit = runLogPageLimit(limits.maxLogPage);
  const queryKey = runLogKeys.logs(runner, runId, stream);
  const poll = usePollInterval(RUN_LOG_POLL_MS);

  const logs = useQuery({
    queryKey,
    enabled,
    queryFn: async ({ signal }) => {
      // The tail accumulates in the cache, so a view that unmounts and comes
      // back resumes from its cursor instead of re-reading the whole log.
      const previous = queryClient.getQueryData<RunLogTail>(queryKey);
      const page = await getRunLogs(
        api,
        runner,
        runId,
        {
          since: previous?.cursor === 0 ? undefined : previous?.cursor,
          limit,
          order: "asc",
          stream,
        },
        signal,
      );
      return mergeRunLogPage(previous, page);
    },
    refetchInterval: (query) =>
      isLogsNotRetained(query.state.error) || isRunNotFound(query.state.error)
        ? false
        : runLogsRefetchInterval(query.state.data, poll),
  });

  const tail = logs.data;
  /** Re-reads this filter's tail from its cursor, if the query is mounted and enabled. */
  const read = () =>
    void queryClient.refetchQueries({ queryKey, exact: true, type: "active" });
  useRunLogHints(runner, runId, enabled && tail?.live !== false, {
    onHint: (lastSeq) => {
      if (
        runLogHintNeedsRead(
          queryClient.getQueryData<RunLogTail>(queryKey),
          lastSeq,
        )
      ) {
        read();
      }
    },
    onGap: read,
  });
  const filter = (
    <span className="run-log-filter">
      <label htmlFor={filterId}>Stream</label>
      <Select
        id={filterId}
        options={streamOptions()}
        value={stream ?? ""}
        onChange={(value) => update({ [STREAM_PARAM]: value || null })}
      />
    </span>
  );

  return (
    <section
      className="run-logs"
      aria-label={`Log of run ${runId}`}
      data-testid={`run-logs-${runId}`}
    >
      <div className="run-log-header">{filter}</div>
      {isLogsNotRetained(logs.error) ? (
        <EmptyState
          title="Run logs are not retained"
          description={
            logs.error.detail ??
            "This API keeps no run logs at all, so there is none for this run to read. That is not the same as a run that logged nothing."
          }
        />
      ) : isRunNotFound(logs.error) ? (
        <EmptyState
          title="No log for this run"
          description={
            // The API cannot yet tell an unknown run from one whose record
            // has aged out, so neither can this.
            "This runner has no record of the run: either it never ran here, or it has aged out of the runs this runner keeps, and its log went with it."
          }
        />
      ) : !tail ? (
        logs.isError ? (
          <ProblemBanner
            error={logs.error}
            title="Could not load the run log"
            onRetry={() => void logs.refetch()}
          />
        ) : (
          <Spinner
            label="Loading the run log"
            showLabel
          />
        )
      ) : (
        <>
          {logs.isError && (
            <ProblemBanner
              error={logs.error}
              title="Could not refresh the run log"
              onRetry={() => void logs.refetch()}
            />
          )}
          <RunLogNotes
            tail={tail}
            poll={poll}
          />
          {tail.lines.length === 0 ? (
            <p
              className="muted"
              data-testid="run-logs-empty"
            >
              {emptyText(tail, stream !== undefined)}
            </p>
          ) : (
            <LogLines
              label={`Log lines of run ${runId}`}
              items={tail.lines.map((line) => ({
                // `seq` is the line's identity in its run, and a gap in the
                // gutter is where the cap dropped lines.
                id: line.seq,
                number: line.seq,
                text: line.message,
                className: cx("run-log-line", `run-log-line-${line.stream}`),
                prefix: (
                  <>
                    <time
                      className="run-log-time"
                      dateTime={isoTime(line.at)}
                      title={isoTime(line.at)}
                    >
                      {formatClockTime(line.at)}
                    </time>
                    <span className="run-log-stream">
                      {streamLabel(line.stream)}
                    </span>
                    {line.level !== undefined && (
                      <Badge
                        className="run-log-level"
                        tone={levelTone(line.level)}
                      >
                        {line.level}
                      </Badge>
                    )}
                  </>
                ),
                suffix: line.truncated ? (
                  <Badge
                    className="run-log-cut"
                    tone="warning"
                    title={TRUNCATED_HINT}
                  >
                    cut at 8 KiB
                  </Badge>
                ) : undefined,
              }))}
            />
          )}
          <p className="muted run-log-gap">{CAPTURE_GAP_NOTE}</p>
          <p className="muted run-log-redaction">{REDACTION_NOTE}</p>
        </>
      )}
    </section>
  );
}

/** What an empty tail means: nothing on this stream, nothing yet, or a run that logged nothing at all. */
function emptyText(tail: RunLogTail, filtered: boolean): string {
  if (filtered) {
    return tail.live
      ? "Nothing on this stream yet."
      : "This run logged nothing on this stream.";
  }
  return tail.live
    ? "Nothing logged yet."
    : "This run logged nothing. A 200 with no lines means the log is kept and empty, not that it is missing.";
}

/** Props of {@link RunLogNotes}. */
interface RunLogNotesProps {
  /** The tail the notes describe. */
  tail: RunLogTail;
  /** The fallback poll in force, ms: {@link RUN_LOG_POLL_MS} while live updates are off, relaxed while they are on. */
  poll: number | false;
}

/** What this log is not showing, and why: the caps, this view's own ceiling, and whether it is still moving. */
function RunLogNotes({ tail, poll }: RunLogNotesProps) {
  const notes: string[] = [];
  if (tail.dropped > 0) {
    notes.push(
      `${plural(tail.dropped, "earlier line")} dropped: this run's log keeps its most recent lines only (1,000 lines and 1 MiB per run by default). The count is the run's own, whatever this filter shows.`,
    );
  }
  if (tail.capped) {
    notes.push(
      "A cap is trimming this log now: its oldest lines go as new ones arrive.",
    );
  }
  if (tail.trimmed > 0) {
    notes.push(
      `${plural(tail.trimmed, "earlier line")} left this view, which keeps the last ${formatNumber(RUN_LOG_TAIL_MAX)}. Reopen the log to read from the start of what is kept.`,
    );
  }
  if (tail.live) {
    notes.push(followingNote(poll, RUN_LOG_POLL_MS));
  }
  if (notes.length === 0) {
    return null;
  }
  return (
    <div
      className="run-log-notes"
      data-testid="run-log-notes"
    >
      {notes.map((note) => (
        <p
          key={note}
          className="muted"
        >
          {note}
        </p>
      ))}
    </div>
  );
}
