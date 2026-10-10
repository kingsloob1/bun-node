import type { SummonGroupStatusDto } from "../../../api/types";
import type { GroupCircuit, GroupShare } from "./summonGroupText";
import { Badge } from "../../../components/Badge";
import { cx } from "../../../components/classNames";
import { KeyValue } from "../../../components/KeyValue";
import { RelativeTime } from "../../../components/RelativeTime";
import { Table } from "../../../components/Table";
import { displayText, formatNumber, plural } from "../../../format";
import { useNow } from "../../../hooks/useNow";
import { useFeature, useUntargetedCanFn } from "../../../meta/hooks";
import { Link } from "../../../router";
import { summonGroupPath, summonTabPath } from "../../summoning/paths";
import { budgetUsedText, utcResetLabel } from "./budgetText";
import { SummonBudget } from "./SummonBudget";
import {
  circuitKindLabel,
  groupCircuits,
  groupShares,
} from "./summonGroupText";

/** Props of {@link SummonGroupCard}. */
export interface SummonGroupCardProps {
  /** The group, as the queue's summon status has it (`status.group`). */
  group: SummonGroupStatusDto;
  /** The queue whose Summon tab this is: its share's row is marked. */
  queue: string;
  /**
   * The queue's summoner kind (`status.summoner.provider.kind`), naming the
   * group's one `circuit` when the answer has no `circuits`; `undefined` when
   * not known here, which reads "this summoner".
   */
  kind: string | undefined;
}

/**
 * The summon group a queue's controller is in, on its Summon tab: the
 * group's name (linked to its row on the Summoning screen, where that
 * screen lists groups), the group's budget, the shared circuit per provider
 * kind, and today's attempts charged to the group by each member queue.
 *
 * The group arrives redacted to the member queues the caller may read, so
 * the share table is what those queues charged today, never a count of the
 * group's members.
 */
export function SummonGroupCard({ group, queue, kind }: SummonGroupCardProps) {
  const shares = groupShares(group);
  const circuits = groupCircuits(group, kind);
  return (
    <section
      className="summon-group"
      data-testid="summon-group"
      aria-label={`Summon group ${group.name}`}
    >
      <h3 className="summon-heading">
        Summon group <GroupName name={group.name} />
      </h3>
      <KeyValue
        items={[
          {
            key: "group-budget",
            label: "Group budget",
            value: (
              <SummonBudget
                budget={group.budget}
                testId="summon-group-budget"
              />
            ),
            hint: budgetUsedText(group.budget),
          },
          ...circuits.map((circuit) => ({
            key: `circuit-${circuit.kind ?? ""}`,
            label: `Shared circuit, ${circuitKindLabel(circuit.kind)}`,
            value: <CircuitState circuit={circuit} />,
          })),
        ]}
      />
      <h4 className="summon-subheading">Charged today</h4>
      {shares.length === 0 ? (
        <p
          className="muted"
          data-testid="summon-group-shares-empty"
        >
          No attempts charged to the group today.
        </p>
      ) : (
        <SharesTable
          group={group.name}
          queue={queue}
          shares={shares}
        />
      )}
    </section>
  );
}

/**
 * The group's name, linked to its row on the Summoning screen where that
 * screen is routed (`features.summonList`, `queues.list`) and lists groups
 * (`features.summonRemoteStatus`); plain text elsewhere, since the link
 * would land on a page without it.
 */
function GroupName({
  name,
}: {
  /** The group's name. */
  name: string;
}) {
  const listed = useFeature("summonList") === true;
  const remote = useFeature("summonRemoteStatus") === true;
  // The untargeted map: what the nav, and so the routes, were built from.
  const canList = useUntargetedCanFn()("queues.list");
  if (!(listed && remote && canList)) {
    return <span data-testid="summon-group-name">{name}</span>;
  }
  return (
    <Link
      to={summonGroupPath(name)}
      title={`The group ${name} on the Summoning screen`}
      data-testid="summon-group-name"
    >
      {name}
    </Link>
  );
}

