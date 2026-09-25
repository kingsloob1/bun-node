import type { FormEvent, ReactNode } from "react";
import type { JobListFilters } from "../../api/queues";
import type {
  BulkPromoteResultDto,
  BulkRemoveResultDto,
  BulkRetryResultDto,
  JobCountsDto,
  JobDto,
  JobWorkerDto,
} from "../../api/types";
import type { StateTab } from "./jobFilters";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { JOB_STATES } from "../../api/contract";
import {
  bulkPromote,
  bulkRemove,
  bulkRetry,
  jobPath,
  listJobs,
  mutationInvalidations,
  queueKeys,
  sortsByCreation,
} from "../../api/queues";
import { workerPath } from "../../api/workers";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CopyButton } from "../../components/CopyButton";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { Checkbox, Select, TextInput } from "../../components/inputs";
import { Pager } from "../../components/Pager";
import { RelativeTime } from "../../components/RelativeTime";
import { Spinner } from "../../components/Spinner";
import { StateBadge } from "../../components/StateBadge";
import { Table } from "../../components/Table";
import { UrlTabs } from "../../components/Tabs";
import { useToast } from "../../components/toast";
import { useApiClient } from "../../context";
import {
  displayText,
  formatNumber,
  plural,
  STATE_HINTS,
  STATE_LABELS,
} from "../../format";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useUrlTab } from "../../hooks/useUrlTab";
import { SEARCH_SHORTCUT } from "../../layout/shortcuts";
import { useMeta } from "../../meta/hooks";
import { Link } from "../../router";
import { useWorkerPagesRouted } from "../workers/routed";
import { useCanMutate } from "./gating";
import {
  ALL_STATES,
  FAILURE_PREVIEW_CHARS,
  readJobFilters,
  truncate,
} from "./jobFilters";
import { useJobWalk } from "./jobWalk";
import { useRefreshInterval } from "./live";
import { listIds } from "./queueFormat";
import { splitList, useUrlParams } from "./urlState";

/** Query parameters that restart paging when they change. */
const PAGING_PARAMS = ["offset"] as const;

/**
 * What walking this tab by cursor does and does not show, put on Previous and
 * Next while they walk.
 *
 * Both sentences are true of every tab; the Waiting one names promotion
 * because that is the tab a promoted job **arrives** on, and the queue
 * screen's own Promote selected is what puts it there. A job that leaves the
 * states being walked is missed by every paging scheme there is — nothing can
 * show a row that is no longer there — but a job that *joins* behind the point
 * a walk has reached is missed silently, which is the one thing the cursor
 * costs that the offset did not.
 */
function walkHint(tab: StateTab): string {
  return tab === "waiting"
    ? "Walks from where this page ended, so no waiting job is skipped by the queue draining. A job promoted or retried into the queue while you page can land behind this point, and is then not on any page of this walk."
    : "Walks from where this page ended, so no job is skipped by the list changing under you. A job that joins these states behind the point you have reached is not on any page of this walk.";
}

/** Props of {@link JobsTable}. */
export interface JobsTableProps {
  /** The queue listed. */
  queue: string;
  /** Counts per state for the tabs, when loaded. */
  counts: JobCountsDto | undefined;
}

/**
 * The queue's jobs: state tabs with counts, filters, the table, paging and
 * bulk actions. Every filter lives in the URL; changing the tab or a filter
 * restarts paging and clears the selection.
 */
