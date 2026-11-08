import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
} from "../../../../api/contract";
import { getJobDefaults, jobDefaultsKey } from "../../../../api/jobDefaults";
import { Badge } from "../../../../components/Badge";
import { Button } from "../../../../components/Button";
import { KeyValue } from "../../../../components/KeyValue";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { RelativeTime } from "../../../../components/RelativeTime";
import { Spinner } from "../../../../components/Spinner";
import { Table } from "../../../../components/Table";
import { useApiClient } from "../../../../context";
import { formatNumber, STATE_LABELS } from "../../../../format";
import { formatMs } from "../../duration";
import { useRefreshInterval } from "../../live";
import { ApplyDefaultsDialog } from "./ApplyDefaultsDialog";
import { describeValue, KEY_TEXT } from "./draft";
import { JobDefaultsDialog } from "./JobDefaultsDialog";
import { CODE_SOURCE_HINT } from "./text";
import "./jobDefaults.css";

/** Props of {@link JobDefaultsPanel}. */
export interface JobDefaultsPanelProps {
  /** The queue. */
  queue: string;
  /** Whether Settings… is offered: mutation `queues.defaults`. */
  canEdit: boolean;
  /** Whether Apply to pending jobs… is offered: mutation `queues.applyDefaults`. Independent of `canEdit`. */
  canApply: boolean;
}

/** Which dialog is open. */
type OpenDialog = "settings" | "apply" | null;

/**
 * A queue's job defaults: a read-only table of every option — what a job
 * added now gets, what the code asks for, and the stored override — with the
 * jobs pending in the states the apply action rewrites, and, when permitted,
 * Settings… (edit) and Apply to N pending jobs… (a separate action).
 */
export function JobDefaultsPanel({
  queue,
  canEdit,
  canApply,
}: JobDefaultsPanelProps) {
  const api = useApiClient();
  const interval = useRefreshInterval("counts");
  const [open, setOpen] = useState<OpenDialog>(null);
  const read = useQuery({
    queryKey: jobDefaultsKey(queue),
    queryFn: ({ signal }) => getJobDefaults(api, queue, signal),
    // The pending counts move with the queue; the defaults themselves change
    // only by a save, after which the key is invalidated.
    refetchInterval: open === null ? interval : false,
  });
  // The dialog returns focus to the button that opened it.
  const close = () => setOpen(null);

  if (read.data === undefined) {
    return read.isError ? (
      <ProblemBanner
        error={read.error}
        title="Could not load the job defaults"
        onRetry={() => void read.refetch()}
      />
    ) : (
      <Spinner
        label="Loading the job defaults"
        showLabel
      />
    );
  }
  const defaults = read.data;
  const { total } = defaults.pending;
  const nothingOverridden = defaults.overridden.length === 0;

  return (
    <div
      className="job-defaults"
      data-testid="job-defaults-panel"
    >
      <p>
        What a job added to this queue gets for an option its <code>add()</code>{" "}
        does not pass. A stored override beats the code&rsquo;s defaults and{" "}
        <code>define()</code> defaults; only an option passed explicitly on{" "}
        <code>add()</code> wins. A change reaches producers within about{" "}
        {formatMs(defaults.propagationMs)}.
      </p>
      <Table label="Job defaults">
        <thead>
          <tr>
            <th scope="col">Option</th>
            <th scope="col">A job gets</th>
            <th scope="col">Code</th>
            <th scope="col">Override</th>
          </tr>
        </thead>
        <tbody>
          {JOB_DEFAULT_KEYS.map((key) => {
            const overridden = defaults.overridden.includes(key);
            return (
              <tr
                key={key}
                data-testid={`job-default-row-${key}`}
              >
                <th
                  scope="row"
                  title={KEY_TEXT[key].hint}
                >
                  {KEY_TEXT[key].label}
                </th>
                <td>{describeValue(key, defaults.effective[key])}</td>
                <td>{describeValue(key, defaults.code[key])}</td>
                <td>
                  {overridden ? (
                    <Badge tone="accent">Overridden</Badge>
                  ) : (
                    <span className="muted">code value</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <p className="muted job-defaults-note">
        {CODE_SOURCE_HINT}
        {defaults.updatedAt !== undefined && (
          <>
            {" "}
            Last changed <RelativeTime value={defaults.updatedAt} />.
          </>
        )}
      </p>
      <h3 className="job-defaults-heading">Pending jobs</h3>
      <KeyValue
        className="job-defaults-pending"
        items={[
          ...JOB_DEFAULTS_APPLY_STATES.map((state) => ({
            key: state,
            label: STATE_LABELS[state],
            value: formatNumber(defaults.pending[state]),
          })),
          { key: "total", label: "Total", value: formatNumber(total) },
        ]}
      />
      <p className="muted">
        Pending jobs keep the values they were added with: saving changes only
        jobs added afterwards. Applying the defaults to them is a separate
        action.
      </p>
      <div className="form-actions">
        {canEdit && (
          <Button onClick={() => setOpen("settings")}>Settings…</Button>
        )}
        {canApply && !nothingOverridden && total > 0 && (
          <Button
            variant="danger"
            onClick={() => setOpen("apply")}
          >
            Apply to {formatNumber(total)} pending{" "}
            {total === 1 ? "job" : "jobs"}…
          </Button>
        )}
      </div>
      {canApply && (nothingOverridden || total === 0) && (
        <p
          className="muted"
          data-testid="apply-unavailable"
        >
          {nothingOverridden
            ? "Nothing is overridden, so there is nothing to apply to pending jobs."
            : "No jobs are pending in the states the defaults can be applied to."}
        </p>
      )}
      {open === "settings" && (
        <JobDefaultsDialog
          queue={queue}
          defaults={defaults}
          onClose={close}
        />
      )}
      {open === "apply" && (
        <ApplyDefaultsDialog
          queue={queue}
          defaults={defaults}
          onClose={close}
        />
      )}
    </div>
  );
}
