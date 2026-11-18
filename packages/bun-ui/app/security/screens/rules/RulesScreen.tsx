/**
 * The request rules of a scope (ui.md §4.3): its own (the draft's, else
 * the published version's), each with its mode, action, weight, its hits
 * and dry-run would-blocks in the last 24 hours and how the draft changes
 * it; the rules it inherits, with the scope each came from and whether it
 * is locked; and the managed probe set as it applies here, which ships
 * with bun-security's release. Changes go through the scope's draft
 * (U3's pieces): **New rule** and **Edit** open the editor, **Remove**
 * saves the draft without the rule, **Publish** and **Discard** act on the
 * draft. **Test a request** runs one through the effective policy.
 */
import { Table } from "../../../kit/components/Table";
import { useState } from "react";
import { Badge } from "../../../kit/components/Badge";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { Spinner } from "../../../kit/components/Spinner";
import { useToast } from "../../../kit/components/toast";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { useCan, useMeta } from "../../meta/hooks";
import { Link } from "../../router";
import { scopeLabel } from "../../scope/scope";
import type { ApprovalDto, PublishOutcome } from "../lists/PublishDialog";
import { PublishDialog } from "../lists/PublishDialog";
import { isConflict, useDiscardDraft, useSaveDraft } from "../lists/policy";
import type { RuleJson } from "./ruleModel";
import { removeRule } from "./ruleModel";
import { useRuleHits, useRulesPolicy } from "./rulesPolicy";

/** Props of {@link RulesScreen}. */
export interface RulesScreenProps {
  /** The scope on screen. */
  scope: string;
}

/** A mode's badge. */
function Mode({ mode }: { mode: unknown }) {
  if (mode === "dryRun") return <Badge tone="warning">Dry run</Badge>;
  if (mode === "off") return <Badge tone="neutral">Off</Badge>;
  return <Badge tone="success">Enforced</Badge>;
}

/** A count, or a dash. */
function count(n: number | undefined): string {
  return n === undefined || n === 0 ? "—" : n.toLocaleString("en");
}

/** The managed probe set's settings, for people. */
function managedText(managed: unknown): string {
  if (managed === false) return "Off.";
  const settings =
    typeof managed === "object" && managed !== null
      ? (managed as { mode?: unknown; exclude?: unknown; weight?: unknown })
      : {};
  const mode = settings.mode === "enforce" ? "Enforced" : "In dry run";
  const excluded =
    Array.isArray(settings.exclude) && settings.exclude.length > 0
      ? `, leaving out ${settings.exclude.join(", ")}`
      : "";
  const weight =
    typeof settings.weight === "number"
      ? `, weight ${settings.weight} a hit`
      : "";
  return `${mode}${excluded}${weight}.`;
}