export function JobsTable({ queue, counts }: JobsTableProps) {
  const api = useApiClient();
  const meta = useMeta();
  const [params, update] = useUrlParams();
  const tabs = [
    {
      value: ALL_STATES as StateTab,
      label: "All",
      count: counts
        ? JOB_STATES.reduce((sum, state) => sum + counts[state], 0)
        : undefined,
    },
    ...JOB_STATES.map((state) => ({
      value: state as StateTab,
      label: STATE_LABELS[state],
      title: STATE_HINTS[state],
      count: counts?.[state],
    })),
  ];
  const tab = useUrlTab<StateTab>("state", tabs, ALL_STATES);
  const createdOrder = meta.features.addedByState;
  const start = readJobFilters(params, tab, meta.limits);
  // Every parameter a cursor is bound to (the queue, the states, the sort and
  // the order), plus the filters and the offset the walk started from: change
  // one and this is a different walk, so its cursors are gone before the next
  // request goes out. The page size is deliberately not here — see
  // {@link useJobWalk}.
  const walk = useJobWalk(
    JSON.stringify([
      queue,
      start.state,
      start.offset,
      start.order,
      start.names,
      start.search,
      start.total,
      sortsByCreation(start, createdOrder),
    ]),
  );
  const filters = readJobFilters(params, tab, meta.limits, walk.cursor);
  const refetchInterval = useRefreshInterval("jobs");

  const jobs = useQuery({
    queryKey: queueKeys.jobs(queue, filters),
    // Newest added first on every tab where the backend can sort by
    // `createdAt`; elsewhere each tab's natural order (the flag's absence
    // means the API refuses `sort=createdAt`).
    queryFn: ({ signal }) =>
      listJobs(api, queue, filters, signal, { createdOrder }),
    refetchInterval,
    placeholderData: keepPreviousData,
  });

  // The selection belongs to one filter set; a new set starts empty.
  const selectionKey = JSON.stringify([
    filters.state,
    filters.order,
    filters.names,
    filters.search,
  ]);

  return (
    <section
      className="jobs-section"
      aria-label="Jobs"
    >
      <UrlTabs
        tabs={tabs}
        param="state"
        defaultValue={ALL_STATES}
        resetParams={PAGING_PARAMS}
        label="Job states"
      />
      <JobFiltersBar
        key={`${params.get("name") ?? ""}|${filters.search}`}
        filters={filters}
        searchIndexed={meta.features.search}
        createdOrder={meta.features.addedByState}
        onApply={(patch) => update({ ...patch, offset: null })}
        onOrder={(order) =>
          update({ order: order === "asc" ? "asc" : null, offset: null })
        }
        onTotal={(total) => update({ total: total ? "1" : null })}
      />
      {jobs.isPending ? (
        <Spinner
          label="Loading jobs"
          showLabel
        />
      ) : jobs.isError ? (
        <ErrorView
          error={jobs.error}
          title="Could not load jobs"
          onRetry={() => void jobs.refetch()}
        />
      ) : (
        <>
          <JobRows
            key={selectionKey}
            queue={queue}
            items={jobs.data.items}
          />
          <Pager
            label="Job pages"
            // Where the API says the page sits, which on a walked page is
            // where the seek landed. Absent only on a walked page whose
            // backend did not count what precedes it (SQL and MongoDB, so
            // that a walk does not cost what the offset cost): `unnumbered`
            // then tells the pager to count the rows rather than number them.
            offset={jobs.data.page.offset ?? filters.offset}
            limit={filters.limit}
            total={jobs.data.page.total}
            itemCount={jobs.data.items.length}
            hasMore={jobs.data.page.hasMore}
            walk={{
              // The API mints `page.next` on every page it can be walked on,
              // offset pages included, and on none it cannot — the Active tab
              // alone, whose order every lock renewal rewrites. So the
              // presence of a cursor is the whole rule, and that tab keeps
              // the offset pager it has always had.
              canNext: typeof jobs.data.page.next === "string",
              canPrev: walk.canPrev,
              // Read from the page shown, not from the walk being asked for:
              // while a move is in flight the rows are still the previous
              // page's, and a range numbered from the new request would
              // number the wrong rows. Only a walked page omits its offset.
              unnumbered: jobs.data.page.offset === undefined,
              hint: walkHint(tab),
            }}
            maxPageSize={meta.limits.maxPageSize}
            disabled={jobs.isFetching && jobs.isPlaceholderData}
            onChange={(next) => {
              const cursor = jobs.data.page.next;
              if (next.step === "next" && typeof cursor === "string") {
                walk.forward(cursor);
                return;
              }
              if (next.step === "prev") {
                walk.back();
                return;
              }
              // Resizing keeps the walk: the cursor that produced this page
              // is re-sent with the new size, so the page keeps its first
              // row. Every other move is a jump, which abandons the walk —
              // an offset and a cursor cannot both decide where a page
              // starts, and the API ignores the offset when both are sent.
              if (next.resize === true && walk.cursor !== undefined) {
                update({ limit: String(next.limit) });
                return;
              }
              walk.reset();
              update({
                offset: next.offset > 0 ? String(next.offset) : null,
                limit: String(next.limit),
              });
            }}
          />
        </>
      )}
    </section>
  );
}

/** Props of {@link JobFiltersBar}. */
export interface JobFiltersBarProps {
  /** The filters in effect. */
  filters: JobListFilters;
  /** Whether the backend searches with an index (else the API scans). */
  searchIndexed: boolean;
  /**
   * Whether pages are sorted by creation time on every tab
   * (`features.addedByState`). With it on, the "Count total" toggle says that
   * a counted page keeps the tab's natural order instead. Defaults to `false`.
   */
  createdOrder?: boolean;
  /** Applies the name and search filters. */
  onApply: (patch: { name: string | null; search: string | null }) => void;
  /** Changes the order. */
  onOrder: (order: "asc" | "desc") => void;
  /**
   * Turns counting the total on or off. Omit it and the "Count total" toggle
   * is not offered (a worker page never counts: its range is what keeps the
   * read fast).
   */
  onTotal?: (total: boolean) => void;
}

