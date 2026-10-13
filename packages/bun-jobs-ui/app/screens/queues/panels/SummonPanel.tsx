import type {
  SummonCapabilitiesDto,
  SummonPolicyDto,
  SummonStatusDto,
} from "../../../api/types";
import type { SummonPolicyPart, SummonPolicyRow } from "./summonPolicyText";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { demandKeys } from "../../../api/demand";
import { isApiError } from "../../../api/errors";
import { listProviders, providerKeys } from "../../../api/providers";
import { queryKeys } from "../../../api/queryKeys";
import { queueKeys } from "../../../api/queues";
import {
  getSummonStatus,
  resetSummon,
  summonKeys,
  summonNow,
} from "../../../api/summon";
import { Badge } from "../../../components/Badge";
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { EmptyState } from "../../../components/EmptyState";
import { Checkbox } from "../../../components/inputs";
import { KeyValue } from "../../../components/KeyValue";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { RelativeTime } from "../../../components/RelativeTime";
import { Spinner } from "../../../components/Spinner";
import { Table } from "../../../components/Table";
import { useToast } from "../../../components/toast";
import { useApiClient } from "../../../context";
import { displayText, formatNumber, plural } from "../../../format";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { canPerform, useCan, useFeature, useMeta } from "../../../meta/hooks";
import { Link } from "../../../router";
import { providerReadiness } from "../../providers/providerText";
import { TestConnection } from "../../providers/TestConnection";
import { summonTabPath } from "../../summoning/paths";
import { formatMs } from "../duration";
import { useCanMutate } from "../gating";
import { useRefreshInterval } from "../live";
import { budgetUsedText } from "./budgetText";
import { SummonBudget } from "./SummonBudget";
import { SummonGroupCard } from "./SummonGroupCard";
import {
  SUMMON_POLICY_DEFAULT_HINT,
  SUMMON_POLICY_ELSEWHERE,
  SUMMON_POLICY_OVERRIDE_HINT,
  summonBudgetDefaulted,
  summonPolicyPerQueue,
  summonPolicyRows,
  summonPolicyVisibility,
} from "./summonPolicyText";
import {
  attemptCoverage,
  COVERAGE_HEADER,
  COVERAGE_NONE,
  SHARED_UNIT_FORBIDDEN,
  showCoverage,
  SUMMON_PARTIAL_HINT,
  summonActionsOffered,
  summonCheckSummary,
  summonInert,
  summonLastDetail,
  summonLastMissing,
  summonOutcome,
  summonPartialText,
  summonStateKnown,
  summonStyle,
} from "./summonText";

/** Props of {@link SummonPanel}. */
export interface SummonPanelProps {
  /** The queue. */
  queue: string;
}

/**
 * A queue's summoning (`GET /queues/:queue/summon`): who summons its workers,
 * what is on its way, what holds the next attempt back, the summon group it
 * is in (when it is in one), and the two opt-in actions — "summon now" and
 * reset (`queues.summon`).
 *
 * Shown only where the status answers 200: the queue screen reads it before
 * offering the tab, and a queue with no summoner in the API's process (409
 * `SUMMON_NOT_CONFIGURED`) has no tab at all.
 *
 * A shared summon unit (a status with `queues`) is one process serving
 * several queues: the panel names them, warns when another group's units
 * were seen on them, and offers the actions only where the caller may
 * summon every one of them ({@link useUnitCanSummon}).
 *
 * Where the API sends it (`features.summonPolicy`), the controller's policy
 * follows the summoner ({@link SummonPolicy}); a status read from another
 * process's controller has none, and says so in a line.
 *
 * `local` is always `true` today. A `false` answer — a controller in another
 * process, read from the store — is shown read-only: no actions, since both
 * need a controller in the API's own process.
 */
