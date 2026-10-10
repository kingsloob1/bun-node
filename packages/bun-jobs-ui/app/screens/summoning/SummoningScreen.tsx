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
import { useNow } from "../../hooks/useNow";
import { useCan, useMeta } from "../../meta/hooks";
import { POLL_INTERVAL_MS } from "../../queryClient";
import { Link } from "../../router";
import { providerReadiness } from "../providers/providerText";
import { utcResetLabel } from "../queues/panels/budgetText";
import { SummonBudget } from "../queues/panels/SummonBudget";
import { summonInert, summonOutcome } from "../queues/panels/summonText";
import { summonTabPath } from "./paths";
import { SummonGroupsSection } from "./SummonGroupsSection";
// The group styles live with the Summon tab's; this chunk may load first.
import "../queues/queues.css";

/**
 * How often the list is re-read: attempts and budgets move with the clock
 * and with summon checks, which no event this screen follows announces — so,
 * like the Summon panel, it polls at the base interval, live or not.
 */
const SUMMONING_REFRESH_MS = POLL_INTERVAL_MS;

/**
 * `/summon`: every summon controller in the API's process (`GET /summon`),
 * and, where the API reads summon state from storage
 * (`features.summonRemoteStatus`), every queue whose controller runs
 * elsewhere (`local: false`: "Elsewhere", no actions), one row each — its queue (linked to the queue's Summon tab), the
 * summoner's kind and readiness, the last outcome and when, and the budget
 * left in each UTC window with when it resets, and an open circuit.
 *
 * Under the controllers, where the API reads summon state from storage, the
 * summon groups of the namespace ({@link SummonGroupsSection}).
 *
 * Routed only where the API serves the list (`features.summonList`) and the
 * caller may list queues (`queues.list`, the route's action); the nav entry
 * follows the same rule. The API then lists a controller only where the
 * caller may read its queue (`queues.read` on that queue).
 */
export function SummoningScreen() {
  const api = useApiClient();
  // `queues.list` is also what routes the queue screen, so every row links.
  const canList = useCan("queues.list");
  // Whether the API also lists queues whose controller runs elsewhere.
  const remote = useMeta().features.summonRemoteStatus === true;
  const list = useQuery({
    queryKey: summonKeys.list,
    queryFn: ({ signal }) => listSummonControllers(api, signal),
    refetchInterval: SUMMONING_REFRESH_MS,
    enabled: canList,
  });
  return (
    <div
      className="screen"
      data-testid="summoning-screen"
    >
      <h1 className="screen-title">Summoning</h1>
      {!canList ? (
        <EmptyState
          title="Nothing to show"
          description="You may not list queues on this API."
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
          description={
            remote
              ? "No queue summons here: none has a controller in the API's own process, or summon state in the store that you may read."
              : "Summon controllers run in the API's own process, from its BunJobs context's summon option or jobs.summonController(). None runs in this one, so there is nothing to list. A controller running in another process is not listed."
          }
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
              />
            ))}
          </tbody>
        </Table>
      )}
      {canList && remote && (
        <SummonGroupsSection refetchInterval={SUMMONING_REFRESH_MS} />
      )}
    </div>
  );
}

/** Props of {@link ControllerRow}. */
interface ControllerRowProps {
  /** The controller, as `GET /summon` lists it. */
  item: SummonListItemDto;
}

/** One controller. */
function ControllerRow({ item }: ControllerRowProps) {
  const now = useNow();
  // Absent for a queue read from storage (`local: false`): its controller,
  // and so its summoner, runs in another process.
  const readiness =
    item.readiness === undefined
      ? undefined
      : providerReadiness(item.readiness);
  const last =
    item.last === undefined ? undefined : summonOutcome(item.last.outcome);
  return (
    <tr data-testid={`summoning-row-${item.queue}`}>
      <th scope="row">
        <Link
          to={summonTabPath(item.queue)}
          title={`The Summon tab of ${item.queue}`}
        >
          {item.queue}
        </Link>
      </th>
      <td>
        {item.kind === "" ? (
          // Read from storage before any claim recorded the summoner's kind.
          <span
            className="muted"
            title="Not recorded yet: its controller runs in another process"
            data-testid="summoning-kind-unknown"
          >
            —
          </span>
        ) : (
          <code>{displayText(item.kind)}</code>
        )}
      </td>
      <td>
        {readiness === undefined ? (
          <span
            className="muted"
            title="Its controller runs in another process"
          >
            Elsewhere
          </span>
        ) : (
          <Badge
            tone={readiness.tone}
            title={readiness.hint}
            testId="summoning-readiness"
          >
            {readiness.label}
          </Badge>
        )}
        {item.inert && (
          <>
            {" "}
            <Badge
              tone="neutral"
              title={summonInert(item.inertReason)}
              testId="summoning-inert"
            >
              Inert
            </Badge>
          </>
        )}
        {item.circuitOpenUntil !== undefined && (
          <>
            {" "}
            <Badge
              tone="warning"
              title={`Circuit open until ${utcResetLabel(item.circuitOpenUntil, now)}: after repeated failures nothing is summoned until then, apart from one trial attempt.`}
              testId="summoning-circuit"
            >
              Circuit open
            </Badge>
          </>
        )}
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
        {item.budget === undefined ? (
          // None for summon state a newer bun-jobs wrote: it is not read here.
          <span
            className="muted"
            data-testid={`summoning-budget-${item.queue}`}
          >
            —
          </span>
        ) : (
          <SummonBudget
            budget={item.budget}
            testId={`summoning-budget-${item.queue}`}
          />
        )}
      </td>
    </tr>
  );
}
