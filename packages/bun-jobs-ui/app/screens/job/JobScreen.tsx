import type { SyntheticEvent } from "react";
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
import { formatNumber } from "../../format";
import { useCan, useFeature } from "../../meta/hooks";
import { Link } from "../../router";
import { useParams } from "../../routing";
import { ErrorDetails } from "./ErrorDetails";
import { JobActions } from "./JobActions";
import { JobFlow } from "./JobFlow";
import { JobLogs } from "./JobLogs";
import { jobRefetchInterval } from "./polling";
import "./job.css";

/** Whether an error means the job (or its queue) does not exist. */
function isNotFound(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "JOB_NOT_FOUND" || error.code === "QUEUE_NOT_FOUND")
  );
}

/** The job's progress: a JSON tree for an object, text otherwise. */
function ProgressValue({ progress }: { progress: unknown }) {
  if (progress === null || progress === undefined) {
    return null;
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
            <span className="job-name">{job.name}</span>
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

/** `/queues/:queue/jobs/:id`: one job, polled until it finishes. */
export function JobScreen() {
  const { queue = "", id = "" } = useParams<{ queue: string; id: string }>();
  const api = useApiClient();
  const job = useQuery({
    queryKey: jobKeys.job(queue, id),
    queryFn: ({ signal }) =>
      getJob(api, queue, id, DEFAULT_JOB_INCLUDE, signal),
    refetchInterval: (query) =>
      isNotFound(query.state.error)
        ? false
        : jobRefetchInterval(query.state.data?.state),
  });

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
