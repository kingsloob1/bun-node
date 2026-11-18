/**
 * A bulk lift (ui.md §4.2): the list's filter, a dry-run count first
 * ("lift 1,204 bans from rule X…"), then the lift, behind a step-up (the
 * popup, retried once) or, under two-person approvals, an approval opened.
 */
import type { BanFilters } from "./banQueries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { useSecurityClient } from "../../context";
import { withStepUp } from "../../stepUp";

/** Props of {@link BulkLiftDialog}. */
export interface BulkLiftDialogProps {
  /** Open. */
  open: boolean;
  /** Closes it. */
  onClose: () => void;
  /** The scope. */
  scope: string;
  /** The list's filters. */
  filters: BanFilters;
}

/** The lift's body for `filters` on `scope` (active bans only, whatever the list shows). */
function liftBody(scope: string, filters: BanFilters) {
  return {
    scope,
    ...(filters.kind === "" ? {} : { kind: filters.kind }),
    ...(filters.source === "" ? {} : { source: filters.source }),
    ...(filters.rule.trim() === "" ? {} : { rule: filters.rule.trim() }),
    ...(filters.search.trim() === "" ? {} : { search: filters.search.trim() }),
  };
}

/** See the module's description. */
export function BulkLiftDialog({
  open,
  onClose,
  scope,
  filters,
}: BulkLiftDialogProps) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<string | null>(null);
  // The dry run: what the lift would lift, counted when the dialog opens.
  const count = useQuery({
    queryKey: ["bans", "liftCount", scope, filters],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const result = await dataOf(
        client.post("/bans/lift", {
          body: { ...liftBody(scope, filters), dryRun: true },
        }),
      );
      return "matched" in result ? result.matched : 0;
    },
  });
  const matched = count.data ?? null;
  const error = count.isError
    ? isApiError(count.error)
      ? (count.error.detail ?? count.error.title)
      : "The count failed."
    : null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      isApiError={isApiError}
      variant="danger"
      title="Lift the matching bans"
      confirmLabel={
        matched === null ? "Lift" : `Lift ${matched.toLocaleString()} bans`
      }
      pendingLabel="Lifting…"
      confirmDisabled={matched === null || matched === 0 || outcome !== null}
      closeOnSuccess={false}
      onConfirm={async () => {
        const answer = await withStepUp(() =>
          dataOf(client.post("/bans/lift", { body: liftBody(scope, filters) })),
        );
        if ("lifted" in answer)
          setOutcome(`Lifted ${answer.lifted.toLocaleString()} bans.`);
        else
          setOutcome(
            "Two-person approval is on: an approval was opened for another operator to decide.",
          );
        await queryClient.invalidateQueries({ queryKey: ["bansList"] });
      }}
    >
      <div data-testid="bulk-lift">
        {error !== null ? (
          <p role="alert">{error}</p>
        ) : matched === null ? (
          <p>Counting the active bans the filter matches…</p>
        ) : (
          <p data-testid="bulk-lift-count">
            {matched === 0
              ? "No active ban matches the filter."
              : `${matched.toLocaleString()} active ${matched === 1 ? "ban matches" : "bans match"} the filter: every one will be lifted, and the agents told.`}
          </p>
        )}
        {outcome === null ? null : (
          <p
            role="status"
            data-testid="bulk-lift-outcome"
          >
            {outcome}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
