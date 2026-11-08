import type { RunRecordDto } from "../../api/types";
import { hasRunLogs } from "../../api/runnerLogs";
import { Button } from "../../components/Button";
import { useUrlParams } from "../queues/urlState";
import { LOGS_PARAM } from "./runLogFormat";
import { useCanReadRunLogs } from "./runLogGates";
import { RunLogs } from "./RunLogs";

/** Props of {@link RunLogsSection}. */
export interface RunLogsSectionProps {
  /** The run whose log this is. */
  run: RunRecordDto;
}

/**
 * A run's log inside its details: a disclosure that reads nothing until it
 * is opened, and states what this run has instead when there is nothing to
 * open.
 *
 * Which run's log is open lives in the URL (`logs=<runId>`), so a link
 * reproduces the view and the run history's own Logs button opens the same
 * thing.
 */
export function RunLogsSection({ run }: RunLogsSectionProps) {
  const canRead = useCanReadRunLogs();
  const [params, update] = useUrlParams();
  const open = params.get(LOGS_PARAM) === run.runId;
  if (!canRead) {
    return null;
  }
  if (!hasRunLogs(run)) {
    // The only way here is a finished run whose record says `logLines: 0`:
    // its log is kept and empty. A record with no `logLines` at all says
    // nothing, so its log is offered and the read answers for it.
    return (
      <p
        className="muted run-log-section"
        data-testid={`run-no-logs-${run.runId}`}
      >
        This run logged nothing.
      </p>
    );
  }
  return (
    <div className="run-log-section">
      <Button
        size="sm"
        aria-expanded={open}
        onClick={() => update({ [LOGS_PARAM]: open ? null : run.runId })}
      >
        {open ? "Hide log" : "Show log"}
      </Button>
      {open && (
        <RunLogs
          runner={run.runnerId}
          runId={run.runId}
        />
      )}
    </div>
  );
}
