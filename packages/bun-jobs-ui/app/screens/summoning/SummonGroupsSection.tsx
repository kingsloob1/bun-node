import type { RefObject } from "react";
import type { SummonGroupStatusDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { listSummonGroups, summonKeys } from "../../api/summon";
import { cx } from "../../components/classNames";
import { ErrorView } from "../../components/ErrorView";
import { Spinner } from "../../components/Spinner";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { formatNumber } from "../../format";
import { Link } from "../../router";
import { useSearchParams } from "../../routing";
import { SummonBudget } from "../queues/panels/SummonBudget";
import { CircuitState } from "../queues/panels/SummonGroupCard";
import { groupCircuits, groupShares } from "../queues/panels/summonGroupText";
import { summonTabPath } from "./paths";

/** Props of {@link SummonGroupsSection}. */
export interface SummonGroupsSectionProps {
  /** How often the groups are re-read, ms: the controllers list's interval. */
  refetchInterval: number;
}

/**
 * The Summoning screen's summon groups (`GET /summon/groups`): one row per
 * group with shared state in the namespace — its budget, its shared circuit
 * per provider kind, and the member queues that charged it today, each
 * linked to its Summon tab.
 *
 * The screen renders it only where the API reads summon state from storage
 * (`features.summonRemoteStatus`) and the caller may list queues
 * (`queues.list`, the route's action). Each group arrives redacted to the
 * member queues the caller may read, so a row never claims a member count.
 *
 * `?group=<name>` marks that group's row and scrolls it into view once, when
 * the groups arrive. A failed read is an error view inside the section, so
 * the controllers above it stay.
 */
export function SummonGroupsSection({
  refetchInterval,
}: SummonGroupsSectionProps) {
  const api = useApiClient();
  const selected = useSearchParams().get("group");
  const groups = useQuery({
    queryKey: summonKeys.groups,
    queryFn: ({ signal }) => listSummonGroups(api, signal),
    refetchInterval,
  });
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null);
  // The group last scrolled to: once per `?group=`, not on every re-read.
  const scrolledToRef = useRef<string | null>(null);
  const loaded = groups.data !== undefined;
  useEffect(() => {
    if (!loaded || selected === null || scrolledToRef.current === selected) {
      return;
    }
    const row = selectedRowRef.current;
    if (row === null) {
      return;
    }
    scrolledToRef.current = selected;
    // happy-dom, and an old browser, may not have it.
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center" });
    }
  }, [loaded, selected]);
  return (
    <section
      className="summon-groups"
      data-testid="summon-groups"
      aria-labelledby="summon-groups-heading"
    >
      <h2
        id="summon-groups-heading"
        className="summon-groups-title"
      >
        Summon groups
      </h2>
      {groups.isPending ? (
        <Spinner
          label="Loading the summon groups"
          showLabel
        />
      ) : groups.isError ? (
        <ErrorView
          error={groups.error}
          title="Could not load the summon groups"
          onRetry={() => void groups.refetch()}
        />
      ) : groups.data.groups.length === 0 ? (
        <p
          className="muted"
          data-testid="summon-groups-empty"
        >
          No summon groups in this namespace.
        </p>
      ) : (
        <Table label="Summon groups">
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">Budget left</th>
              <th scope="col">Shared circuit</th>
              <th scope="col">Charged today</th>
            </tr>
          </thead>
          <tbody>
            {groups.data.groups.map((group) => (
              <GroupRow
                key={group.name}
                group={group}
                current={group.name === selected}
                rowRef={group.name === selected ? selectedRowRef : undefined}
              />
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/** Props of {@link GroupRow}. */
interface GroupRowProps {
  /** The group, as `GET /summon/groups` lists it. */
  group: SummonGroupStatusDto;
  /** Whether `?group=` names it: the row is marked. */
  current: boolean;
  /** Set to the row's element for the marked row, so it can be scrolled into view. */
  rowRef: RefObject<HTMLTableRowElement | null> | undefined;
}

/** One group. */
function GroupRow({ group, current, rowRef }: GroupRowProps) {
  const shares = groupShares(group);
  // No answering controller here, so `circuit` alone has no kind to name.
  const circuits = groupCircuits(group, undefined);
  return (
    <tr
      ref={rowRef}
      id={`summon-group-${group.name}`}
      data-testid={`summon-group-row-${group.name}`}
      aria-current={current ? "true" : undefined}
      className={cx(current && "is-current")}
    >
      <th scope="row">{group.name}</th>
      <td>
        <SummonBudget
          budget={group.budget}
          testId={`summon-groups-budget-${group.name}`}
        />
      </td>
      <td>
        {circuits.length === 0 ? (
          <span
            className="muted"
            title="The group shares no circuit, or none has counted a failure"
          >
            —
          </span>
        ) : (
          <ul className="summon-group-list">
            {circuits.map((circuit) => (
              <li key={circuit.kind ?? ""}>
                <CircuitState
                  circuit={circuit}
                  compact
                  testId={`summon-groups-circuit-${group.name}-${circuit.kind ?? "this-summoner"}`}
                />
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        {shares.length === 0 ? (
          <span className="muted">None today</span>
        ) : (
          <ul className="summon-group-list">
            {shares.map((share) => (
              <li
                key={share.queue}
                data-testid={`summon-groups-share-${group.name}-${share.queue}`}
              >
                <Link
                  to={summonTabPath(share.queue)}
                  title={`The Summon tab of ${share.queue}`}
                >
                  {share.queue}
                </Link>{" "}
                <span className="summon-group-count">
                  {formatNumber(share.day)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}
