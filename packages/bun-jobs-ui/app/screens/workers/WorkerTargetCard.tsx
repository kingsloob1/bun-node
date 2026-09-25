import type { WorkerDto, WorkerTargetInfoDto } from "../../api/types";
import type { TargetGroup } from "./target";
import { Card } from "../../components/Card";
import { KeyValue } from "../../components/KeyValue";
import { Table } from "../../components/Table";
import { displayText, plural } from "../../format";
import {
  groupTargets,
  processorLabel,
  TARGET_FIXED_NOTE,
  targetKindHint,
  targetKindLabel,
} from "./target";

/** How many instance ids a row of the mixed-targets table names before counting the rest. */
const NAMED_INSTANCES = 5;

/** What a card says for instances too old to report a target. */
const PREDATES =
  "This worker predates target reporting, so it does not say where its attempts run.";

/** Props of {@link WorkerTargetCard}. */
export interface WorkerTargetCardProps {
  /** The stable key, for the mixed-targets table's accessible name. */
  workerKey: string;
  /** The key's live instances, as the Instances card lists them. */
  instances: readonly WorkerDto[];
}

/** A muted dash for a worker that reports no target, explained on hover. */
function Unknown({ testId }: { testId?: string }) {
  return (
    <span
      className="muted"
      title="Not reported: this worker predates target reporting."
      data-testid={testId}
    >
      —
    </span>
  );
}

/** One target as label/value rows: where it runs, what it runs, and what the API sent besides. */
function TargetFacts({
  target,
}: {
  /** The target every instance reports, or `undefined` when none reports one. */
  target: WorkerTargetInfoDto | undefined;
}) {
  if (target === undefined) {
    return (
      <KeyValue
        items={[
          {
            label: "Runs in",
            value: <Unknown testId="worker-target-kind" />,
            hint: <span data-testid="worker-target-predates">{PREDATES}</span>,
          },
        ]}
      />
    );
  }
  return (
    <KeyValue
      items={[
        {
          label: "Runs in",
          value: (
            <span data-testid="worker-target-kind">
              {targetKindLabel(target.kind)}
            </span>
          ),
          hint: targetKindHint(target.kind),
        },
        {
          label: "Processor",
          value: (
            <span data-testid="worker-target-processor">
              {processorLabel(target.processor)}
            </span>
          ),
        },
        // Only a custom target carries a name.
        target.name !== undefined && {
          label: "Name",
          value: (
            <code data-testid="worker-target-name">
              {displayText(target.name)}
            </code>
          ),
        },
        // Only when the API sent it (`serialize.exposeProcessorFiles`):
        // nothing hints at a path it withheld.
        target.file !== undefined && {
          label: "File",
          value: (
            <code
              className="worker-target-file"
              data-testid="worker-target-file"
            >
              {displayText(target.file)}
            </code>
          ),
        },
      ]}
    />
  );
}

/** The instances a mixed-targets row covers: a count, and the first few ids. */
function InstanceIds({ ids }: { ids: readonly string[] }) {
  const named = ids.slice(0, NAMED_INSTANCES);
  const rest = ids.length - named.length;
  return (
    <>
      {plural(ids.length, "instance")}:{" "}
      {named.map((id, index) => (
        <span key={id}>
          {index > 0 && ", "}
          <code>{id}</code>
        </span>
      ))}
      {rest > 0 && ` and ${plural(rest, "more", "more")}`}
    </>
  );
}

/** One row per target the instances report, when they do not all report one. */
function MixedTargets({
  workerKey,
  groups,
}: {
  /** The key, for the table's accessible name. */
  workerKey: string;
  /** The groups, two or more. */
  groups: readonly TargetGroup[];
}) {
  const showName = groups.some((group) => group.target?.name !== undefined);
  const showFile = groups.some((group) => group.target?.file !== undefined);
  return (
    <>
      <p
        className="notice"
        role="note"
        data-testid="worker-target-differs"
      >
        Not every instance of this key runs the same way: a redeploy is still
        rolling out, or the instances were built from different code. Each row
        is one way, with the instances that report it.
      </p>
      <Table label={`Targets of ${workerKey}`}>
        <thead>
          <tr>
            <th scope="col">Runs in</th>
            <th scope="col">Processor</th>
            {showName && <th scope="col">Name</th>}
            {showFile && <th scope="col">File</th>}
            <th scope="col">Instances</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ target, ids }) => (
            <tr
              key={ids[0]}
              data-testid="worker-target-group"
            >
              <th
                scope="row"
                title={
                  target === undefined ? undefined : targetKindHint(target.kind)
                }
              >
                {target === undefined ? (
                  <Unknown />
                ) : (
                  targetKindLabel(target.kind)
                )}
              </th>
              <td>
                {target === undefined ? (
                  <Unknown />
                ) : (
                  processorLabel(target.processor)
                )}
              </td>
              {showName && (
                <td>
                  {target?.name !== undefined && (
                    <code>{displayText(target.name)}</code>
                  )}
                </td>
              )}
              {showFile && (
                <td>
                  {target?.file !== undefined && (
                    <code className="worker-target-file">
                      {displayText(target.file)}
                    </code>
                  )}
                </td>
              )}
              <td>
                <InstanceIds ids={ids} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

/**
 * Where a worker key's attempts run: in process, on a worker thread, in a
 * child process or on a custom target, whether they run a function or a
 * processor file, a custom target's name, and the file's path when the API
 * sends it.
 *
 * **A fact about how the worker was built, not a setting**: the target is not
 * among the settings an override replaces, and changing it is a redeploy, so
 * the card offers nothing to change and says so.
 *
 * **A worker too old to report it shows "—"** and a line saying so, never
 * "In process": that is only the default, and reading absence as it would
 * mislabel every worker not yet upgraded.
 *
 * **Instances that disagree are all shown.** One key's instances normally run
 * one build and report one target; when they report different ones — a
 * redeploy mid-rollout — the card lists each target with the instances that
 * report it, rather than the first instance's alone, which would state one
 * build's answer for all of them.
 */
export function WorkerTargetCard({
  workerKey,
  instances,
}: WorkerTargetCardProps) {
  const groups = groupTargets(instances);
  return (
    <Card title="Target">
      <div data-testid="worker-target">
        {groups.length === 0 ? (
          <p className="muted">
            Where this key's attempts run is known once an instance reports.
          </p>
        ) : (
          <>
            <p className="muted worker-target-note">{TARGET_FIXED_NOTE}</p>
            {groups.length === 1 ? (
              <TargetFacts target={groups[0]!.target} />
            ) : (
              <MixedTargets
                workerKey={workerKey}
                groups={groups}
              />
            )}
          </>
        )}
      </div>
    </Card>
  );
}
