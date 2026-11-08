import type { ChildDto, JobDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { getJobChildren, jobKeys, jobScreenPath } from "../../api/jobs";
import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { JsonView } from "../../components/JsonView";
import { ProblemBanner } from "../../components/ProblemBanner";
import { Spinner } from "../../components/Spinner";
import { StateBadge } from "../../components/StateBadge";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { formatNumber, plural } from "../../format";
import { Link } from "../../router";
import { ErrorDetails } from "./ErrorDetails";
import { jobRefetchInterval } from "./polling";

/** A link to another job's screen, showing `queue / id`. */
function JobRefLink({ queue, id }: { queue: string; id: string }) {
  return (
    <Link
      to={jobScreenPath(queue, id)}
      className="job-ref"
    >
      <span className="muted">{queue}</span> / <code>{id}</code>
    </Link>
  );
}

/** A child's outcome: its recorded value, its ignored failure, or nothing yet. */
function ChildOutcome({ child }: { child: ChildDto }) {
  if (child.failure) {
    return (
      <ErrorDetails
        error={child.failure}
        label={`Failure of ${child.id}`}
      />
    );
  }
  if (child.value !== undefined) {
    return (
      <JsonView
        value={child.value}
        label={`Value of ${child.id}`}
        expandDepth={1}
      />
    );
  }
  return <span className="muted">—</span>;
}

/** The children table, from `GET …/children`. */
function FlowChildren({ job }: { job: JobDto }) {
  const api = useApiClient();
  const children = useQuery({
    queryKey: jobKeys.children(job.queue, job.id),
    queryFn: ({ signal }) => getJobChildren(api, job.queue, job.id, signal),
    refetchInterval: jobRefetchInterval(job.state),
  });
  if (children.isPending) {
    return (
      <Spinner
        label="Loading the children"
        showLabel
      />
    );
  }
  if (children.isError) {
    return (
      <ProblemBanner
        error={children.error}
        title="Could not load the children"
        onRetry={() => void children.refetch()}
      />
    );
  }
  const data = children.data;
  return (
    <>
      <Table label="Children">
        <thead>
          <tr>
            <th scope="col">Child</th>
            <th scope="col">State</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {data.children.map((child) => (
            <tr
              key={`${child.queue}:${child.id}`}
              data-testid={`flow-child-${child.queue}:${child.id}`}
            >
              <th scope="row">
                <JobRefLink
                  queue={child.queue}
                  id={child.id}
                />
              </th>
              <td>
                {child.job ? (
                  <StateBadge state={child.job.state} />
                ) : (
                  <Badge
                    tone="warning"
                    title="The child is gone, or in a queue this API cannot reach"
                  >
                    unreachable
                  </Badge>
                )}
              </td>
              <td>
                <ChildOutcome child={child} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {data.truncated && (
        <p
          className="notice"
          role="note"
          data-testid="flow-truncated"
        >
          Showing the first {plural(data.children.length, "child", "children")}:
          this job has more than the API lists at once.
        </p>
      )}
    </>
  );
}

/** A job's place in a flow: its parent, pending count and children. */
export function JobFlow({ job }: { job: JobDto }) {
  const flow = job.flow;
  if (!flow) {
    return null;
  }
  return (
    <Card title="Flow">
      <dl className="kv kv-grid job-flow-summary">
        <div className="kv-row">
          <dt className="kv-label">Parent</dt>
          <dd className="kv-value">
            {flow.parent ? (
              <JobRefLink
                queue={flow.parent.queue}
                id={flow.parent.id}
              />
            ) : (
              <span className="muted">None: this is the root</span>
            )}
          </dd>
        </div>
        <div className="kv-row">
          <dt className="kv-label">Pending children</dt>
          <dd className="kv-value">{formatNumber(flow.pending)}</dd>
        </div>
      </dl>
      {flow.children.length > 0 ? (
        <FlowChildren job={job} />
      ) : (
        <p className="muted">This job has no children.</p>
      )}
    </Card>
  );
}
