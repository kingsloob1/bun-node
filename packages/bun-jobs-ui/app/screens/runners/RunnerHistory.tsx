import type { RunnerInfoDto, RunRecordDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { hasRunLogs } from "../../api/runnerLogs";
import { getRunnerHistory, runnerKeys } from "../../api/runners";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Select } from "../../components/inputs";
import { Pager } from "../../components/Pager";
import { ProblemBanner } from "../../components/ProblemBanner";
import { RelativeTime } from "../../components/RelativeTime";
import { Spinner } from "../../components/Spinner";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { formatNumber, plural } from "../../format";
import { useMeta } from "../../meta/hooks";
import { useCanMutate } from "../queues/gating";
import { clampLimit, intParam, useUrlParams } from "../queues/urlState";
import { runnerActionGates } from "./actions/gating";
import { ClearHistoryDialog } from "./actions/RunnerDialogs";
import { useHistoryPage } from "./historyPage";
import { useHistoryRefetchInterval } from "./live";
import { LOGS_PARAM } from "./runLogFormat";
import { useCanReadRunLogs } from "./runLogGates";
import { RunLogsSection } from "./RunLogsSection";
import {
  defaultHistoryLimit,
  historyLimitOptions,
  newestFirst,
  RUN_SOURCE,
  runDuration,
} from "./runnerFormat";
import { RunRecordDetails, RunStatusBadge } from "./RunRecord";

/** Props of {@link RunnerHistory}. */
export interface RunnerHistoryProps {
  /** The runner's id. */
  runner: string;
  /** Whether to read (and poll) the history. Defaults to `true`. */
  enabled?: boolean;
  /**
   * The runner as `GET /runners/:runner` returned it, which Clear history…
   * needs (its gate and its confirmation read the runner's mode and whether
   * it is local). Absent, the card shows no Clear history….
   */
  info?: RunnerInfoDto;
}

/** Props of {@link HistoryRow}. */
interface HistoryRowProps {
  /** The run this row shows. */
  run: RunRecordDto;
  /** Whether the table carries its Logs column (the caller may read run logs). */
  showLogs: boolean;
}

