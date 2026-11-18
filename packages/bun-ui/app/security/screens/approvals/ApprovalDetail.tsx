/**
 * One approval (ui.md §8, control-plane.md §5.4): what it would do, why it
 * needs a second operator, who asked and when it expires; for a policy
 * change, its diff (`GET /approvals/:id/diff`: the policy it would publish
 * against the head it expects, never the scope's draft, which may have
 * moved on) and, with `rules:test`, its impact estimate on demand
 * (`POST /approvals/:id/impact`); for any other change, its summary.
 * **Approve** and **Reject**, with a reason, are offered to an operator
 * who may make the change on its scope and is not its author; approving
 * carries the change out, behind the change's step-up.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "../../../kit/components/Badge";
import { Button } from "../../../kit/components/Button";
import { JsonView } from "../../../kit/components/JsonView";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ChangesTable } from "../../components/ChangesTable";
import { ErrorView } from "../../components/ErrorView";
import { ImpactSummary } from "../../components/ImpactSummary";
import { when } from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { useMe } from "../../meta/me";
import { useScopeCan } from "../../meta/useScopeCan";
import { Link } from "../../router";
import { useParams } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { withStepUp } from "../../stepUp";
import type { ApprovalDto } from "./approvalQueries";
import {
  ACTIONS,
  approvalKeys,
  changesPolicy,
  decidingPermission,
  isOpen,
  STATUSES,
} from "./approvalQueries";

/** Props of {@link ApprovalDetail}. */
export interface ApprovalDetailProps {
  /** The scope on screen (links keep it). */
  scope: string;
}

/** See the module's description. */
export function ApprovalDetail({ scope }: ApprovalDetailProps) {
  const { id = "" } = useParams<{ id: string }>();
  const { client } = useSecurityClient();
  const approval = useQuery({
    queryKey: approvalKeys.detail(id),
    queryFn: ({ signal }) =>
      dataOf(client.get("/approvals/:id", { params: { id }, signal })),
  });
  const back = (
    <p>
      <Link to={`/approvals?scope=${encodeURIComponent(scope)}`}>
        Approvals
      </Link>
    </p>
  );
  if (approval.isPending) return <Spinner label="Loading the approval" />;
  if (approval.isError) {
    return (
      <div className="screen">
        {back}
        <ErrorView
          headingLevel={1}
          error={approval.error}
          title="The approval could not be read"
          onRetry={() => void approval.refetch()}
        />
      </div>
    );
  }
  return (
    <div
      className="screen"
      data-testid="approval-detail"
    >
      {back}
      <ApprovalView approval={approval.data} />
    </div>
  );
}

/** The approval read. */
function ApprovalView({ approval }: { approval: ApprovalDto }) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const me = useMe();
  const can = useScopeCan(approval.scope);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const policy = changesPolicy(approval);
  const diff = useQuery({
    queryKey: approvalKeys.diff(approval.id),
    enabled: policy,
    // The approval's change is fixed when it opens.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/approvals/:id/diff", {
          params: { id: approval.id },
          signal,
        }),
      ),
  });
  const impact = useMutation({
    mutationFn: () =>
      dataOf(
        client.post("/approvals/:id/impact", {
          params: { id: approval.id },
          body: {},
        }),
      ),
  });
  const status = STATUSES[approval.status];
  const author = approval.author === me.id;
  const mayDecide =
    isOpen(approval) && !author && can(decidingPermission(approval));
  const decide = async (approve: boolean) => {
    setBusy(true);
    setOutcome(null);
    try {
      const path = approve
        ? ("/approvals/:id/approve" as const)
        : ("/approvals/:id/reject" as const);
      const answer = await withStepUp(() =>
        dataOf(
          client.post(path, {
            params: { id: approval.id },
            body: {
              revision: approval.revision,
              ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
            },
          }),
        ),
      );
      setOutcome(
        answer.approval.status === "stale"
          ? "Stale: the policy moved on since it was asked, so nothing was published."
          : approve
            ? "Approved: the change is carried out."
            : "Rejected.",
      );
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
    } catch (error) {
      setOutcome(
        isApiError(error)
          ? error.status === 409
            ? "The approval changed meanwhile: read it again."
            : `Not decided: ${error.detail ?? error.title}`
          : "Not decided.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h1>
        {ACTIONS[approval.action]}: {scopeLabel(approval.scope)}{" "}
        <Badge tone={status.tone}>{status.label}</Badge>
      </h1>
      <dl
        className="key-value"
        data-testid="approval-facts"
      >
        <dt>Asked by</dt>
        <dd>
          {approval.author}
          {author ? " (you: another operator decides)" : ""}
        </dd>
        <dt>Asked</dt>
        <dd>{when(approval.createdAt)}</dd>
        <dt>Expires</dt>
        <dd>{when(approval.expiresAt)}</dd>
        {approval.decidedBy === null ? null : (
          <>
            <dt>Decided</dt>
            <dd>
              by {approval.decidedBy}, {when(approval.decidedAt)}
              {approval.reason === null ? "" : `: “${approval.reason}”`}
            </dd>
          </>
        )}
      </dl>
      {approval.dangerous.length === 0 ? null : (
        <section aria-label="Why it needs an approval">
          <h2>Why it needs an approval</h2>
          <ul data-testid="approval-dangerous">
            {approval.dangerous.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      {policy ? (
        <section aria-label="The change">
          <h2>The change</h2>
          {diff.isError ? (
            <ErrorView
              error={diff.error}
              title="The change could not be read"
            />
          ) : diff.data === undefined ? (
            <Spinner label="Reading the change" />
          ) : diff.data.changes.length === 0 ? (
            <p data-testid="approval-no-change">It changes nothing.</p>
          ) : (
            <>
              <p className="muted">
                Against{" "}
                {diff.data.from === "none"
                  ? "no published policy"
                  : `version ${diff.data.from}`}
                .
              </p>
              <ChangesTable
                changes={diff.data.changes}
                testId="approval-diff"
              />
            </>
          )}
          {can("rules:test") ? (
            <div>
              <Button
                size="sm"
                data-testid="approval-impact"
                disabled={impact.isPending}
                onClick={() => impact.mutate()}
              >
                {impact.isPending ? "Estimating…" : "Estimate impact"}
              </Button>
              {impact.isError ? (
                <ErrorView
                  error={impact.error}
                  title="The estimate failed"
                />
              ) : null}
              {impact.data === undefined ? null : (
                <ImpactSummary
                  impact={impact.data}
                  testId="approval-impact-summary"
                />
              )}
            </div>
          ) : null}
        </section>
      ) : (
        <section aria-label="The change">
          <h2>The change</h2>
          <JsonView
            value={approval.summary}
            label="Summary"
            expandDepth={2}
          />
        </section>
      )}
      {mayDecide ? (
        <form
          className="filters"
          aria-label="Decide"
          onSubmit={(event) => event.preventDefault()}
        >
          <label>
            Reason (optional){" "}
            <input
              className="input"
              value={reason}
              maxLength={500}
              data-testid="approval-reason"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="filters-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              data-testid="approval-approve"
              onClick={() => void decide(true)}
            >
              {approval.status === "review" ? "Close the review" : "Approve"}
            </Button>
            {approval.status === "pending" ? (
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                data-testid="approval-reject"
                onClick={() => void decide(false)}
              >
                Reject
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
      {outcome === null ? null : (
        <p
          role="status"
          data-testid="approval-outcome"
        >
          {outcome}
        </p>
      )}
    </>
  );
}
