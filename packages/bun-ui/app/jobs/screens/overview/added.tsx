import type { TimeRange } from "../../analytics/range";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ADDED_BY_STATE_POLL_MS,
  addedByStateKey,
  getAddedByState,
} from "../../api/added";
import { JOB_STATES } from "../../api/contract";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { formatNumber, STATE_LABELS } from "../../format";
import { usePollInterval } from "../../live";

/** Props of {@link AddedByStateGroup}. */
export interface AddedByStateGroupProps {
  /** The range the tile is read over (the Jobs section's). */
  range: TimeRange;
}

/**
 * The "Over the range" tile's second group: of the jobs **added** in the
 * range and still stored, how many are in each state now
 * (`GET /overview/added`). Rendered only where `features.addedByState` is
 * true, and polled every {@link ADDED_BY_STATE_POLL_MS}, relaxed further
 * while live, since each read counts job records.
 */
export function AddedByStateGroup({ range }: AddedByStateGroupProps) {
  const api = useApiClient();
  const refetchInterval = usePollInterval(ADDED_BY_STATE_POLL_MS);
  const added = useQuery({
    queryKey: addedByStateKey(range),
    queryFn: ({ signal }) => getAddedByState(api, range, signal),
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <p className="range-group-title">
        Added in range, where they are now{" "}
        <span className="muted">(still stored)</span>
      </p>
      {added.data ? (
        <dl className="range-cells">
          {JOB_STATES.map((state) => (
            <div
              key={state}
              className={`range-cell state-${state}`}
            >
              <dt>{STATE_LABELS[state]}</dt>
              <dd>{formatNumber(added.data.counts[state])}</dd>
            </div>
          ))}
          <div className="range-cell range-cell-total">
            <dt>Total</dt>
            <dd>{formatNumber(added.data.total)}</dd>
          </div>
        </dl>
      ) : added.isError ? (
        <p className="range-note">Could not load: {added.error.message}</p>
      ) : (
        <Spinner label="Loading jobs added in the range" />
      )}
      <p className="range-note">
        Counted by when jobs were added, not finished, so it will not match
        Finished in range; queues that remove finished jobs show few completed.
      </p>
    </>
  );
}
