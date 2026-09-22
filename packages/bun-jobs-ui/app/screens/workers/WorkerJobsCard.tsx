import type { TimeRange } from "../../analytics/range";
import type { StateTab } from "../queues/jobFilters";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { describeRange } from "../../analytics/range";
import { RangePicker } from "../../analytics/RangePicker";
import { JOB_STATES } from "../../api/contract";
import { isSendableFilterValue, listJobs, queueKeys } from "../../api/queues";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { Pager } from "../../components/Pager";
import { Spinner } from "../../components/Spinner";
import { UrlTabs } from "../../components/Tabs";
import { useApiClient } from "../../context";
import { STATE_HINTS, STATE_LABELS } from "../../format";
import { useUrlTab } from "../../hooks/useUrlTab";
import {
  useCan,
  useFeature,
  useMeta,
  useUntargetedCanFn,
} from "../../meta/hooks";
import { ALL_STATES } from "../queues/jobFilters";
import { JobFiltersBar, JobRows } from "../queues/JobsTable";
import { refreshInterval } from "../queues/live";
import { useUrlParams } from "../queues/urlState";
import {
  rangeApplies,
  readFinishedRange,
  readWorkerJobFilters,
  WORKER_JOB_PARAMS,
  writeFinishedRange,
} from "./workerJobs";
import "../queues/queues.css";

/** The card's title: honest about what attribution records — the last attempt only. */
const TITLE = "Jobs whose last attempt this key ran";

/** Query parameters that restart paging when they change. */
const PAGING_PARAMS = [WORKER_JOB_PARAMS.offset] as const;

/** The state tabs, with no counts: nothing counts one key's jobs per state. */
const TABS = [
  { value: ALL_STATES as StateTab, label: "All" },
  ...JOB_STATES.map((state) => ({
    value: state as StateTab,
    label: STATE_LABELS[state],
    title: STATE_HINTS[state],
  })),
];

/** Props of {@link WorkerJobsCard}. */
export interface WorkerJobsCardProps {
  /** The queue the key's workers consume: the jobs listed are this queue's. */
  queue: string;
  /** The stable key whose jobs are listed: every instance's, not one incarnation's. */
  workerKey: string;
}

/**
 * The jobs whose **last** attempt a worker key ran
 * (`GET /queues/:queue/jobs?workerKey=<key>`), with the queue table's state
 * tabs, filters, rows and pager, over a `finishedOn` range that defaults to
 * the last 24 hours.
 *
 * Shown only where the backend records attribution
 * (`features.jobAttribution`): an API without it refuses the filters, so
 * nothing is read then. It needs `jobs.list` on the queue's answer. A key
 * holding a comma cannot be sent as one filter value (the API splits values
 * at commas), so for one the card says so instead of listing another key's
 * jobs.
 */
export function WorkerJobsCard({ queue, workerKey }: WorkerJobsCardProps) {
  const attribution = useFeature("jobAttribution");
  const canList = useCan("jobs.list");
  return (
    <Card title={TITLE}>
      <div data-testid="worker-jobs">
        {!attribution ? (
          <div data-testid="worker-jobs-unrecorded">
            <EmptyState
              title="Not recorded by this backend"
              description="This backend does not record which worker ran a job, so a worker's jobs cannot be listed."
            />
          </div>
        ) : !canList ? (
          <div data-testid="worker-jobs-hidden">
            <EmptyState
              title="Jobs hidden"
              description="You may not list this queue's jobs."
            />
          </div>
        ) : !isSendableFilterValue(workerKey) ? (
          <div data-testid="worker-jobs-unfilterable">
            <EmptyState
              title="Cannot be filtered to this key"
              description="The API splits every filter value at commas, and this key contains one, so the job list cannot be filtered to it."
            />
          </div>
        ) : (
          <WorkerJobsList
            queue={queue}
            workerKey={workerKey}
          />
        )}
      </div>
    </Card>
  );
}

