import type { LogsWindow } from "../../api/jobs";
import type { JobState, SortOrder } from "../../api/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { getJobLogs, jobKeys } from "../../api/jobs";
import { Card } from "../../components/Card";
import { Select } from "../../components/inputs";
import { Pager } from "../../components/Pager";
import { ProblemBanner } from "../../components/ProblemBanner";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { formatNumber } from "../../format";
import { useMeta } from "../../meta/hooks";
import {
  defaultLogLimit,
  LOG_PAGE_SIZES,
  LOG_POLL_MS,
  logsFollow,
  logsRefetchInterval,
} from "./polling";

/** The order choices. */
const ORDER_OPTIONS = [
  { value: "asc", label: "Oldest first" },
  { value: "desc", label: "Newest first" },
] as const satisfies readonly { value: SortOrder; label: string }[];

/** Props of {@link JobLogs}. */
export interface JobLogsProps {
  /** The job's queue. */
  queue: string;
  /** The job's id. */
  id: string;
  /** The job's state: the page refreshes while it is active or waiting. */
  state: JobState;
}

/**
 * A job's log lines: paged (at most `limits.maxLogPage` a page), oldest or
 * newest first, refreshing every few seconds while the job can still log.
 */
export function JobLogs({ queue, id, state }: JobLogsProps) {
  const api = useApiClient();
  const { limits } = useMeta();
  const orderId = useId();
  const [view, setView] = useState<LogsWindow>(() => ({
    offset: 0,
    limit: defaultLogLimit(limits.maxLogPage),
    order: "asc",
  }));
  const logs = useQuery({
    queryKey: jobKeys.logs(queue, id, view),
    queryFn: ({ signal }) => getJobLogs(api, queue, id, view, signal),
    placeholderData: keepPreviousData,
    refetchInterval: logsRefetchInterval(state),
  });
  const data = logs.data;
  const total = data?.page.total ?? 0;
  /** A line's 1-based number in the whole log, whichever the order. */
  const lineNumber = (index: number) =>
    view.order === "asc"
      ? view.offset + index + 1
      : total - view.offset - index;

  return (
    <Card
      title="Logs"
      actions={
        <span className="job-logs-order">
          <label htmlFor={orderId}>Order</label>
          <Select
            id={orderId}
            options={ORDER_OPTIONS}
            value={view.order}
            onChange={(order) =>
              setView((current) => ({ ...current, order, offset: 0 }))
            }
          />
        </span>
      }
    >
      {logsFollow(state) && (
        <p
          className="muted job-logs-follow"
          data-testid="logs-follow"
        >
          Refreshing every {LOG_POLL_MS / 1000} s while the job is {state}.
        </p>
      )}
      {!data ? (
        logs.isError ? (
          <ProblemBanner
            error={logs.error}
            title="Could not load the logs"
            onRetry={() => void logs.refetch()}
          />
        ) : (
          <Spinner
            label="Loading the logs"
            showLabel
          />
        )
      ) : (
        <>
          {logs.isError && (
            <ProblemBanner
              error={logs.error}
              title="Could not refresh the logs"
              onRetry={() => void logs.refetch()}
            />
          )}
          {data.items.length === 0 ? (
            <p className="muted">
              {total === 0 ? "No log lines yet." : "No lines on this page."}
            </p>
          ) : (
            <ol
              className="job-logs"
              aria-label="Log lines"
            >
              {data.items.map((line, index) => (
                <li
                  // Lines are positional; the number is their identity.
                  key={lineNumber(index)}
                  className="job-log-line"
                >
                  <span
                    className="job-log-number"
                    aria-hidden="true"
                  >
                    {lineNumber(index)}
                  </span>
                  <code className="job-log-text">{line}</code>
                </li>
              ))}
            </ol>
          )}
          <Pager
            label="Log pages"
            offset={view.offset}
            limit={view.limit}
            total={total}
            itemCount={data.items.length}
            hasMore={data.page.hasMore}
            pageSizes={LOG_PAGE_SIZES}
            maxPageSize={limits.maxLogPage}
            onChange={(next) => setView((current) => ({ ...current, ...next }))}
          />
          <p className="muted job-logs-total">
            {formatNumber(total)} {total === 1 ? "line" : "lines"} in all
          </p>
        </>
      )}
    </Card>
  );
}
