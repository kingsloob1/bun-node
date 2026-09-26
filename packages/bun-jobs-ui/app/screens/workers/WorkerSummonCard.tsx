import type { WorkerDto, WorkerSummonProvenanceDto } from "../../api/types";
import { Card } from "../../components/Card";
import { RelativeTime } from "../../components/RelativeTime";
import { Table } from "../../components/Table";
import { displayText, plural } from "../../format";
import { SUMMON_NOTE, summonModeHint, summonModeLabel } from "./summon";

/** Props of {@link WorkerSummonCard}. */
export interface WorkerSummonCardProps {
  /** The stable key, for the table's accessible name. */
  workerKey: string;
  /** The key's live instances, as the Instances card lists them. */
  instances: readonly WorkerDto[];
}

/** An instance that reports a summon, with it. */
interface Summoned {
  /** The instance's incarnation id. */
  id: string;
  /** What it reports. */
  summon: WorkerSummonProvenanceDto;
}

/**
 * Where a worker key's summoned instances came from: one row per instance
 * reporting `summon`, with the attempt's id, the summoner's kind, the mode
 * and deadline the summoner **requested**, and the platform's handle when the
 * API sends it (`serialize.exposeSummonHandles`).
 *
 * **Rendered only when an instance reports a summon.** An instance with no
 * `summon` was not summoned or is too old to say which, so it has no row, and
 * a key none of whose instances report one has no card at all. When some do
 * and some do not, a line counts the rest without claiming why.
 *
 * One row per instance, not per value: every summon is its own attempt with
 * its own id, so instances never share one the way they share a target.
 */
export function WorkerSummonCard({
  workerKey,
  instances,
}: WorkerSummonCardProps) {
  const summoned: Summoned[] = [];
  for (const worker of instances) {
    if (worker.summon !== undefined) {
      summoned.push({ id: worker.id, summon: worker.summon });
    }
  }
  if (summoned.length === 0) {
    return null;
  }
  const others = instances.length - summoned.length;
  const showKind = summoned.some(({ summon }) => summon.kind !== undefined);
  const showMode = summoned.some(({ summon }) => summon.mode !== undefined);
  const showDeadline = summoned.some(
    ({ summon }) => summon.deadlineAt !== undefined,
  );
  // Only when the API sent one (`serialize.exposeSummonHandles`): nothing
  // hints at a handle it withheld.
  const showHandle = summoned.some(({ summon }) => summon.handle !== undefined);
  return (
    <Card title="Summoned">
      <div data-testid="worker-summon">
        <p className="muted worker-target-note">{SUMMON_NOTE}</p>
        <Table label={`Summoned instances of ${workerKey}`}>
          <thead>
            <tr>
              <th scope="col">Instance</th>
              <th scope="col">Summon</th>
              {showKind && <th scope="col">Summoner</th>}
              {showMode && <th scope="col">Requested mode</th>}
              {showDeadline && <th scope="col">Requested deadline</th>}
              {showHandle && <th scope="col">Handle</th>}
            </tr>
          </thead>
          <tbody>
            {summoned.map(({ id, summon }) => (
              <tr
                key={id}
                data-testid={`worker-summon-row-${id}`}
              >
                <th scope="row">
                  <code>{id}</code>
                </th>
                <td>
                  <code>{displayText(summon.id)}</code>
                </td>
                {showKind && (
                  <td>
                    {summon.kind !== undefined && displayText(summon.kind)}
                  </td>
                )}
                {showMode && (
                  <td
                    title={
                      summon.mode === undefined
                        ? undefined
                        : summonModeHint(summon.mode)
                    }
                  >
                    {summon.mode !== undefined && summonModeLabel(summon.mode)}
                  </td>
                )}
                {showDeadline && (
                  <td>
                    {summon.deadlineAt !== undefined && (
                      <RelativeTime
                        value={summon.deadlineAt}
                        hint="As requested by the summoner."
                      />
                    )}
                  </td>
                )}
                {showHandle && (
                  <td>
                    {summon.handle !== undefined && (
                      <code className="worker-target-file">
                        {displayText(summon.handle)}
                      </code>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
        {others > 0 && (
          <p
            className="muted"
            data-testid="worker-summon-others"
          >
            {plural(others, "other instance")} of this key{" "}
            {others === 1 ? "reports" : "report"} no summon.
          </p>
        )}
      </div>
    </Card>
  );
}