/**
 * The name filter, the id/name search, the order and the total toggle. The
 * queue's jobs table and a worker page's jobs section share it.
 */
export function JobFiltersBar({
  filters,
  searchIndexed,
  createdOrder = false,
  onApply,
  onOrder,
  onTotal,
}: JobFiltersBarProps) {
  const [names, setNames] = useState(filters.names.join(", "));
  const [search, setSearch] = useState(filters.search);
  const nameId = useId();
  const searchId = useId();
  const orderId = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const list = splitList(names);
    onApply({
      name: list.length > 0 ? list.join(",") : null,
      search: search.trim() || null,
    });
  };
  return (
    <form
      className="jobs-filters"
      role="search"
      aria-label="Filter jobs"
      onSubmit={submit}
    >
      <span className="jobs-filter">
        <label htmlFor={nameId}>Names</label>
        <TextInput
          id={nameId}
          value={names}
          onChange={setNames}
          placeholder="exact, comma-separated"
          maxLength={2000}
        />
      </span>
      <span className="jobs-filter">
        <label htmlFor={searchId}>Search</label>
        <TextInput
          id={searchId}
          type="search"
          value={search}
          onChange={setSearch}
          placeholder="id or name contains"
          {...SEARCH_SHORTCUT}
          maxLength={512}
          title={
            searchIndexed
              ? undefined
              : "This backend has no search index: the API scans the queue."
          }
        />
      </span>
      <Button
        type="submit"
        size="sm"
      >
        Apply
      </Button>
      <span className="jobs-filter">
        <label htmlFor={orderId}>Order</label>
        <Select
          id={orderId}
          options={[
            { value: "desc", label: "Newest first" },
            { value: "asc", label: "Oldest first" },
          ]}
          value={filters.order}
          onChange={onOrder}
        />
      </span>
      {onTotal && (
        <Checkbox
          checked={filters.total}
          onChange={onTotal}
          label="Count total"
          hint={
            createdOrder && filters.total
              ? "While counting, a one-state tab keeps its own order, not creation order."
              : undefined
          }
          className="jobs-total"
        />
      )}
    </form>
  );
}

/** Props of {@link JobRows}. */
export interface JobRowsProps {
  /** The queue listed. */
  queue: string;
  /** The page's jobs. */
  items: readonly JobDto[];
  /** The table's accessible name. Defaults to "Jobs in <queue>". */
  label?: string;
  /**
   * Whether each id links to its job screen. Defaults to `true`; pass
   * `false` where the job screen is not routed (no Queues nav entry).
   */
  linkJobs?: boolean;
  /** What an empty page shows. Defaults to "No jobs" for the queue's filters. */
  empty?: ReactNode;
  /**
   * Whether to offer the "Processed by" column (`JobDto.processedBy`, the
   * worker that ran each job's last attempt). Defaults to `true`; it shows
   * only where `features.jobAttribution` is also true. A worker page passes
   * `false`: every row there names that page's own key.
   */
  processedBy?: boolean;
}

/** Which bulk confirmation is open. */
type BulkDialog = "remove" | null;

/**
 * The table, its selection, and the bulk actions over it. The queue's jobs
 * table and a worker page's jobs section share it.
 */
