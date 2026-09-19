import type { SyntheticEvent } from "react";
import type { ApiError } from "../../api/errors";
import type { JobDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { isApiError } from "../../api/errors";
import {
  DEFAULT_JOB_INCLUDE,
  getJob,
  jobKeys,
  queueScreenPath,
} from "../../api/jobs";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { JsonView } from "../../components/JsonView";
import { KeyValue } from "../../components/KeyValue";
import { ProblemBanner } from "../../components/ProblemBanner";
import { RelativeTime } from "../../components/RelativeTime";
import { Spinner } from "../../components/Spinner";
import { StateBadge } from "../../components/StateBadge";
import { useApiClient } from "../../context";
import { displayText, formatNumber } from "../../format";
import { useCan, useFeature, usePermissionsSettled } from "../../meta/hooks";
import { Link } from "../../router";
import { useParams } from "../../routing";
import { ErrorDetails } from "./ErrorDetails";
import { JobActions } from "./JobActions";
import { JobFlow } from "./JobFlow";
import { JobLogs } from "./JobLogs";
import { useJobLive, useJobRefetchInterval } from "./polling";
import "./job.css";

/** Whether an error means the job (or its queue) does not exist. */
function isNotFound(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "JOB_NOT_FOUND" || error.code === "QUEUE_NOT_FOUND")
  );
}

/**
 * Whether an error means the caller may not read this job (401/403): the
 * host's `authorize` can decide per job, so the scoped permissions can say
 * yes while the request itself says no.
 */
function isDenied(error: unknown): error is ApiError {
  return isApiError(error) && error.isAuth;
}

/** A progress number as text: up to two decimals, in the browser's locale. */
const progressFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

/**
 * The bar's fill for a progress number: a percentage clamped to 0–100, since
 * a processor may report anything (and `NaN` fills nothing).
 */
