import type { RepeatableDto } from "../../../api/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, isApiError } from "../../../api/errors";
import {
  disableRepeatable,
  enableRepeatable,
  listRepeatables,
  mutationInvalidations,
  queueKeys,
  removeRepeatable,
} from "../../../api/queues";
import { Badge } from "../../../components/Badge";
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
import { useRefreshInterval } from "../live";
import { describeSchedule } from "../queueFormat";

/** Props of {@link RepeatablesPanel}. */
export interface RepeatablesPanelProps {
  /** The queue whose repeat series are listed. */
  queue: string;
  /** Whether the caller may remove a series (`repeatables.remove`, not read-only). */
  canRemove: boolean;
  /** Whether the caller may disable a series (`repeatables.disable`, not read-only); offered on enabled ones. Defaults to `false`. */
  canDisable?: boolean;
  /** Whether the caller may enable a series (`repeatables.enable`, not read-only); offered on disabled ones. Defaults to `false`. */
  canEnable?: boolean;
}

/** A disable or enable of one series. */
export type RepeatableToggle = "disable" | "enable";

/**
 * A failed disable or enable, with a 404 `REPEATABLE_NOT_FOUND` explained in
 * plain words. Anything else is returned unchanged.
 */
function explainToggleError(error: unknown, key: string): unknown {
  if (!isApiError(error) || error.code !== "REPEATABLE_NOT_FOUND") {
    return error;
  }
  return new ApiError({
    kind: error.kind,
    status: error.status,
    code: error.code,
    title: error.title,
    detail: `The repeat series “${key}” no longer exists: somebody removed it, or it ended. Refresh to see the series there are now.`,
    type: error.type,
    issues: error.issues,
    context: error.context,
    instance: error.instance,
    cause: error,
  });
}

/** `GET /queues/:queue/repeatables?include=data`, with remove, disable and enable. */
export function RepeatablesPanel({
  queue,
  canRemove,
  canDisable = false,
  canEnable = false,
}: RepeatablesPanelProps) {
  const api = useApiClient();
  const [removing, setRemoving] = useState<RepeatableDto | null>(null);
  const refetchInterval = useRefreshInterval("repeatables");
  const repeatables = useQuery({
    queryKey: queueKeys.repeatables(queue),
    queryFn: ({ signal }) => listRepeatables(api, queue, signal),
    refetchInterval,
  });
  const remove = useApiMutation({
    mutationFn: (key: string) => removeRepeatable(api, queue, key),
    successMessage: (_result, key) => `Removed the repeat series ${key}`,
    invalidate: mutationInvalidations(queue),
    toastErrors: false,
  });
  const toggle = useApiMutation({
    mutationFn: async ({
      key,
      to,
    }: {
      key: string;
      to: RepeatableToggle;
    }): Promise<unknown> => {
      try {
        return to === "disable"
          ? await disableRepeatable(api, queue, key)
          : await enableRepeatable(api, queue, key);
      } catch (error) {
        throw explainToggleError(error, key);
      }
    },
    successMessage: (_result, { key, to }) =>
      to === "disable"
        ? `Disabled the repeat series ${key}: it schedules nothing until enabled`
        : `Enabled the repeat series ${key}: its next occurrence is scheduled from now`,
    errorTitle: "Could not change the repeat series",
    invalidate: mutationInvalidations(queue),
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
  // An actions column only when some row has a button in it.
  const hasActions =
    canRemove ||
    items.some((series) => (series.disabled ? canEnable : canDisable));
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
            {hasActions && (
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
                {series.disabled && (
                  <>
                    {" "}
                    <Badge
                      tone="warning"
                      title="Schedules nothing until it is enabled"
                    >
                      Disabled
                    </Badge>
                  </>
                )}
              </th>
              <td>{series.name}</td>
              <td>{describeSchedule(series)}</td>
              <td data-testid={`repeatable-next-${series.key}`}>
                {series.disabled ? (
                  "paused (disabled)"
                ) : (
                  <RelativeTime value={series.nextRunAt} />
                )}
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
              {hasActions && (
                <td>
                  <div className="repeatable-actions">
                    {canDisable && !series.disabled && (
                      <ToggleButton
                        series={series}
                        to="disable"
                        pending={
                          toggle.isPending &&
                          toggle.variables?.key === series.key
                        }
                        onClick={() =>
                          toggle.mutate({ key: series.key, to: "disable" })
                        }
                      />
                    )}
                    {canEnable && series.disabled && (
                      <ToggleButton
                        series={series}
                        to="enable"
                        pending={
                          toggle.isPending &&
                          toggle.variables?.key === series.key
                        }
                        onClick={() =>
                          toggle.mutate({ key: series.key, to: "enable" })
                        }
                      />
                    )}
                    {canRemove && (
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Remove repeatable ${series.key}`}
                        onClick={() => setRemoving(series)}
                      >
                        Remove…
                      </Button>
                    )}
                  </div>
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

/** Props of {@link ToggleButton}. */
interface ToggleButtonProps {
  /** The series the button acts on. */
  series: RepeatableDto;
  /** What it does. */
  to: RepeatableToggle;
  /** Whether this series' request is in flight. */
  pending: boolean;
  /** Sends the request. */
  onClick: () => void;
}

/** A series' Disable or Enable button: idempotent, so it asks no confirmation. */
function ToggleButton({ series, to, pending, onClick }: ToggleButtonProps) {
  const label = to === "disable" ? "Disable" : "Enable";
  return (
    <Button
      size="sm"
      aria-label={`${label} repeatable ${series.key}`}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={onClick}
    >
      {pending ? `${to === "disable" ? "Disabling" : "Enabling"}…` : label}
    </Button>
  );
}
