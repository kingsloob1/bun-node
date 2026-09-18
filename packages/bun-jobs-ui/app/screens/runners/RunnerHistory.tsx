import type { RunRecordDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { getRunnerHistory, runnerKeys } from "../../api/runners";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Select } from "../../components/inputs";
import { ProblemBanner } from "../../components/ProblemBanner";
import { RelativeTime } from "../../components/RelativeTime";
import { Spinner } from "../../components/Spinner";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { formatNumber } from "../../format";
import { useMeta } from "../../meta/hooks";
import { clampLimit, intParam, useUrlParams } from "../queues/urlState";
import { useHistoryRefetchInterval } from "./live";
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
}

/** One run, and its details once expanded. */
function HistoryRow({ run }: { run: RunRecordDto }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
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
            onClick={() => setOpen((value) => !value)}
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
      </tr>
      {open && (
        <tr
          id={detailsId}
          className="run-details-row"
        >
          <td colSpan={7}>
            <RunRecordDetails run={run} />
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
export function RunnerHistory({ runner, enabled = true }: RunnerHistoryProps) {
  const api = useApiClient();
  const { limits } = useMeta();
  const [params, update] = useUrlParams();
  const selectId = useId();
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

  return (
    <Card
      title="History"
      actions={
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
      }
    >
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
            </tr>
          </thead>
          <tbody>
            {newestFirst(history.data.items).map((run) => (
              <HistoryRow
                key={run.runId}
                run={run}
              />
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
