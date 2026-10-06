import type { SummonStatusDto } from "../../../api/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { demandKeys } from "../../../api/demand";
import { listProviders, providerKeys } from "../../../api/providers";
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
import { useApiClient } from "../../../context";
import { displayText, formatNumber } from "../../../format";
import { useApiMutation } from "../../../hooks/useApiMutation";
import { useCan, useMeta } from "../../../meta/hooks";
import { providerReadiness } from "../../providers/providerText";
import { TestConnection } from "../../providers/TestConnection";
import { formatMs } from "../duration";
import { useCanMutate } from "../gating";
import { useRefreshInterval } from "../live";
import {
  summonActionsOffered,
  summonCheckSummary,
  summonInert,
  summonOutcome,
  summonStyle,
} from "./summonText";

/** Props of {@link SummonPanel}. */
export interface SummonPanelProps {
  /** The queue. */
  queue: string;
}

/**
 * A queue's summoning (`GET /queues/:queue/summon`): who summons its workers,
 * what is on its way, what holds the next attempt back, and the two opt-in
 * actions — "summon now" and reset (`queues.summon`).
 *
 * Shown only where the status answers 200: the queue screen reads it before
 * offering the tab, and a queue with no summoner in the API's process (409
 * `SUMMON_NOT_CONFIGURED`) has no tab at all.
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
  const status = useQuery({
    queryKey: summonKeys.status(queue),
    queryFn: ({ signal }) => getSummonStatus(api, queue, signal),
    refetchInterval,
    placeholderData: keepPreviousData,
  });
  const invalidate = [
    summonKeys.status(queue),
    demandKeys.queue(queue),
    queueKeys.workers(queue),
  ];
  const summon = useApiMutation({
    mutationFn: (skipCooldown: boolean) => summonNow(api, queue, skipCooldown),
    successMessage: (result) => summonCheckSummary(result),
    invalidate,
    toastErrors: false,
  });
  const reset = useApiMutation({
    mutationFn: () => resetSummon(api, queue),
    successMessage: `Reset the summon state of ${queue}: failures, backoff and circuit cleared`,
    invalidate,
    toastErrors: false,
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
  const actionable = summonActionsOffered(data, canMutate("queues.summon"));
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
      <SummonState status={data} />
      {data.summoner && <Summoner summoner={data.summoner} />}
      {data.pending.length > 0 && (
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
            onClick={() => setConfirming("reset")}
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
        onConfirm={() => reset.mutateAsync()}
      />
    </div>
  );
}

/** What holds the next attempt back, and the last thing that happened. */
function SummonState({ status }: { status: SummonStatusDto }) {
  const last =
    status.last === undefined ? undefined : summonOutcome(status.last.outcome);
  return (
    <KeyValue
      items={[
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
        {
          key: "pending",
          label: "On their way",
          value: (
            <span data-testid="summon-pending-count">
              {formatNumber(status.pending.length)}
            </span>
          ),
          hint: "Summon attempts still counting as workers on their way.",
        },
        {
          key: "failures",
          label: "Consecutive failures",
          value: (
            <span data-testid="summon-failures">
              {formatNumber(status.failures)}
            </span>
          ),
          hint: "Failed, unavailable or lost attempts in a row, towards the circuit. A throttled call is not counted, and an auth or misconfiguration error counts enough to open it at once. A registration or a reset clears them.",
        },
        status.backoffUntil !== undefined && {
          key: "backoff",
          label: "Backing off until",
          value: (
            <span data-testid="summon-backoff">
              <RelativeTime value={status.backoffUntil} />
            </span>
          ),
        },
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
        status.budget !== undefined && {
          key: "budget",
          label: "Budget",
          value: (
            <span data-testid="summon-budget">
              {status.budget.off === true ||
              status.budget.perHour === undefined ||
              status.budget.perDay === undefined ? (
                <>
                  Off: {formatNumber(status.budget.hour)} this hour,{" "}
                  {formatNumber(status.budget.day)} today (UTC), no limit
                </>
              ) : (
                <>
                  {formatNumber(status.budget.hour)} of{" "}
                  {formatNumber(status.budget.perHour)} this hour,{" "}
                  {formatNumber(status.budget.day)} of{" "}
                  {formatNumber(status.budget.perDay)} today (UTC)
                </>
              )}
            </span>
          ),
        },
      ]}
    />
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