export function JobRows({
  queue,
  items,
  label,
  linkJobs = true,
  empty,
  processedBy = true,
}: JobRowsProps) {
  const api = useApiClient();
  const meta = useMeta();
  const workersRouted = useWorkerPagesRouted();
  const showProcessedBy = processedBy && meta.features.jobAttribution;
  const toast = useToast();
  const canMutate = useCanMutate();
  const max = meta.limits.maxBulkIds;
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [resetAttempts, setResetAttempts] = useState(true);
  const [dialog, setDialog] = useState<BulkDialog>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const bulkBarRef = useRef<HTMLDivElement>(null);

  const canRetry = canMutate("jobs.retry");
  const canRemove = canMutate("jobs.remove");
  const canPromote = canMutate("jobs.promote");
  const bulk = canRetry || canRemove || canPromote;

  const pageIds = items.map((job) => job.id);
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
  const allOnPage = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const atCap = selected.size >= max;

  // A bulk action that succeeds empties the selection, which disables the
  // button that had focus (and a dialog returns focus to it in vain): keep
  // keyboard users in the bulk bar instead of dropping them to <body>.
  const hadSelectionRef = useRef(false);
  useEffect(() => {
    if (selected.size > 0 || dialog !== null) {
      hadSelectionRef.current = true;
      return;
    }
    if (!hadSelectionRef.current) {
      return;
    }
    hadSelectionRef.current = false;
    const active = document.activeElement;
    const lost =
      active === null ||
      active === document.body ||
      (active instanceof HTMLButtonElement &&
        active.disabled &&
        bulkBarRef.current?.contains(active) === true);
    if (lost) {
      bulkBarRef.current?.focus();
    }
  }, [selected, dialog]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedOnPage > 0 && !allOnPage;
    }
  }, [selectedOnPage, allOnPage]);

  const toggle = (id: string, on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on && next.size < max) {
        next.add(id);
      } else if (!on) {
        next.delete(id);
      }
      return next;
    });
  };
  const toggleAll = (on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of pageIds) {
        if (!on) {
          next.delete(id);
        } else if (next.size < max) {
          next.add(id);
        }
      }
      return next;
    });
  };

  /** Toasts a bulk result: the done count, the skipped count and (capped) ids. */
  const report = (
    verb: string,
    done: readonly string[],
    skipped: readonly string[],
  ) => {
    toast.success(
      `${verb} ${formatNumber(done.length)}, skipped ${formatNumber(skipped.length)}`,
      {
        description:
          skipped.length > 0 ? `Skipped: ${listIds(skipped)}` : undefined,
      },
    );
    setSelected(new Set());
  };
  const invalidate = mutationInvalidations(queue);
  const retry = useApiMutation({
    mutationFn: (ids: string[]) => bulkRetry(api, queue, ids, resetAttempts),
    onSuccess: (result: BulkRetryResultDto) =>
      report("Retried", result.retried, result.skipped),
    errorTitle: "Could not retry the jobs",
    invalidate,
  });
  const promote = useApiMutation({
    mutationFn: (ids: string[]) => bulkPromote(api, queue, ids),
    onSuccess: (result: BulkPromoteResultDto) =>
      report("Promoted", result.promoted, result.skipped),
    errorTitle: "Could not promote the jobs",
    invalidate,
  });
  const remove = useApiMutation({
    mutationFn: (ids: string[]) => bulkRemove(api, queue, ids),
    onSuccess: (result: BulkRemoveResultDto) =>
      report("Removed", result.removed, result.skipped),
    invalidate,
    toastErrors: false,
  });
  const busy = retry.isPending || promote.isPending || remove.isPending;
  const ids = [...selected];

  if (items.length === 0) {
    return (
      empty ?? (
        <EmptyState
          title="No jobs"
          description="No job in this queue matches the state and filters."
        />
      )
    );
  }

  return (
    <>
      {bulk && (
        <div
          ref={bulkBarRef}
          className="bulk-bar"
          role="group"
          tabIndex={-1}
          aria-label="Bulk actions"
        >
          <span
            className="bulk-count"
            aria-live="polite"
            data-testid="bulk-count"
          >
            {plural(selected.size, "job")} selected
            {atCap && ` (the most one action takes: ${formatNumber(max)})`}
          </span>
          {canRetry && (
            <>
              <Checkbox
                checked={resetAttempts}
                onChange={setResetAttempts}
                label="Reset attempts"
              />
              <Button
                size="sm"
                disabled={selected.size === 0 || busy}
                onClick={() => retry.mutate(ids)}
              >
                Retry selected
              </Button>
            </>
          )}
          {canPromote && (
            <Button
              size="sm"
              disabled={selected.size === 0 || busy}
              onClick={() => promote.mutate(ids)}
            >
              Promote selected
            </Button>
          )}
          {canRemove && (
            <Button
              size="sm"
              variant="danger"
              disabled={selected.size === 0 || busy}
              onClick={() => setDialog("remove")}
            >
              Remove selected…
            </Button>
          )}
          {selected.size > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </Button>
          )}
        </div>
      )}
      <Table label={label ?? `Jobs in ${queue}`}>
        <thead>
          <tr>
            {bulk && (
              <th
                scope="col"
                className="select-cell"
              >
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="Select all jobs on this page"
                  checked={allOnPage}
                  disabled={!allOnPage && atCap}
                  onChange={(event) => toggleAll(event.target.checked)}
                />
              </th>
            )}
            <th scope="col">Id</th>
            <th scope="col">Name</th>
            <th scope="col">State</th>
            <th
              scope="col"
              className="num"
            >
              Attempts
            </th>
            <th
              scope="col"
              className="num"
            >
              Priority
            </th>
            <th scope="col">Created</th>
            <th scope="col">Processed</th>
            {showProcessedBy && (
              <th
                scope="col"
                className="job-processed-by-col"
                title="The worker that ran the job's last attempt"
                data-testid="jobs-processed-by-header"
              >
                Processed by
              </th>
            )}
            <th scope="col">Finished</th>
            <th scope="col">Failure</th>
          </tr>
        </thead>
        <tbody>
          {items.map((job) => {
            const checked = selected.has(job.id);
            const failure = job.failedReason?.message;
            return (
              <tr
                key={job.id}
                data-testid={`job-row-${job.id}`}
                aria-selected={bulk ? checked : undefined}
              >
                {bulk && (
                  <td className="select-cell">
                    <input
                      type="checkbox"
                      aria-label={`Select job ${job.id}`}
                      checked={checked}
                      disabled={!checked && atCap}
                      onChange={(event) => toggle(job.id, event.target.checked)}
                    />
                  </td>
                )}
                <th
                  scope="row"
                  className="job-id"
                >
                  {linkJobs ? (
                    <Link to={jobPath(queue, job.id)}>{job.id}</Link>
                  ) : (
                    job.id
                  )}
                  <CopyButton
                    text={job.id}
                    label="Copy"
                    ariaLabel={`Copy job id ${job.id}`}
                  />
                </th>
                <td>{displayText(job.name)}</td>
                <td>
                  <StateBadge state={job.state} />
                </td>
                <td className="num">
                  {formatNumber(job.attemptsMade)}/
                  {formatNumber(job.maxAttempts)}
                </td>
                <td className="num">{formatNumber(job.priority)}</td>
                <td>
                  <RelativeTime value={job.createdAt} />
                </td>
                <td>
                  <RelativeTime value={job.processedOn} />
                </td>
                {showProcessedBy && (
                  <ProcessedByCell
                    queue={queue}
                    worker={job.processedBy}
                    linked={workersRouted}
                  />
                )}
                <td>
                  <RelativeTime value={job.finishedOn} />
                </td>
                <td
                  className="job-failure"
                  title={failure}
                >
                  {failure ? truncate(failure, FAILURE_PREVIEW_CHARS) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <ConfirmDialog
        open={dialog === "remove"}
        onClose={() => setDialog(null)}
        title={`Remove ${plural(ids.length, "job")}?`}
        description="Removes the selected jobs for good. Running jobs are skipped."
        variant="danger"
        confirmLabel="Remove"
        pendingLabel="Removing…"
        onConfirm={() => remove.mutateAsync(ids)}
      />
    </>
  );
}

/** Props of {@link ProcessedByCell}. */
interface ProcessedByCellProps {
  /** The job's queue: a worker page is addressed by it and the key. */
  queue: string;
  /** `JobDto.processedBy`: the worker that ran the last attempt, or `null` when none is recorded. */
  worker: JobWorkerDto | null;
  /** Whether the key links to its worker page (the Workers pages are routed for this caller). */
  linked: boolean;
}

/**
 * One job's "Processed by" cell: the stable key (linked to its worker page
 * when those are routed), the incarnation id as plain text when only the id
 * was recorded, and "—" when no worker is.
 */
function ProcessedByCell({ queue, worker, linked }: ProcessedByCellProps) {
  if (worker === null) {
    return (
      <td
        className="job-processed-by-col muted"
        title="No worker recorded: the job was never claimed, or was claimed before this backend recorded who ran a job."
        data-testid="jobs-processed-by-none"
      >
        —
      </td>
    );
  }
  if (worker.key === undefined) {
    return (
      <td
        className="job-processed-by-col"
        title={`Worker incarnation ${worker.id} (no stable key recorded)`}
      >
        <code
          className="job-processed-by-text"
          data-testid="jobs-processed-by-id"
        >
          {worker.id}
        </code>
      </td>
    );
  }
  return (
    <td
      className="job-processed-by-col"
      title={`${worker.key} (incarnation ${worker.id})`}
    >
      {linked ? (
        <Link
          to={workerPath(queue, worker.key)}
          className="job-processed-by-text"
          data-testid="jobs-processed-by-key"
        >
          {worker.key}
        </Link>
      ) : (
        <span
          className="job-processed-by-text"
          data-testid="jobs-processed-by-key"
        >
          {worker.key}
        </span>
      )}
    </td>
  );
}