/** The list itself, once the card has decided it may read. */
function WorkerJobsList({ queue, workerKey }: WorkerJobsCardProps) {
  const api = useApiClient();
  const meta = useMeta();
  // The job screen is routed with the Queues nav entry, which the untargeted
  // map decided; without it an id is plain text rather than a dead link.
  const linkJobs = useUntargetedCanFn()("queues.list");
  const [params, update] = useUrlParams();
  const tab = useUrlTab<StateTab>(WORKER_JOB_PARAMS.state, TABS, ALL_STATES);
  const filters = readWorkerJobFilters(params, tab, workerKey, meta.limits);
  const range = readFinishedRange(params.get(WORKER_JOB_PARAMS.finished));
  const ranged = rangeApplies(tab);

  const jobs = useQuery({
    queryKey: queueKeys.jobs(queue, filters),
    queryFn: ({ signal }) =>
      listJobs(api, queue, filters, signal, {
        attribution: meta.features.jobAttribution,
        // Newest added first on every tab where the backend sorts by
        // `createdAt`; otherwise no `sort` (the API would refuse it).
        createdOrder: meta.features.addedByState,
      }),
    // No queue event reaches this page, so it polls at the base interval.
    refetchInterval: refreshInterval("jobs"),
    placeholderData: keepPreviousData,
  });

  const setRange = (next: TimeRange) =>
    update({
      [WORKER_JOB_PARAMS.finished]: writeFinishedRange(next),
      [WORKER_JOB_PARAMS.offset]: null,
    });
  const selectionKey = JSON.stringify([
    filters.state,
    filters.order,
    filters.names,
    filters.search,
    ranged ? params.get(WORKER_JOB_PARAMS.finished) : null,
  ]);

  return (
    <section
      className="jobs-section"
      aria-label="Jobs this key ran"
    >
      <p
        className="muted"
        data-testid="worker-jobs-last-attempt"
      >
        Only a job&apos;s last attempt is recorded: a job that failed on another
        worker and then ran here is listed on this page alone.
      </p>
      <UrlTabs
        tabs={TABS}
        param={WORKER_JOB_PARAMS.state}
        defaultValue={ALL_STATES}
        resetParams={PAGING_PARAMS}
        label="Job states"
      />
      {ranged ? (
        <div data-testid="worker-jobs-range">
          <RangePicker
            range={range}
            onChange={setRange}
            label="Range these jobs finished in"
            maxSpan={null}
          />
          <p className="muted">
            {tab === ALL_STATES
              ? `Finished in: ${describeRange(range)}. Only a completed or dead job has a finish time, so a range lists those alone; choose Active for the jobs this key is running now.`
              : `Finished in: ${describeRange(range)}.`}
          </p>
        </div>
      ) : (
        <p
          className="muted"
          data-testid="worker-jobs-no-range"
        >
          {filters.state === null ? "These" : STATE_LABELS[filters.state]} jobs
          have not finished, so no date range applies to them: this lists every
          one whose last attempt this key ran, whenever that was.
        </p>
      )}
      <JobFiltersBar
        key={`${params.get(WORKER_JOB_PARAMS.name) ?? ""}|${filters.search}`}
        filters={filters}
        searchIndexed={meta.features.search}
        onApply={(patch) =>
          update({
            [WORKER_JOB_PARAMS.name]: patch.name,
            [WORKER_JOB_PARAMS.search]: patch.search,
            [WORKER_JOB_PARAMS.offset]: null,
          })
        }
        onOrder={(order) =>
          update({
            [WORKER_JOB_PARAMS.order]: order === "asc" ? "asc" : null,
            [WORKER_JOB_PARAMS.offset]: null,
          })
        }
      />
      {jobs.isPending ? (
        <Spinner
          label="Loading this key's jobs"
          showLabel
        />
      ) : jobs.isError ? (
        <ErrorView
          error={jobs.error}
          title="Could not load this key's jobs"
          onRetry={() => void jobs.refetch()}
        />
      ) : (
        <>
          <JobRows
            key={selectionKey}
            queue={queue}
            items={jobs.data.items}
            label={`Jobs whose last attempt ${workerKey} ran`}
            linkJobs={linkJobs}
            processedBy={false}
            empty={
              <div data-testid="worker-jobs-empty">
                <EmptyState
                  title="No jobs"
                  description="No job whose last attempt this key ran matches the state, range and filters. Which worker ran a job is kept only as long as the job itself: jobs removed on completion are not listed."
                />
              </div>
            }
          />
          <Pager
            label="Pages of this key's jobs"
            offset={filters.offset}
            limit={filters.limit}
            itemCount={jobs.data.items.length}
            hasMore={jobs.data.page.hasMore}
            maxPageSize={meta.limits.maxPageSize}
            disabled={jobs.isFetching && jobs.isPlaceholderData}
            onChange={(next) =>
              update({
                [WORKER_JOB_PARAMS.offset]:
                  next.offset > 0 ? String(next.offset) : null,
                [WORKER_JOB_PARAMS.limit]: String(next.limit),
              })
            }
          />
        </>
      )}
    </section>
  );
}
