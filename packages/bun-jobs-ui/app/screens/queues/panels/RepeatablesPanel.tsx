import type { RepeatableDto } from "../../../api/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  listRepeatables,
  mutationInvalidations,
  queueKeys,
  removeRepeatable,
} from "../../../api/queues";
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { EmptyState } from "../../../components/EmptyState";
import { JsonView } from "../../../components/JsonView";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { RelativeTime } from "../../../components/RelativeTime";
import { Spinner } from "../../../components/Spinner";
import { Table } from "../../../components/Table";
import { useApiClient } from "../../../context";
import { formatNumber } from "../../../format";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { refreshInterval } from "../live";
import { describeSchedule } from "../queueFormat";

/** Props of {@link RepeatablesPanel}. */
export interface RepeatablesPanelProps {
  /** The queue whose repeat series are listed. */
  queue: string;
  /** Whether the caller may remove a series (`repeatables.remove`, not read-only). */
  canRemove: boolean;
}

/** `GET /queues/:queue/repeatables?include=data`, with remove. */
export function RepeatablesPanel({ queue, canRemove }: RepeatablesPanelProps) {
  const api = useApiClient();
  const [removing, setRemoving] = useState<RepeatableDto | null>(null);
  const repeatables = useQuery({
    queryKey: queueKeys.repeatables(queue),
    queryFn: ({ signal }) => listRepeatables(api, queue, signal),
    refetchInterval: refreshInterval("repeatables"),
  });
  const remove = useApiMutation({
    mutationFn: (key: string) => removeRepeatable(api, queue, key),
    successMessage: (_result, key) => `Removed the repeat series ${key}`,
    invalidate: mutationInvalidations(queue),
    toastErrors: false,
  });
  if (repeatables.isPending) {
    return (
      <Spinner
        label="Loading repeatables"
        showLabel
      />
    );
  }
  if (repeatables.isError) {
    return (
      <ProblemBanner
        error={repeatables.error}
        title="Could not load repeatables"
        onRetry={() => void repeatables.refetch()}
      />
    );
  }
  const items = repeatables.data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No repeatables"
        description="No repeat series is scheduled on this queue."
      />
    );
  }
  return (
    <>
      <Table label={`Repeatables of ${queue}`}>
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Name</th>
            <th scope="col">Schedule</th>
            <th scope="col">Next run</th>
            <th
              scope="col"
              className="num"
            >
              Runs
            </th>
            <th scope="col">Data</th>
            {canRemove && (
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((series) => (
            <tr
              key={series.key}
              data-testid={`repeatable-row-${series.key}`}
            >
              <th scope="row">
                <code>{series.key}</code>
              </th>
              <td>{series.name}</td>
              <td>{describeSchedule(series)}</td>
              <td>
                <RelativeTime value={series.nextRunAt} />
              </td>
              <td className="num">
                {formatNumber(series.count)}
                {series.limit !== undefined &&
                  ` / ${formatNumber(series.limit)}`}
              </td>
              <td className="repeatable-data">
                {series.data === undefined ? (
                  "—"
                ) : (
                  <JsonView
                    value={series.data}
                    label={`Data of ${series.key}`}
                    expandDepth={0}
                  />
                )}
              </td>
              {canRemove && (
                <td>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Remove repeatable ${series.key}`}
                    onClick={() => setRemoving(series)}
                  >
                    Remove…
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove the repeat series ${removing?.key ?? ""}?`}
        description="No further occurrences are scheduled. Jobs it already produced stay."
        variant="danger"
        confirmLabel="Remove"
        onConfirm={() =>
          removing ? remove.mutateAsync(removing.key) : undefined
        }
      />
    </>
  );
}