/** Props of {@link SharesTable}. */
interface SharesTableProps {
  /** The group's name, for the table's name. */
  group: string;
  /** The queue whose Summon tab this is: its row is marked. */
  queue: string;
  /** The shares, in order. */
  shares: GroupShare[];
}

/** Today's attempts charged to the group, per member queue the caller may read. */
function SharesTable({ group, queue, shares }: SharesTableProps) {
  return (
    <Table label={`Attempts charged to the group ${group} today`}>
      <thead>
        <tr>
          <th scope="col">Queue</th>
          <th
            scope="col"
            className="num"
          >
            Attempts today
          </th>
          <th scope="col">Last</th>
        </tr>
      </thead>
      <tbody>
        {shares.map((share) => {
          const current = share.queue === queue;
          return (
            <tr
              key={share.queue}
              data-testid={`summon-group-share-${share.queue}`}
              aria-current={current ? "true" : undefined}
              className={cx(current && "is-current")}
            >
              <th scope="row">
                <Link
                  to={summonTabPath(share.queue)}
                  title={`The Summon tab of ${share.queue}`}
                >
                  {share.queue}
                </Link>
                {current && <span className="muted"> (this queue)</span>}
              </th>
              <td className="num">{formatNumber(share.day)}</td>
              <td>
                <RelativeTime value={share.lastAt} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

/** Props of {@link CircuitState}. */
export interface CircuitStateProps {
  /** The shared circuit of one provider kind. */
  circuit: GroupCircuit;
  /**
   * One short line, `"ecs: open until …"` or `"ecs: closed"`, as the
   * Summoning screen's groups list has it; the failures and the detail move
   * to the tooltip. Defaults to `false`: the card's fuller wording.
   */
  compact?: boolean;
  /** `data-testid` of the whole; defaults to `summon-group-circuit-<kind>` (`this-summoner` when the kind is unknown). */
  testId?: string;
}

/**
 * A group's shared circuit for one provider kind: "Closed" with its failure
 * count, or "Open" in the warning tone until it closes — absolute in UTC,
 * with the relative time beside it, as a budget's reset — with who opened it
 * (linked to that queue's Summon tab) and the failure's detail, where the
 * group's state names one the caller may read.
 */
export function CircuitState({
  circuit,
  compact = false,
  testId,
}: CircuitStateProps) {
  const now = useNow();
  const label = circuitKindLabel(circuit.kind);
  const id =
    testId ??
    `summon-group-circuit-${circuit.kind === undefined || circuit.kind === "" ? "this-summoner" : circuit.kind}`;
  const failures = `${plural(circuit.failures, "consecutive failure")} across the group`;
  const opened = circuit.openedBy;
  const detail =
    opened?.detail === undefined ? undefined : displayText(opened.detail);
  const openUntil = circuit.openUntil;
  if (openUntil === undefined) {
    return compact ? (
      <span
        data-testid={id}
        data-open="false"
        title={failures}
      >
        {label}: closed
      </span>
    ) : (
      <span
        data-testid={id}
        data-open="false"
      >
        <Badge tone="success">Closed</Badge>{" "}
        <span className="muted">{failures}</span>
      </span>
    );
  }
  const openedBy = opened !== undefined && (
    <>
      , opened by{" "}
      <Link
        to={summonTabPath(opened.queue)}
        title={`The Summon tab of ${opened.queue}`}
      >
        {opened.queue}
      </Link>
    </>
  );
  if (compact) {
    return (
      <span
        className="summon-group-circuit is-open"
        data-testid={id}
        data-open="true"
        title={detail === undefined ? failures : `${failures}: ${detail}`}
      >
        {label}: open until {utcResetLabel(openUntil, now)} (
        <RelativeTime value={openUntil} />){openedBy}
      </span>
    );
  }
  return (
    <span
      className="summon-group-circuit is-open"
      data-testid={id}
      data-open="true"
    >
      <Badge
        tone="warning"
        title="After repeated failures across the group nothing is summoned for this kind until then, apart from one trial attempt."
      >
        Open
      </Badge>{" "}
      until {utcResetLabel(openUntil, now)} (
      <RelativeTime value={openUntil} />){openedBy}
      {detail !== undefined && <span className="muted"> — {detail}</span>}
    </span>
  );
}
