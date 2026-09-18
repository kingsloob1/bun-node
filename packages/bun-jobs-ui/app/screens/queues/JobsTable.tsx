import type { FormEvent } from "react";
import type { JobListFilters } from "../../api/queues";
import type {
  BulkPromoteResultDto,
  BulkRemoveResultDto,
  BulkRetryResultDto,
  JobCountsDto,
  JobDto,
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
} from "../../api/queues";
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
import { formatNumber, plural, STATE_LABELS } from "../../format";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useUrlTab } from "../../hooks/useUrlTab";
import { useMeta } from "../../meta/hooks";
import { Link } from "../../router";
import { useCanMutate } from "./gating";
import {
  ALL_STATES,
  FAILURE_PREVIEW_CHARS,
  readJobFilters,
  truncate,
} from "./jobFilters";
import { refreshInterval } from "./live";
import { listIds } from "./queueFormat";
import { splitList, useUrlParams } from "./urlState";

/** Query parameters that restart paging when they change. */
const PAGING_PARAMS = ["offset"] as const;

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
      count: counts?.[state],
    })),
  ];
  const tab = useUrlTab<StateTab>("state", tabs, ALL_STATES);
  const filters = readJobFilters(params, tab, meta.limits);

  const jobs = useQuery({
    queryKey: queueKeys.jobs(queue, filters),
    queryFn: ({ signal }) => listJobs(api, queue, filters, signal),
    refetchInterval: refreshInterval("jobs"),
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
        onApply={(patch) => update({ ...patch, offset: null })}
        onOrder={(order) =>
          update({ order: order === "desc" ? "desc" : null, offset: null })
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
            offset={filters.offset}
            limit={filters.limit}
            total={jobs.data.page.total}
            itemCount={jobs.data.items.length}
            hasMore={jobs.data.page.hasMore}
            maxPageSize={meta.limits.maxPageSize}
            disabled={jobs.isFetching && jobs.isPlaceholderData}
            onChange={(next) =>
              update({
                offset: next.offset > 0 ? String(next.offset) : null,
                limit: String(next.limit),
              })
            }
          />
        </>
      )}
    </section>
  );
}

/** Props of {@link JobFiltersBar}. */
interface JobFiltersBarProps {
  /** The filters in effect. */
  filters: JobListFilters;
  /** Whether the backend searches with an index (else the API scans). */
  searchIndexed: boolean;
  /** Applies the name and search filters. */
  onApply: (patch: { name: string | null; search: string | null }) => void;
  /** Changes the order. */
  onOrder: (order: "asc" | "desc") => void;
  /** Turns counting the total on or off. */
  onTotal: (total: boolean) => void;
}

/** The name filter, the id/name search, the order and the total toggle. */
function JobFiltersBar({
  filters,
  searchIndexed,
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
            { value: "asc", label: "Oldest first" },
            { value: "desc", label: "Newest first" },
          ]}
          value={filters.order}
          onChange={onOrder}
        />
      </span>
      <Checkbox
        checked={filters.total}
        onChange={onTotal}
        label="Count total"
        className="jobs-total"
      />
    </form>
  );
}

/** Props of {@link JobRows}. */
interface JobRowsProps {
  /** The queue listed. */
  queue: string;
  /** The page's jobs. */
  items: readonly JobDto[];
}

/** Which bulk confirmation is open. */
type BulkDialog = "remove" | null;

/** The table, its selection, and the bulk actions over it. */
function JobRows({ queue, items }: JobRowsProps) {
  const api = useApiClient();
  const meta = useMeta();
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
      <EmptyState
        title="No jobs"
        description="No job in this queue matches the state and filters."
      />
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
      <Table label={`Jobs in ${queue}`}>
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
                  <Link to={jobPath(queue, job.id)}>{job.id}</Link>
                  <CopyButton
                    text={job.id}
                    label="Copy"
                    ariaLabel={`Copy job id ${job.id}`}
                  />
                </th>
                <td>{job.name}</td>
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