function progressPercent(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

/**
 * The job's progress, as `updateProgress()` reports it: a number is a
 * percentage, shown as a bar with its value; a record is a JSON tree. A store
 * may hold anything, so any other value is shown as text.
 */
export function ProgressValue({ progress }: { progress: unknown }) {
  if (progress === null || progress === undefined) {
    return null;
  }
  if (typeof progress === "number") {
    const percent = progressPercent(progress);
    const text = `${progressFormat.format(progress)}%`;
    return (
      <span
        className="job-progress"
        data-testid="job-progress"
      >
        <span
          className="job-progress-bar"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={text}
        >
          <span
            className="job-progress-fill"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="job-progress-value">{text}</span>
      </span>
    );
  }
  if (typeof progress === "object") {
    return (
      <JsonView
        value={progress}
        label="Progress"
        expandDepth={1}
        copyable={false}
      />
    );
  }
  return <span>{String(progress)}</span>;
}

/** The job's state, attempts and timings. */
export function JobSummary({ job }: { job: JobDto }) {
  return (
    <KeyValue
      className="job-summary"
      items={[
        { label: "State", value: <StateBadge state={job.state} /> },
        { label: "Priority", value: formatNumber(job.priority) },
        {
          label: "Attempts",
          value: `${formatNumber(job.attemptsMade)} of ${formatNumber(job.maxAttempts)}`,
        },
        { label: "Stalled", value: formatNumber(job.stalledCount) },
        { label: "Run at", value: <RelativeTime value={job.runAt} /> },
        { label: "Created", value: <RelativeTime value={job.createdAt} /> },
        { label: "Processed", value: <RelativeTime value={job.processedOn} /> },
        { label: "Finished", value: <RelativeTime value={job.finishedOn} /> },
        { label: "Expires", value: <RelativeTime value={job.expiresAt} /> },
        {
          label: "Lock expires",
          value: <RelativeTime value={job.lockExpiresAt} />,
        },
        {
          label: "Worker",
          value: job.workerId ? <code>{job.workerId}</code> : null,
        },
        {
          label: "Repeat key",
          value: job.repeatKey ? <code>{job.repeatKey}</code> : null,
        },
        {
          label: "Progress",
          value: <ProgressValue progress={job.progress} />,
          key: "progress",
        },
      ]}
    />
  );
}

/** The failure history (`include=stacktrace`), fetched the first time its section opens. */
export function JobStacktraces({ queue, id }: { queue: string; id: string }) {
  const api = useApiClient();
  const [opened, setOpened] = useState(false);
  const traces = useQuery({
    queryKey: jobKeys.stacktrace(queue, id),
    queryFn: ({ signal }) => getJob(api, queue, id, ["stacktrace"], signal),
    enabled: opened,
  });
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) {
      setOpened(true);
    }
  };
  const items = traces.data?.stacktrace ?? [];
  return (
    <details
      className="job-details"
      onToggle={onToggle}
      data-testid="job-stacktraces"
    >
      <summary>Failure history (newest first)</summary>
      {!opened ? null : traces.isPending ? (
        <Spinner
          label="Loading the failure history"
          showLabel
        />
      ) : traces.isError ? (
        <ProblemBanner
          error={traces.error}
          title="Could not load the failure history"
          onRetry={() => void traces.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="muted">No failures were kept for this job.</p>
      ) : (
        <ol className="job-stacktraces">
          {items.map((trace, index) => (
            <li
              // Newest first; a trace has no identity beyond its position.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
            >
              <ErrorDetails
                error={trace}
                label={index === 0 ? "Newest failure" : `Failure ${index + 1}`}
              />
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/** Shown when the job, or its queue, does not exist. */
export function JobNotFound({ queue, id }: { queue: string; id: string }) {
  return (
    <div
      className="screen"
      data-testid="job-not-found"
    >
      <EmptyState
        headingLevel={1}
        title="Job not found"
        description={
          <>
            There is no job <code>{id}</code> in queue <code>{queue}</code>. It
            may have finished and been cleaned up, or been removed.
          </>
        }
        action={<Link to={queueScreenPath(queue)}>Back to {queue}</Link>}
      />
    </div>
  );
}

/** Props of {@link JobHidden}. */
export interface JobHiddenProps {
  /** The queue the job is in; the panel links back to it. */
  queue: string;
  /** The API's own explanation (a 401/403 problem's `detail`), shown instead of the default sentence. */
  detail?: string;
}

/** Shown when the caller may not read this queue's jobs (`jobs.read`), or the API refused this one. */
export function JobHidden({ queue, detail }: JobHiddenProps) {
  return (
    <div
      className="screen"
      data-testid="job-hidden"
    >
      <EmptyState
        headingLevel={1}
        title="Job hidden"
        description={
          detail ?? (
            <>
              You may not read the jobs of queue <code>{queue}</code>.
            </>
          )
        }
        action={<Link to={queueScreenPath(queue)}>Back to {queue}</Link>}
      />
    </div>
  );
}

/** The loaded job: header, actions and every section. */
function JobDetail({ job }: { job: JobDto }) {
  const canLogs = useCan("jobs.logs");
  const logsFeature = useFeature("logs");
  const showReturn =
    job.returnValue !== undefined &&
    (job.state === "completed" || job.returnValue !== null);
  return (
    <>
      <header className="job-header">
        <div className="job-heading">
          <h1 className="screen-title job-title">
            {/* Defence in depth: `getJob`'s shape guard already refuses a job
                whose name is not a string, so the "(invalid)" fallback is
                unreachable here. In practice only the unguarded list cells
                show it. */}
            <span className="job-name">{displayText(job.name)}</span>
            <StateBadge state={job.state} />
          </h1>
          <p className="job-id-line">
            <span className="muted">Id</span>
            <code
              className="job-id"
              data-testid="job-id"
            >
              {job.id}
            </code>
            <CopyButton
              text={job.id}
              ariaLabel="Copy job id"
              size="sm"
            />
          </p>
        </div>
        <JobActions job={job} />
      </header>

      <Card title="Summary">
        <JobSummary job={job} />
      </Card>

      {job.failedReason && (
        <Card title="Failure">
          <ErrorDetails
            error={job.failedReason}
            label="Failure"
          />
          <JobStacktraces
            queue={job.queue}
            id={job.id}
          />
        </Card>
      )}

      <Card title="Data">
        {job.data === undefined ? (
          <p className="muted">Not included in this response.</p>
        ) : (
          <JsonView
            value={job.data}
            label="Job data"
          />
        )}
      </Card>

      {showReturn && (
        <Card title="Return value">
          <JsonView
            value={job.returnValue}
            label="Return value"
          />
        </Card>
      )}

      {job.flow && <JobFlow job={job} />}

      {logsFeature && canLogs && (
        <JobLogs
          queue={job.queue}
          id={job.id}
          state={job.state}
        />
      )}

      {job.opts && (
        <Card title="Options">
          <JsonView
            value={job.opts}
            label="Job options"
            expandDepth={1}
          />
        </Card>
      )}
    </>
  );
}

/**
 * `/queues/:queue/jobs/:id`: one job, polled until it finishes. Needs
 * `jobs.read` for the queue, as the queue's own map answers it: the job is
 * not fetched until that map has loaded, and never without `jobs.read` (or
 * after a 401/403), so a host that refuses one queue's jobs is never asked
 * for one.
 */
export function JobScreen() {
  const { queue = "", id = "" } = useParams<{ queue: string; id: string }>();
  const api = useApiClient();
  // Scoped to the queue by the route's <QueuePermissionScope>. The job waits
  // for that map (`settled`), so an untargeted grant cannot send a read the
  // queue's own answer refuses; a later `false` also stops the polling.
  const canRead = useCan("jobs.read");
  const settled = usePermissionsSettled();
  const refetchInterval = useJobRefetchInterval();
  const job = useQuery({
    queryKey: jobKeys.job(queue, id),
    queryFn: ({ signal }) =>
      getJob(api, queue, id, DEFAULT_JOB_INCLUDE, signal),
    enabled: canRead && settled,
    refetchInterval: (query) =>
      isNotFound(query.state.error) || isDenied(query.state.error)
        ? false
        : refetchInterval(query.state.data?.state),
  });
  // Subscribes once the queue's map allows the read, and stops when the job
  // turns out to be refused or gone.
  useJobLive(
    queue,
    id,
    canRead && settled && !isDenied(job.error) && !isNotFound(job.error),
  );

  if (settled && !canRead) {
    return <JobHidden queue={queue} />;
  }
  if (isDenied(job.error)) {
    return (
      <JobHidden
        queue={queue}
        detail={job.error.detail}
      />
    );
  }
  if (isNotFound(job.error)) {
    return (
      <JobNotFound
        queue={queue}
        id={id}
      />
    );
  }
  return (
    <div
      className="screen job-screen"
      data-testid="job-screen"
    >
      <nav
        className="breadcrumb"
        aria-label="Breadcrumb"
      >
        <ol>
          <li>
            <Link to="/queues">Queues</Link>
          </li>
          <li>
            <Link to={queueScreenPath(queue)}>{queue}</Link>
          </li>
          <li aria-current="page">Job</li>
        </ol>
      </nav>
      {job.data ? (
        <>
          {job.isError && (
            <ProblemBanner
              error={job.error}
              title="Could not refresh this job"
              onRetry={() => void job.refetch()}
            />
          )}
          <JobDetail job={job.data} />
        </>
      ) : job.isError ? (
        <ErrorView
          error={job.error}
          headingLevel={1}
          title="Could not load the job"
          onRetry={() => void job.refetch()}
        />
      ) : (
        <Spinner
          label="Loading the job"
          showLabel
        />
      )}
    </div>
  );
}
