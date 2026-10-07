import type { SummonListItemDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { listSummonControllers, summonKeys } from "../../api/summon";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { RelativeTime } from "../../components/RelativeTime";
import { Spinner } from "../../components/Spinner";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { displayText } from "../../format";
import { useCan, useUntargetedCanFn } from "../../meta/hooks";
import { POLL_INTERVAL_MS } from "../../queryClient";
import { Link } from "../../router";
import { providerReadiness } from "../providers/providerText";
import { SummonBudget } from "../queues/panels/SummonBudget";
import { summonOutcome } from "../queues/panels/summonText";
import { summonTabPath } from "./paths";

/**
 * How often the list is re-read: attempts and budgets move with the clock
 * and with summon checks, which no event this screen follows announces — so,
 * like the Summon panel, it polls at the base interval, live or not.
 */
const SUMMONING_REFRESH_MS = POLL_INTERVAL_MS;

/**
 * `/summon`: every summon controller in the API's process (`GET /summon`),
 * one row each — its queue (linked to the queue's Summon tab), the
 * summoner's kind and readiness, the last outcome and when, and the budget
 * left in each UTC window with when it resets.
 *
 * Routed only where the API serves the list (`features.summonResetBudget`,
 * which arrived with it) and the caller may read queues (`queues.read`,
 * untargeted); the nav entry follows the same rule. The API lists only the
 * queues the caller may see.
 */
export function SummoningScreen() {
  const api = useApiClient();
  const canRead = useCan("queues.read");
  // The queue screen is routed only with `queues.list`, on the untargeted map.
  const linkQueues = useUntargetedCanFn()("queues.list");
  const list = useQuery({
    queryKey: summonKeys.list,
    queryFn: ({ signal }) => listSummonControllers(api, signal),
    refetchInterval: SUMMONING_REFRESH_MS,
    enabled: canRead,
  });
  return (
    <div
      className="screen"
      data-testid="summoning-screen"
    >
      <h1 className="screen-title">Summoning</h1>
      {!canRead ? (
        <EmptyState
          title="Nothing to show"
          description="You may not read queues on this API."
        />
      ) : list.isPending ? (
        <Spinner
          label="Loading the summon controllers"
          showLabel
        />
      ) : list.isError ? (
        <ErrorView
          error={list.error}
          title="Could not load the summon controllers"
          onRetry={() => void list.refetch()}
        />
      ) : list.data.controllers.length === 0 ? (
        <EmptyState
          title="No summon controllers here"
          description="Summon controllers run in the API's own process, from its BunJobs context's summon option or jobs.summonController(). None runs in this one, so there is nothing to list. A controller running in another process is not listed."
        />
      ) : (
        <Table label="Summon controllers">
          <thead>
            <tr>
              <th scope="col">Queue</th>
              <th scope="col">Summoner</th>
              <th scope="col">Readiness</th>
              <th scope="col">Last outcome</th>
              <th scope="col">Budget left</th>
            </tr>
          </thead>
          <tbody>
            {list.data.controllers.map((item) => (
              <ControllerRow
                key={`${item.namespace}/${item.queue}`}
                item={item}
                linkQueue={linkQueues}
              />
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** Props of {@link ControllerRow}. */
interface ControllerRowProps {
  /** The controller, as `GET /summon` lists it. */
  item: SummonListItemDto;
  /** Whether the queue name links to its Summon tab (`queues.list`). */
  linkQueue: boolean;
}

/** One controller. */
function ControllerRow({ item, linkQueue }: ControllerRowProps) {
  const readiness = providerReadiness(item.readiness);
  const last =
    item.last === undefined ? undefined : summonOutcome(item.last.outcome);
  return (
    <tr data-testid={`summoning-row-${item.queue}`}>
      <th scope="row">
        {linkQueue ? (
          <Link
            to={summonTabPath(item.queue)}
            title={`The Summon tab of ${item.queue}`}
          >
            {item.queue}
          </Link>
        ) : (
          item.queue
        )}
      </th>
      <td>
        <code>{displayText(item.kind)}</code>
      </td>
      <td>
        <Badge
          tone={readiness.tone}
          title={readiness.hint}
          testId="summoning-readiness"
        >
          {readiness.label}
        </Badge>
      </td>
      <td data-testid="summoning-last">
        {item.last === undefined || last === undefined ? (
          <span className="muted">None yet</span>
        ) : (
          <>
            <Badge
              tone={last.tone}
              title={last.hint}
            >
              {last.label}
            </Badge>{" "}
            <RelativeTime value={item.last.at} />
            {item.last.detail !== undefined && (
              <span className="muted"> — {displayText(item.last.detail)}</span>
            )}
          </>
        )}
      </td>
      <td>
        <SummonBudget
          budget={item.budget}
          testId={`summoning-budget-${item.queue}`}
        />
      </td>
    </tr>
  );
}