export function SummonPanel({ queue }: SummonPanelProps) {
  const api = useApiClient();
  const canMutate = useCanMutate();
  const refetchInterval = useRefreshInterval("summon");
  const [confirming, setConfirming] = useState<"summon" | "reset" | null>(null);
  const [force, setForce] = useState(true);
  // Off each time the dialog opens: clearing the budget is never carried over.
  const [clearBudget, setClearBudget] = useState(false);
  // The API takes `{ budget: true }` (and serves `GET /summon`) only where it says so.
  const canClearBudget = useFeature("summonResetBudget") === true;
  // The status carries the controller's policy only where the API says so.
  const policyFeature = useFeature("summonPolicy") === true;
  const status = useQuery({
    queryKey: summonKeys.status(queue),
    queryFn: ({ signal }) => getSummonStatus(api, queue, signal),
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  const toast = useToast();
  const unitCanSummon = useUnitCanSummon(status.data?.queues);
  // A shared unit's actions need queues.summon on every queue it serves,
  // hidden ones included, and the 403 names none of them: say so.
  const onActionError = (error: Error) => {
    if (
      status.data?.queues !== undefined &&
      isApiError(error) &&
      error.status === 403
    ) {
      toast.error(SHARED_UNIT_FORBIDDEN, {
        description: error.detail ?? error.title,
      });
    }
  };
  const invalidate = [
    summonKeys.status(queue),
    summonKeys.list,
    demandKeys.queue(queue),
    queueKeys.workers(queue),
  ];
  const summon = useApiMutation({
    mutationFn: (skipCooldown: boolean) => summonNow(api, queue, skipCooldown),
    successMessage: (result) => summonCheckSummary(result),
    invalidate,
    toastErrors: false,
    onError: onActionError,
  });
  const reset = useApiMutation({
    mutationFn: (budget: boolean) =>
      resetSummon(api, queue, budget ? { budget: true } : {}),
    successMessage: (_result, budget) =>
      budget
        ? `Reset the summon state of ${queue}: failures, backoff, circuit and budget usage cleared`
        : `Reset the summon state of ${queue}: failures, backoff and circuit cleared`,
    invalidate,
    toastErrors: false,
    onError: onActionError,
  });

  if (status.isPending) {
    return (
      <Spinner
        label="Loading summon status"
        showLabel
      />
    );
  }
  if (status.isError) {
    return (
      <ProblemBanner
        error={status.error}
        title="Could not load the summon status"
        onRetry={() => void status.refetch()}
      />
    );
  }
  if (status.data === null) {
    return (
      <EmptyState
        title="No summoner here"
        description="No summon controller for this queue runs in this API's process."
      />
    );
  }
  const data = status.data;
  const policyView = summonPolicyVisibility(policyFeature, data);
  const actionable = summonActionsOffered(
    data,
    // A single queue's own map decides, as it always has; a shared unit's,
    // every member's map.
    unitCanSummon ?? canMutate("queues.summon"),
  );
  return (
    <div
      className="summon-panel"
      data-testid="queue-summon"
    >
      {data.inert && (
        <p
          className="notice"
          role="note"
          data-testid="summon-inert"
        >
          {summonInert(data.inertReason)}
        </p>
      )}
      {!data.local && (
        <p
          className="notice"
          role="note"
          data-testid="summon-stored"
        >
          This queue's controller runs in another process: its state is read
          from the store, and it can be summoned or reset only from there.
        </p>
      )}
      {data.overlaps !== undefined && data.overlaps.length > 0 && (
        <p
          className="notice"
          role="note"
          data-testid="summon-overlaps"
        >
          {data.queues === undefined
            ? `Workers summoned for another summon group (${data.overlaps.map(displayText).join(", ")}) were seen on this queue at the last check: two units may be serving the same queue.`
            : `Workers summoned for another summon group (${data.overlaps.map(displayText).join(", ")}) were seen on this unit's queues at the last check: two units may be serving the same queues.`}
        </p>
      )}
      <SummonState
        status={data}
        queue={queue}
        policy={policyView === "shown" ? data.policy : undefined}
      />
      {data.group !== undefined && (
        <SummonGroupCard
          group={data.group}
          queue={queue}
          kind={data.summoner?.provider.kind}
        />
      )}
      {data.summoner && <Summoner summoner={data.summoner} />}
      {policyView === "shown" && data.policy !== undefined && (
        <SummonPolicy
          policy={data.policy}
          capabilities={data.summoner?.capabilities}
          queue={queue}
        />
      )}
      {policyView === "elsewhere" && (
        <p
          className="muted"
          data-testid="summon-policy-elsewhere"
        >
          {SUMMON_POLICY_ELSEWHERE}
        </p>
      )}
      {summonStateKnown(data) && data.pending.length > 0 && (
        <PendingTable
          queue={queue}
          queues={data.queues}
          pending={data.pending}
        />
      )}
      {actionable && (
        <div
          className="summon-actions"
          role="group"
          aria-label="Summon actions"
        >
          <Button
            variant="primary"
            onClick={() => setConfirming("summon")}
            disabled={summon.isPending}
          >
            Summon now…
          </Button>
          <Button
            onClick={() => {
              setClearBudget(false);
              setConfirming("reset");
            }}
            disabled={reset.isPending}
          >
            Reset…
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming === "summon"}
        onClose={() => setConfirming(null)}
        title={`Summon a worker for ${queue} now?`}
        description="Runs one check of the queue's summon controller now. The circuit, the budget, the attempts already on their way and the guard against two controllers summoning at once all still apply."
        confirmLabel="Summon now"
        onConfirm={() => summon.mutateAsync(force)}
      >
        <Checkbox
          checked={force}
          onChange={setForce}
          label="Skip the cooldown"
          hint="Summon even if the last attempt was recent. Nothing else is skipped."
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming === "reset"}
        onClose={() => setConfirming(null)}
        title={`Reset the summon state of ${queue}?`}
        description="Clears the consecutive failures, the backoff and an open circuit, so the next check may summon. Attempts already on their way are kept."
        variant="danger"
        confirmLabel="Reset"
        onConfirm={() => reset.mutateAsync(canClearBudget && clearBudget)}
      >
        {canClearBudget && (
          <Checkbox
            checked={clearBudget}
            onChange={setClearBudget}
            label="Also clear budget usage"
            hint="Sets the attempts counted this UTC hour and today back to 0, so the budget allows its full limits again. Every controller on the queue shares the counts."
          />
        )}
      </ConfirmDialog>
    </div>
  );
}

/**
 * Whether the caller may summon or reset a shared unit (`queues`): only with
 * `queues.summon` on **every** queue the status lists, each judged by its own
 * targeted map (`GET /meta/permissions?queue=<member>`, the request the
 * queue screen's own scope makes, so its own queue's is shared with it), and
 * not read-only. `false` while any map is loading or after one failed: the
 * server refuses the action on any member, so a guess would offer a button
 * that fails. Members hidden from the caller cannot be asked about; the
 * server's 403 covers them.
 *
 * `undefined` for a single queue's status (`queues` absent), which reads no
 * other map: its own scope decides, as before.
 */
function useUnitCanSummon(
  queues: readonly string[] | undefined,
): boolean | undefined {
  const api = useApiClient();
  const { readOnly } = useMeta();
  const maps = useQueries({
    queries: (queues ?? []).map((member) => ({
      queryKey: queryKeys.permissions({ queue: member }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.getPermissions({ queue: member }, signal),
    })),
  });
  if (queues === undefined) {
    return undefined;
  }
  return (
    !readOnly &&
    maps.length > 0 &&
    maps.every(
      (map) => map.data !== undefined && canPerform(map.data, "queues.summon"),
    )
  );
}

/** Props of {@link SummonState}. */
interface SummonStateProps {
  /** The status. */
  status: SummonStatusDto;
  /** The queue whose Summon tab this is: marked among a shared unit's queues. */
  queue: string;
  /**
   * The controller's policy where the panel shows it, so the Budget row can
   * say when the budget is the default; `undefined` otherwise.
   */
  policy: SummonPolicyDto | undefined;
}

/**
 * What holds the next attempt back, and the last thing that happened. For
 * summon state the server could not read ({@link summonStateKnown}), only
 * the last outcome: the rest would be placeholders. For a shared unit, first
 * the queues it serves, and a last attempt that registered on only some of
 * them says which it missed ({@link summonLastMissing}) in place of its raw
 * `partial:<queues>` detail.
 */
function SummonState({ status, queue, policy }: SummonStateProps) {
  const last =
    status.last === undefined ? undefined : summonOutcome(status.last.outcome);
  const missing =
    status.last === undefined ? [] : summonLastMissing(status.last);
  const detail =
    status.last === undefined ? undefined : summonLastDetail(status.last);
  const known = summonStateKnown(status);
  return (
    <KeyValue
      items={[
        status.queues !== undefined && {
          key: "unit",
          label: "Shared unit",
          value: (
            <UnitQueues
              queue={queue}
              queues={status.queues}
            />
          ),
          hint: "One summoned process serves these queues, and this status is the unit's. Only the queues you may read are listed.",
        },
        {
          key: "last",
          label: "Last outcome",
          value:
            status.last === undefined || last === undefined ? (
              <span data-testid="summon-last">None yet</span>
            ) : (
              <span data-testid="summon-last">
                <Badge
                  tone={last.tone}
                  title={last.hint}
                >
                  {last.label}
                </Badge>{" "}
                <RelativeTime value={status.last.at} />
                {detail !== undefined && (
                  <span className="muted"> — {detail}</span>
                )}
                {missing.length > 0 && (
                  <span
                    className="summon-last-missing"
                    data-testid="summon-last-missing"
                  >
                    {summonPartialText(missing)}
                  </span>
                )}
              </span>
            ),
          hint:
            status.last !== undefined && missing.length > 0
              ? SUMMON_PARTIAL_HINT
              : undefined,
        },
        known && {
          key: "pending",
          label: "On their way",
          value: (
            <span data-testid="summon-pending-count">
              {formatNumber(status.pending.length)}
            </span>
          ),
          hint: "Summon attempts still counting as workers on their way.",
        },
        known && {
          key: "failures",
          label: "Consecutive failures",
          value: (
            <span data-testid="summon-failures">
              {formatNumber(status.failures)}
            </span>
          ),
          hint: "Failed, unavailable or lost attempts in a row, towards the circuit. A throttled call is not counted, and an auth or misconfiguration error counts enough to open it at once. A registration or a reset clears them.",
        },
        known &&
          status.backoffUntil !== undefined && {
            key: "backoff",
            label: "Backing off until",
            value: (
              <span data-testid="summon-backoff">
                <RelativeTime value={status.backoffUntil} />
              </span>
            ),
          },
        known &&
          status.circuitOpenUntil !== undefined && {
            key: "circuit",
            label: "Circuit open until",
            value: (
              <span data-testid="summon-circuit">
                <RelativeTime value={status.circuitOpenUntil} />
              </span>
            ),
            hint: "After repeated failures nothing is summoned until then, apart from one trial attempt.",
          },
        known &&
          status.budget !== undefined && {
            key: "budget",
            label: "Budget",
            value: (
              <>
                <SummonBudget
                  budget={status.budget}
                  testId="summon-budget"
                  // Its own budget off, the group's applies to it, unless the
                  // group's is off too: then no limit applies at all.
                  group={
                    status.group !== undefined &&
                    status.group.budget.off !== true
                  }
                />
                {summonBudgetDefaulted(policy) && (
                  <>
                    {" "}
                    <DefaultTag />
                  </>
                )}
              </>
            ),
            // The row shows what is left; the counts used stay in view here.
            hint: budgetUsedText(status.budget),
          },
      ]}
    />
  );
}

/** Props of {@link UnitQueues}. */
interface UnitQueuesProps {
  /** The queue whose Summon tab this is: marked in the list. */
  queue: string;
  /** The unit's queues the caller may read (`status.queues`). */
  queues: readonly string[];
}

/**
 * A shared unit's queues in a line, "One process for 3 queues: renders,
 * thumbs, previews", each linked to its Summon tab and this one marked.
 * The count is of the queues listed: ones hidden from the caller are not
 * in it, so it never claims the unit's total.
 */
function UnitQueues({ queue, queues }: UnitQueuesProps) {
  return (
    <span data-testid="summon-unit">
      One process for {plural(queues.length, "queue")}:{" "}
      {queues.map((member, index) => {
        const current = member === queue;
        return (
          <span key={member}>
            {index > 0 && ", "}
            <Link
              to={summonTabPath(member)}
              title={`The Summon tab of ${member}`}
            >
              {displayText(member)}
            </Link>
            {current && <span className="muted"> (this queue)</span>}
          </span>
        );
      })}
    </span>
  );
}

/** The summoner: who provides it, what it declares, and its facts. */
function Summoner({
  summoner,
}: {
  /** The status's summoner. */
  summoner: NonNullable<SummonStatusDto["summoner"]>;
}) {
  const { provider, capabilities, facts } = summoner;
  const factEntries = Object.entries(facts);
  const readiness = providerReadiness(summoner.readiness);
  const preflight = useProviderPreflight(summoner.providerId);
  const canMutate = useCanMutate();
  const name = displayText(provider.displayName ?? provider.kind);
  return (
    <div
      className="summon-summoner"
      data-testid="summon-summoner"
    >
      <h3 className="summon-heading">Summoner</h3>
      <KeyValue
        items={[
          {
            key: "provider",
            label: "Provider",
            value: (
              <span data-testid="summon-provider">
                {displayText(provider.displayName ?? provider.kind)}{" "}
                <span className="muted">
                  {displayText(provider.name)} {displayText(provider.version)}
                </span>
              </span>
            ),
          },
          {
            key: "readiness",
            label: "Readiness",
            value: (
              <Badge
                tone={readiness.tone}
                title={readiness.hint}
                testId="summon-readiness"
              >
                {readiness.label}
              </Badge>
            ),
            hint: readiness.hint,
          },
          // Declared once the summoner is ready: unknown before.
          ...(capabilities === undefined
            ? []
            : [
                {
                  key: "style",
                  label: "Style",
                  value: summonStyle(capabilities.style),
                },
                {
                  key: "boot",
                  // The provider's default: the policy's own is in the Policy block.
                  label: "Provider default boot budget",
                  value: formatMs(capabilities.bootBudgetMs),
                  hint: "How long an attempt counts as a worker on its way before it is lost, unless the policy sets its own.",
                },
                {
                  key: "lifetime",
                  label: "Longest life",
                  value:
                    capabilities.maxLifetimeMs === null
                      ? "No platform limit known"
                      : formatMs(capabilities.maxLifetimeMs),
                },
              ]),
          ...factEntries.map(([key, value]) => ({
            key: `fact-${key}`,
            label: displayText(key),
            value: <code>{displayText(value)}</code>,
          })),
        ]}
      />
      {summoner.providerId !== undefined &&
        preflight &&
        canMutate("providers.validate") && (
          <TestConnection
            providerId={summoner.providerId}
            label={name}
          />
        )}
    </div>
  );
}

/** Props of {@link SummonPolicy}. */
interface SummonPolicyProps {
  /** The status's policy. */
  policy: SummonPolicyDto;
  /** The summoner's capabilities, once it is ready: the platform's shutdown, lifetime cap and style. */
  capabilities: SummonCapabilitiesDto | undefined;
  /** The queue, for the per-queue table's name. */
  queue: string;
}

/**
 * The policy the queue's controller runs with (`status.policy`), every value
 * in words and marked "default" where the policy did not set it
 * ({@link summonPolicyRows}); a shared unit's per-queue capacities as a
 * table after Workers, each value the unit's overrides set marked
 * "override". The platform's shutdown is the summoner's, not the policy's.
 */
function SummonPolicy({ policy, capabilities, queue }: SummonPolicyProps) {
  const rows = summonPolicyRows(policy, capabilities);
  const perQueue = summonPolicyPerQueue(policy);
  const items = rows.flatMap((row) => [
    {
      key: row.id,
      label: row.label,
      value: <PolicyValue row={row} />,
      hint: row.hint,
    },
    ...(row.id === "workers" && perQueue !== undefined
      ? [
          {
            key: "per-queue",
            label: "Per queue",
            value: (
              <PerQueueTable
                queue={queue}
                rows={perQueue}
              />
            ),
            hint: "Each of the unit's queues' own capacity: what its demand alone may ask for.",
          },
        ]
      : []),
  ]);
  return (
    <div
      className="summon-policy"
      data-testid="summon-policy"
    >
      <h3 className="summon-heading">Policy</h3>
      <KeyValue items={items} />
    </div>
  );
}

/** A policy row's value: its pieces, each muted or tagged as the row says. */
function PolicyValue({
  row,
}: {
  /** The row. */
  row: SummonPolicyRow;
}) {
  return (
    <span data-testid={`summon-policy-${row.id}`}>
      {row.parts.map((part, index) => (
        <span
          // The pieces are fixed for a row: their position is their identity.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
        >
          {part.joiner}
          <PolicyPart part={part} />
          {part.tag && (
            <>
              {" "}
              <DefaultTag />
            </>
          )}
        </span>
      ))}
      {row.tag && (
        <>
          {" "}
          <DefaultTag />
        </>
      )}
    </span>
  );
}

/** One piece of a policy value: its names as code chips, or its text. */
function PolicyPart({
  part,
}: {
  /** The piece. */
  part: SummonPolicyPart;
}) {
  if (part.names !== undefined && part.names.length > 0) {
    return (
      <span className="summon-policy-names">
        {part.names.map((name) => (
          <code key={name}>{name}</code>
        ))}
      </span>
    );
  }
  return <span className={part.muted ? "muted" : undefined}>{part.text}</span>;
}

/** The muted "default" tag of a value the policy did not set. */
function DefaultTag() {
  return (
    <span
      className="summon-policy-tag muted"
      title={SUMMON_POLICY_DEFAULT_HINT}
      data-testid="summon-policy-default"
    >
      default
    </span>
  );
}

/** A shared unit's per-queue capacities, each override marked. */
function PerQueueTable({
  queue,
  rows,
}: {
  /** The queue whose tab this is, for the table's name. */
  queue: string;
  /** The rows ({@link summonPolicyPerQueue}). */
  rows: NonNullable<ReturnType<typeof summonPolicyPerQueue>>;
}) {
  return (
    <div data-testid="summon-policy-per-queue">
      <Table label={`Per-queue capacity of the unit serving ${queue}`}>
        <thead>
          <tr>
            <th scope="col">Queue</th>
            <th scope="col">Jobs per worker</th>
            <th
              scope="col"
              className="num"
            >
              Max workers
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.queue}
              data-testid={`summon-policy-per-queue-${row.queue}`}
            >
              <th scope="row">{row.queue}</th>
              <td>
                {row.jobsPerWorker}
                {row.jobsPerWorkerOverride && <OverrideTag />}
              </td>
              <td className="num">
                {row.maxWorkers}
                {row.maxWorkersOverride && <OverrideTag />}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** The "override" tag of a per-queue value the unit's overrides set. */
function OverrideTag() {
  return (
    <>
      {" "}
      <Badge
        tone="accent"
        title={SUMMON_POLICY_OVERRIDE_HINT}
        testId="summon-policy-override"
      >
        override
      </Badge>
    </>
  );
}

/**
 * Whether the summoner's provider has a preflight, so "Test connection"
 * checks the platform: `GET /providers` says so, read only where the API
 * serves it (`features.providers`) and the caller may read providers
 * (`providers.read`). Without either, the answer is no and nothing is read.
 */
function useProviderPreflight(providerId: string | undefined): boolean {
  const api = useApiClient();
  const meta = useMeta();
  const canRead = useCan("providers.read");
  const enabled =
    providerId !== undefined && meta.features.providers && canRead;
  const list = useQuery({
    queryKey: providerKeys.list,
    queryFn: ({ signal }) => listProviders(api, signal),
    enabled,
    staleTime: 30_000,
  });
  return (
    enabled &&
    list.data?.providers.some(
      (item) => item.id === providerId && item.preflight,
    ) === true
  );
}

/**
 * The attempts on their way. A shared unit's carry their coverage, how far
 * each has got on each of the unit's queues: a Coverage column, where at
 * least one attempt has it.
 */
function PendingTable({
  queue,
  queues,
  pending,
}: {
  /** The queue, for the table's name; marked in a Coverage cell. */
  queue: string;
  /** A shared unit's queues (`status.queues`), the order a Coverage cell lists them in; `undefined` for one queue. */
  queues: readonly string[] | undefined;
  /** The attempts, oldest first. */
  pending: SummonStatusDto["pending"];
}) {
  // Only when the API sent some (`serialize.exposeSummonHandles`): nothing
  // marks handles withheld.
  const showHandles = pending.some((attempt) => attempt.handles !== undefined);
  const coverage = showCoverage(pending);
  return (
    <Table label={`Summon attempts on their way for ${queue}`}>
      <thead>
        <tr>
          <th scope="col">Attempt</th>
          <th scope="col">Started</th>
          <th scope="col">Lost unless a worker registers</th>
          <th
            scope="col"
            className="num"
          >
            Workers
          </th>
          <th scope="col">Summoner</th>
          {coverage && <th scope="col">{COVERAGE_HEADER}</th>}
          {showHandles && <th scope="col">Handles</th>}
        </tr>
      </thead>
      <tbody>
        {pending.map((attempt) => (
          <tr
            key={attempt.id}
            data-testid={`summon-pending-${attempt.id}`}
          >
            <th scope="row">
              <code>{displayText(attempt.id)}</code>
            </th>
            <td>
              <RelativeTime value={attempt.at} />
            </td>
            <td>
              <RelativeTime value={attempt.until} />
            </td>
            <td className="num">{formatNumber(attempt.count)}</td>
            <td>{displayText(attempt.kind)}</td>
            {coverage && (
              <td>
                <CoverageCell
                  attempt={attempt.id}
                  badges={attemptCoverage(attempt.coverage, queues, queue)}
                />
              </td>
            )}
            {showHandles && (
              <td>
                {attempt.handles?.map((handle) => (
                  <code
                    key={handle}
                    className="worker-target-file"
                  >
                    {displayText(handle)}
                  </code>
                ))}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Props of {@link CoverageCell}. */
interface CoverageCellProps {
  /** The attempt's id, naming each badge's `data-testid`. */
  attempt: string;
  /** Its coverage's badges ({@link attemptCoverage}); `undefined` for an attempt without. */
  badges: ReturnType<typeof attemptCoverage>;
}

/**
 * One attempt's coverage: a badge per queue — "✓ renders" registered,
 * "renders pending", "✗ renders missing" — this tab's queue marked; "—" for
 * an attempt without (one queue's, or a status whose reads of it failed).
 */
function CoverageCell({ attempt, badges }: CoverageCellProps) {
  if (badges === undefined || badges.length === 0) {
    return <span className="muted">{COVERAGE_NONE}</span>;
  }
  return (
    <ul className="summon-coverage">
      {badges.map((badge) => (
        <li key={badge.queue}>
          <Badge
            tone={badge.tone}
            title={badge.title}
            testId={`summon-coverage-${attempt}-${badge.queue}`}
          >
            {badge.label}
          </Badge>
          {badge.current && <span className="muted"> (this queue)</span>}
        </li>
      ))}
    </ul>
  );
}
