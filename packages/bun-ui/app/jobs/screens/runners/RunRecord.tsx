import type { RunRecordDto } from "../../api/types";
import { Badge } from "../../components/Badge";
import { CopyButton } from "../../components/CopyButton";
import { JsonView } from "../../components/JsonView";
import { KeyValue } from "../../components/KeyValue";
import { RelativeTime } from "../../components/RelativeTime";
import { formatNumber } from "../../format";
import { ErrorDetails } from "../job/ErrorDetails";
import { RUN_SOURCE, RUN_STATUS, runDuration } from "./runnerFormat";

/** Props of {@link RunStatusBadge}. */
export interface RunStatusBadgeProps {
  /** The run's status. */
  status: RunRecordDto["status"];
}

/** A run's outcome, colour-coded. */
export function RunStatusBadge({ status }: RunStatusBadgeProps) {
  const { label, tone } = RUN_STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}

/** Props of {@link RunRecordDetails}. */
export interface RunRecordDetailsProps {
  /** The run. */
  run: RunRecordDto;
}

/** Everything a run recorded: ids, timings, the process's exit, the error and the result. */
export function RunRecordDetails({ run }: RunRecordDetailsProps) {
  const where =
    run.host === undefined && run.pid === undefined
      ? null
      : [run.host, run.pid === undefined ? undefined : `pid ${run.pid}`]
          .filter(Boolean)
          .join(", ");
  return (
    <div
      className="run-record"
      data-testid={`run-${run.runId}`}
    >
      <KeyValue
        className="run-summary"
        items={[
          {
            label: "Run id",
            value: (
              <span className="run-id-line">
                <code>{run.runId}</code>
                <CopyButton
                  text={run.runId}
                  ariaLabel={`Copy run id ${run.runId}`}
                />
              </span>
            ),
          },
          { label: "Status", value: <RunStatusBadge status={run.status} /> },
          { label: "Attempt", value: formatNumber(run.attempt) },
          { label: "Source", value: RUN_SOURCE[run.source] },
          { label: "Execution", value: run.mode },
          where !== null && { label: "Where", value: where },
          { label: "Started", value: <RelativeTime value={run.startedAt} /> },
          {
            label: "Finished",
            value:
              run.finishedAt === undefined ? null : (
                <RelativeTime value={run.finishedAt} />
              ),
          },
          { label: "Duration", value: runDuration(run) },
          run.exitCode !== undefined && {
            label: "Exit code",
            value: run.exitCode === null ? null : String(run.exitCode),
          },
          run.signal !== undefined && {
            label: "Signal",
            value: run.signal,
          },
          run.detached !== undefined && {
            label: "Detached",
            value: run.detached ? "Yes: it outlived its owner" : "No",
          },
        ]}
      />
      {run.error && (
        <ErrorDetails
          error={run.error}
          label={`Error of run ${run.runId}`}
        />
      )}
      {run.result !== undefined && (
        <JsonView
          value={run.result}
          label={`Result of run ${run.runId}`}
          expandDepth={1}
        />
      )}
    </div>
  );
}
