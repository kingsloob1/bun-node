import type { SummonStatusDto } from "../../../api/types";
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
  SHARED_UNIT_FORBIDDEN,
  summonActionsOffered,
  summonCheckSummary,
  summonInert,
  summonOutcome,
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
          data-testid="summon-remote"
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
      />
      {data.group !== undefined && (
        <SummonGroupCard
          group={data.group}
          queue={queue}
          kind={data.summoner?.provider.kind}
        />
      )}
      {data.summoner && <Summoner summoner={data.summoner} />}
      {summonStateKnown(data) && data.pending.length > 0 && (
        <PendingTable
          queue={queue}
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
}

/**
 * What holds the next attempt back, and the last thing that happened. For
 * summon state the server could not read ({@link summonStateKnown}), only
 * the last outcome: the rest would be placeholders. For a shared unit, first
 * the queues it serves.
 */
function SummonState({ status, queue }: SummonStateProps) {
  const last =
    status.last === undefined ? undefined : summonOutcome(status.last.outcome);
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
                {status.last.detail !== undefined && (
                  <span className="muted">
                    {" "}
                    — {displayText(status.last.detail)}
                  </span>
                )}
              </span>
            ),
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
              <SummonBudget
                budget={status.budget}
                testId="summon-budget"
                // Its own budget off, the group's applies to it, unless the
                // group's is off too: then no limit applies at all.
                group={
                  status.group !== undefined && status.group.budget.off !== true
                }
              />
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
                  label: "Boot budget",
                  value: formatMs(capabilities.bootBudgetMs),
                  hint: "How long an attempt counts as a worker on its way before it is lost.",
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

/** The attempts on their way. */
function PendingTable({
  queue,
  pending,
}: {
  /** The queue, for the table's name. */
  queue: string;
  /** The attempts, oldest first. */
  pending: SummonStatusDto["pending"];
}) {
  // Only when the API sent some (`serialize.exposeSummonHandles`): nothing
  // marks handles withheld.
  const showHandles = pending.some((attempt) => attempt.handles !== undefined);
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