/** See the module's description. */
export function RulesScreen({ scope }: RulesScreenProps) {
  const meta = useMeta();
  const canDraft = useCan("policy:draft");
  const canPublish = useCan("policy:publish");
  const canTest = useCan("rules:test");
  const canAnalytics = useCan("analytics:read");
  const toast = useToast();
  const data = useRulesPolicy(scope, true);
  const hits = useRuleHits(scope, canAnalytics);
  const save = useSaveDraft(scope);
  const discard = useDiscardDraft(scope);
  const [removing, setRemoving] = useState<RuleJson | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [approval, setApproval] = useState<ApprovalDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  if (data.pending) return <Spinner label="Loading the rules" />;
  if (data.error !== null && data.error !== undefined) {
    return (
      <div className="screen">
        <ErrorView
          headingLevel={1}
          error={data.error}
          title="The rules could not be read"
          onRetry={() => void data.reload()}
        />
      </div>
    );
  }
  const draft = data.policy?.draft ?? null;
  const head = data.policy?.head ?? null;
  const headById = new Map(data.headRules.map((rule) => [rule.id, rule]));
  const ownIds = new Set(data.own.map((rule) => rule.id));
  const removedInDraft =
    draft === null ? [] : data.headRules.filter((rule) => !ownIds.has(rule.id));
  const stateOf = (rule: RuleJson): string | null => {
    if (draft === null) return null;
    const published = headById.get(rule.id);
    if (published === undefined) return "added in the draft";
    return JSON.stringify(published) === JSON.stringify(rule)
      ? null
      : "changed in the draft";
  };
  const hitsOf = (id: unknown) => hits.data?.get(`rule:${String(id)}`);
  const onPublished = (outcome: PublishOutcome) => {
    setPublishOpen(false);
    if (outcome.kind === "approval") setApproval(outcome.approval);
    else toast.success(`Published version ${outcome.number}`);
    void data.reload();
  };
  const confirmRemove = async () => {
    if (removing === null) return;
    setProblem(null);
    try {
      await save(
        removeRule(data.base, String(removing.id)),
        draft?.revision ?? null,
      );
      toast.success(`Rule “${String(removing.id)}” removed in the draft`);
    } catch (error) {
      setProblem(
        isConflict(error)
          ? "The draft changed meanwhile: it was read again; remove the rule again if it still should go."
          : isApiError(error)
            ? (error.detail ?? error.title)
            : "The rule was not removed.",
      );
      void data.reload();
    }
  };
  return (
    <div
      className="screen"
      data-testid="rules"
    >
      <div className="screen-header">
        <h1>Request rules: {scopeLabel(scope)}</h1>
        <div className="screen-actions">
          {canTest ? (
            <Link
              to={`/rules/test?${scopeQuery}`}
              data-testid="rules-test-link"
            >
              Test a request
            </Link>
          ) : null}
          {canDraft ? (
            <Link
              to={`/rules/new?${scopeQuery}`}
              data-testid="new-rule"
            >
              New rule
            </Link>
          ) : null}
        </div>
      </div>
      {draft === null ? null : (
        <div
          className="notice"
          data-testid="rules-draft"
        >
          <p>
            A draft is open: its changes reach no service until it is published
            {removedInDraft.length === 0
              ? "."
              : `; it removes ${removedInDraft.map((rule) => String(rule.id)).join(", ")}.`}
          </p>
          {canPublish ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="rules-publish"
              onClick={() => setPublishOpen(true)}
            >
              Publish…
            </Button>
          ) : null}
          {canDraft ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="rules-discard"
              onClick={() => setDiscardOpen(true)}
            >
              Discard the draft
            </Button>
          ) : null}
        </div>
      )}
      {approval === null ? null : (
        <p
          role="status"
          data-testid="rules-approval"
        >
          An approval was opened for another operator to decide:{" "}
          <Link
            to={`/approvals/${encodeURIComponent(approval.id)}?${scopeQuery}`}
          >
            open it
          </Link>
          .
        </p>
      )}
      {problem === null ? null : <p role="alert">{problem}</p>}
      <h2>This scope's rules</h2>
      {data.own.length === 0 ? (
        <p data-testid="rules-own-empty">No rule of its own.</p>
      ) : (
        <Table
          label="This scope's rules"
          testId="rules-own"
        >
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Mode</th>
              <th scope="col">A hit</th>
              <th scope="col">Hits (24 h)</th>
              <th scope="col">Would block (24 h, dry run)</th>
              <th scope="col">Draft</th>
              {canDraft ? <th scope="col">Change</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.own.map((rule) => {
              const id = String(rule.id);
              const state = stateOf(rule);
              return (
                <tr
                  key={id}
                  data-testid="rule-row"
                >
                  <td>
                    <code>{id}</code>
                    {rule.locked === true ? (
                      <>
                        {" "}
                        <Badge tone="info">locked below</Badge>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <Mode mode={rule.mode} />
                  </td>
                  <td>
                    {typeof rule.action === "string" ? rule.action : "block"}
                  </td>
                  <td>{count(hitsOf(id)?.hits)}</td>
                  <td>{count(hitsOf(id)?.wouldBlock)}</td>
                  <td>{state ?? "—"}</td>
                  {canDraft ? (
                    <td>
                      <Link
                        to={`/rules/edit/${encodeURIComponent(id)}?${scopeQuery}`}
                        data-testid={`rule-edit-${id}`}
                      >
                        Edit
                      </Link>{" "}
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`rule-remove-${id}`}
                        onClick={() => setRemoving(rule)}
                      >
                        Remove
                      </Button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {data.inherited.length === 0 ? null : (
        <>
          <h2>Inherited</h2>
          <Table
            label="Inherited rules"
            testId="rules-inherited"
          >
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">From</th>
                <th scope="col">Mode</th>
                <th scope="col">A hit</th>
                <th scope="col">Hits (24 h)</th>
                <th scope="col">Would block (24 h, dry run)</th>
              </tr>
            </thead>
            <tbody>
              {data.inherited.map(({ rule, origin, locked }) => {
                const id = String(rule.id);
                return (
                  <tr
                    key={id}
                    data-testid="rule-inherited-row"
                  >
                    <td>
                      <code>{id}</code>
                      {locked ? (
                        <>
                          {" "}
                          <Badge tone="info">locked</Badge>
                        </>
                      ) : null}
                    </td>
                    <td>{scopeLabel(origin)}</td>
                    <td>
                      <Mode mode={rule.mode} />
                    </td>
                    <td>
                      {typeof rule.action === "string" ? rule.action : "block"}
                    </td>
                    <td>{count(hitsOf(id)?.hits)}</td>
                    <td>{count(hitsOf(id)?.wouldBlock)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </>
      )}
      <h2>The managed probe set</h2>
      <p data-testid="rules-managed">
        {managedText(data.managed)} It ships with bun-security {meta.version}:
        its probes of <code>.env</code>, VCS folders, WordPress and other admin
        paths, scanner agents and malformed headers change only with a release.
      </p>
      <PublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        scope={scope}
        expectedHead={head?.id ?? null}
        summary="Publishes the draft's rules (and any other change it holds)."
        canEstimate={canTest}
        onPublished={onPublished}
        onConflict={() => {
          setPublishOpen(false);
          setProblem(
            "The scope was published meanwhile: the draft was read again; publish again once it is checked.",
          );
          void data.reload();
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        isApiError={isApiError}
        variant="danger"
        title={`Remove the rule “${String(removing?.id ?? "")}”?`}
        description="It is removed in the draft; services keep it until the draft is published."
        confirmLabel="Remove"
        pendingLabel="Removing…"
        onConfirm={confirmRemove}
      />
      <ConfirmDialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        isApiError={isApiError}
        variant="danger"
        title="Discard the draft?"
        description="The draft is deleted, with every change it holds, not only its rules."
        confirmLabel="Discard draft"
        onConfirm={async () => {
          if (draft !== null) await discard(draft.revision);
          toast.success("Draft discarded");
        }}
      />
    </div>
  );
}