/** One run, and its details once expanded. */
function HistoryRow({ run, showLogs }: HistoryRowProps) {
  const [params, update] = useUrlParams();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  // A row whose log the URL opens is expanded, so the log is on screen; the
  // disclosure closes both.
  const logsOpen = showLogs && params.get(LOGS_PARAM) === run.runId;
  const open = expanded || logsOpen;
  const toggle = () => {
    if (open) {
      setExpanded(false);
      if (logsOpen) {
        update({ [LOGS_PARAM]: null });
      }
      return;
    }
    setExpanded(true);
  };
  const dropped = run.logsDropped ?? 0;
  return (
    <Fragment>
      <tr data-testid={`history-row-${run.runId}`}>
        <td>
          <button
            type="button"
            className="run-toggle"
            aria-expanded={open}
            aria-controls={open ? detailsId : undefined}
            aria-label={`${open ? "Hide" : "Show"} run ${run.runId}`}
            onClick={toggle}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        </td>
        <td>
          <RelativeTime value={run.startedAt} />
        </td>
        <td>
          <RunStatusBadge status={run.status} />
        </td>
        <td>{RUN_SOURCE[run.source]}</td>
        <td className="numeric">{formatNumber(run.attempt)}</td>
        <td className="numeric">{runDuration(run) ?? "—"}</td>
        <td>
          <code className="run-id">{run.runId}</code>
        </td>
        {showLogs && (
          <td className="run-logs-cell">
            {hasRunLogs(run) && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={logsOpen}
                onClick={() =>
                  update({ [LOGS_PARAM]: logsOpen ? null : run.runId })
                }
              >
                {logsOpen ? "Hide log" : "Log"}
              </Button>
            )}
            {dropped > 0 && (
              <Badge
                tone="warning"
                title={`${plural(dropped, "line")} of this run's log went to the log's cap, oldest first.`}
              >
                {plural(dropped, "line")} dropped
              </Badge>
            )}
          </td>
        )}
      </tr>
      {open && (
        <tr
          id={detailsId}
          className="run-details-row"
        >
          <td colSpan={showLogs ? 8 : 7}>
            <RunRecordDetails run={run} />
            {/* The one place a run's log is hosted: the runner screen shows
                the run in flight and the last run again in their own cards,
                and both are rows of this table too, so hosting it here keeps
                one log per run on the screen. */}
            <RunLogsSection run={run} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * `GET /runners/:runner/history`: the recent runs, newest first, with a size
 * select capped at `limits.maxHistory` (kept in the URL as `history`).
 */
export function RunnerHistory({
  runner,
  enabled = true,
  info,
}: RunnerHistoryProps) {
  const api = useApiClient();
  const canMutate = useCanMutate();
  // Clear history… lives here, above the runs it clears, rather than with the
  // runner's other actions in the page header.
  const canClear =
    info !== undefined && runnerActionGates(info, canMutate).clearHistory;
  const [clearing, setClearing] = useState(false);
  const { limits } = useMeta();
  const [params, update] = useUrlParams();
  const selectId = useId();
  // Like the workers table's actions column: a caller who cannot read run
  // logs sees the table without the column, not a column of blanks.
  const showLogs = useCanReadRunLogs();
  const fallback = defaultHistoryLimit(limits.maxHistory);
  const limit = clampLimit(
    intParam(params, "history", fallback),
    limits.maxHistory,
  );
  const options = historyLimitOptions(limits.maxHistory);

  const refetchInterval = useHistoryRefetchInterval();
  const history = useQuery({
    queryKey: runnerKeys.history(runner, limit),
    queryFn: ({ signal }) => getRunnerHistory(api, runner, limit, signal),
    refetchInterval,
    enabled,
  });
  // The rows in the order the table lists them, then the page of them: the
  // fetch above is unchanged, and `historyPage.ts` is the only place that
  // knows where a page comes from.
  const runs = history.data ? newestFirst(history.data.items) : [];
  const page = useHistoryPage(runs, showLogs ? params.get(LOGS_PARAM) : null);

  return (
    <Card
      title="History"
      actions={
        <div className="history-actions">
          {canClear && (
            <Button
              size="sm"
              variant="danger"
              // Nothing to clear yet: say so rather than open an empty dialog.
              disabled={history.data?.items.length === 0}
              title={
                history.data?.items.length === 0
                  ? "No runs to clear."
                  : undefined
              }
              onClick={() => setClearing(true)}
            >
              Clear history…
            </Button>
          )}
          <div className="history-limit">
            <label htmlFor={selectId}>Runs shown</label>
            <Select
              id={selectId}
              options={options.map((value) => ({ value: String(value) }))}
              value={String(limit)}
              onChange={(value) =>
                update({
                  history: Number(value) === fallback ? null : value,
                })
              }
            />
          </div>
        </div>
      }
    >
      {clearing && info && (
        <ClearHistoryDialog
          runner={info}
          onClose={() => setClearing(false)}
        />
      )}
      {history.isPending ? (
        <Spinner
          label="Loading the history"
          showLabel
        />
      ) : history.isError ? (
        <ProblemBanner
          error={history.error}
          title="Could not load the history"
          onRetry={() => void history.refetch()}
        />
      ) : history.data.items.length === 0 ? (
        <EmptyState
          title="No runs yet"
          description="Runs show here, newest first, once this runner has run."
        />
      ) : (
        <Table
          label="Run history"
          className="history-table"
        >
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Details</span>
              </th>
              <th scope="col">Started</th>
              <th scope="col">Status</th>
              <th scope="col">Source</th>
              <th
                scope="col"
                className="numeric"
              >
                Attempt
              </th>
              <th
                scope="col"
                className="numeric"
              >
                Duration
              </th>
              <th scope="col">Run id</th>
              {showLogs && <th scope="col">Log</th>}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((run) => (
              <HistoryRow
                key={run.runId}
                run={run}
                showLogs={showLogs}
              />
            ))}
          </tbody>
        </Table>
      )}
      {page.paged && (
        <>
          <Pager
            label="History pages"
            offset={page.offset}
            limit={page.limit}
            total={page.total}
            itemCount={page.rows.length}
            onChange={page.onChange}
          />
          <p
            className="muted history-paging-note"
            data-testid="history-paging-note"
          >
            These pages divide the runs fetched — the “Runs shown” number above
            — not the runner’s whole history. To reach older runs, fetch more.
          </p>
        </>
      )}
    </Card>
  );
}
