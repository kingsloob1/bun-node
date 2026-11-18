/**
 * `/policies` (ui.md §3): a scope's policy editor. One tab per layer, each
 * field showing what is set here, what is inherited and from where, and
 * what a scope above locked (the published effective policy's `origins` and
 * `locked`, PR-AN2). Edits collect as unsaved changes over the draft (else
 * the published version); **Save draft** writes them at the revision read
 * (a `409` when someone saved first; a `422`'s issues are shown on their
 * fields), **Discard draft** drops the draft, and **Publish** (U3's dialog:
 * an impact estimate, a typed confirmation for a dangerous change, a
 * step-up, or an approval) puts the saved draft in force, with the crawler
 * conflicts the agents report above it. The draft's changes against the
 * published version are listed; the version history is a link away. Every
 * tab can switch to JSON over its keys. An element the operator may not
 * use is absent.
 */
import type { ApprovalDto, PublishOutcome } from "../lists/PublishDialog";
import type { JsonObject, PolicyPath } from "./paths";
import type { PolicyEditorState } from "./editorContext";
import type { SchemaNode } from "./schema";
import type { PolicyTab } from "./sections";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Card } from "../../../kit/components/Card";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { JsonEditor } from "../../../kit/components/JsonEditor";
import { ProblemBanner } from "../../../kit/components/ProblemBanner";
import { Spinner } from "../../../kit/components/Spinner";
import { UrlTabs } from "../../../kit/components/Tabs";
import { useToast } from "../../../kit/components/toast";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { useSecurityClient } from "../../context";
import { useCan, useGlobalCanFn } from "../../meta/hooks";
import { Link } from "../../router";
import { useRouter } from "../../routing";
import { scopeLabel, SCOPE_PARAM } from "../../scope/scope";
import {
  isConflict,
  listsKeys,
  useDiscardDraft,
  usePolicyLists,
  useSaveDraft,
} from "../lists/policy";
import { PublishDialog } from "../lists/PublishDialog";
import { dryRunCount } from "../services/figures";
import { ConflictList } from "./ConflictList";
import { useCrawlerConflicts } from "./crawlers";
import { CrawlersTab } from "./CrawlersTab";
import { DraftEffect } from "./DraftEffect";
import { PolicyEditorContext, usePolicyEditor } from "./editorContext";
import { SchemaFields } from "./fields";
import { KeyedItems } from "./KeyedItems";
import { LadderTab } from "./LadderTab";
import { dotted, setAt } from "./paths";
import { RuleEditorSlot } from "./RuleEditorSlot";
import { propertiesOf } from "./schema";
import { usePolicySchema } from "./useSchema";
import { pick, POLICY_TABS, tabOf } from "./sections";
import { countedSummary, limitSummary } from "./summaries";
import "./policies.css";

/** Props of {@link PolicyEditor}. */
export interface PolicyEditorProps {
  /** The scope edited. */
  scope: string;
}

/** A schema node of the policy's top-level `key`. */
function nodeOf(schema: SchemaNode, key: string): SchemaNode {
  return propertiesOf(schema)?.[key] ?? {};
}

/** The JSON form of a tab: its keys as set here, and the published effective values beside. */
function TabJson({ tab }: { tab: PolicyTab }) {
  const editor = usePolicyEditor();
  const keys = tab.kind === "json" ? null : tab.keys;
  const [text, setText] = useState(() =>
    JSON.stringify(
      keys === null ? editor.working : pick(editor.working, keys),
      null,
      2,
    ),
  );
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div
      className="policy-json"
      data-testid="tab-json"
    >
      <JsonEditor
        value={text}
        aria-label={`${tab.label} as JSON`}
        rows={18}
        readOnly={!editor.canEdit}
        onChange={(state) => {
          setText(state.text);
          if (state.error !== null) return;
          if (
            typeof state.value !== "object" ||
            state.value === null ||
            Array.isArray(state.value)
          ) {
            setProblem("must be a JSON object");
            return;
          }
          const value = state.value as JsonObject;
          const outside =
            keys === null
              ? []
              : Object.keys(value).filter((key) => !keys.includes(key));
          if (outside.length > 0) {
            setProblem(
              `this tab edits ${keys!.join(", ")}; not ${outside.join(", ")}`,
            );
            return;
          }
          setProblem(null);
          if (keys === null) editor.set([], value);
          else for (const key of keys) editor.set([key], value[key]);
        }}
      />
      {problem === null ? null : (
        <p
          className="field-error"
          data-testid="tab-json-problem"
        >
          {problem}
        </p>
      )}
      {editor.effective === undefined ? null : (
        <details>
          <summary>The published effective values</summary>
          <pre data-testid="tab-json-effective">
            {JSON.stringify(
              keys === null
                ? editor.effective.policy
                : pick(editor.effective.policy, keys),
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

/** The draft's changes against the published version. */
function DraftChanges({
  scope,
  revision,
}: {
  scope: string;
  revision: number;
}) {
  const { client } = useSecurityClient();
  const diff = useQuery({
    queryKey: [...listsKeys.all(scope), "diff", revision],
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/policies/:scope/diff", {
          params: { scope },
          query: { from: "head", to: "draft" },
          signal,
        }),
      ),
  });
  if (diff.isError)
    return (
      <ProblemBanner
        error={diff.error}
        title="Could not read the draft's changes"
        isApiError={isApiError}
      />
    );
  if (diff.data === undefined) return <Spinner label="Reading the changes" />;
  return diff.data.changes.length === 0 ? (
    <p data-testid="draft-changes-none">
      The draft matches the published version.
    </p>
  ) : (
    <ul
      className="policy-changes"
      data-testid="draft-changes"
    >
      {diff.data.changes.map((change) => (
        <li
          key={change.path}
          data-testid="draft-change"
        >
          <code>{change.path}</code>:{" "}
          {change.before === undefined ? (
            <span>added {JSON.stringify(change.after)}</span>
          ) : change.after === undefined ? (
            <span>removed (was {JSON.stringify(change.before)})</span>
          ) : (
            <span>
              {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** See the module's description. */
export function PolicyEditor({ scope }: PolicyEditorProps) {
  const canDraft = useCan("policy:draft");
  const canPublish = useCan("policy:publish");
  const canEstimate = useCan("rules:test");
  const canAgents = useGlobalCanFn()("agents:read");
  const toast = useToast();
  const [edits, setEdits] = useState<JsonObject | null>(null);
  const data = usePolicyLists(scope, edits === null);
  const schema = usePolicySchema();
  const save = useSaveDraft(scope);
  const discard = useDiscardDraft(scope);
  const conflicts = useCrawlerConflicts(scope, canAgents);
  const [issues, setIssues] = useState<
    readonly { path: string; message: string }[]
  >([]);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<"draft" | "head" | null>(null);
  const [saving, setSaving] = useState(false);
  const [approval, setApproval] = useState<ApprovalDto | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [jsonTabs, setJsonTabs] = useState<ReadonlySet<string>>(new Set());
  const working = edits ?? data.base;
  const effective = data.effective;
  const editor = useMemo<PolicyEditorState>(
    () => ({
      scope,
      working,
      effective:
        effective === undefined
          ? undefined
          : {
              policy: effective.policy,
              origins: effective.origins,
              locked: effective.locked,
            },
      canEdit: canDraft,
      set: (path: PolicyPath, value: unknown) =>
        setEdits((old) =>
          path.length === 0
            ? (value as JsonObject)
            : setAt(old ?? data.base, path, value),
        ),
      issuesAt: (path: PolicyPath) =>
        issues
          .filter((issue) => issue.path === dotted(path))
          .map((issue) => issue.message),
    }),
    [scope, working, effective, canDraft, data.base, issues],
  );

  if (data.pending || schema.isPending)
    return <Spinner label="Loading the policy" />;
  if (data.error !== null && data.error !== undefined) {
    return (
      <div className="screen">
        <ErrorView
          error={data.error}
          title="Could not read the policy"
          onRetry={() => void data.reload()}
        />
      </div>
    );
  }
  if (schema.isError) {
    return (
      <div className="screen">
        <ErrorView
          error={schema.error}
          title="Could not read the policy's schema"
          onRetry={() => void schema.refetch()}
        />
      </div>
    );
  }
  const root = schema.data;
  const draft = data.policy?.draft ?? null;
  const head = data.policy?.head ?? null;
  const dirty = edits !== null;
  const dryRun = dryRunCount(working);

  const saveEdits = async () => {
    setSaving(true);
    setSaveError(null);
    setIssues([]);
    try {
      await save(working, draft?.revision ?? null);
      setEdits(null);
      toast.success("Draft saved");
    } catch (error) {
      if (isConflict(error)) setConflict("draft");
      else {
        if (isApiError(error) && error.status === 422)
          setIssues(
            error.issues.map((issue) => ({
              path: issue.path.replace(/^policy\./, ""),
              message: issue.message,
            })),
          );
        setSaveError(error);
      }
    } finally {
      setSaving(false);
    }
  };
  const reloadAfterConflict = () => {
    setEdits(null);
    setConflict(null);
    setSaveError(null);
    setIssues([]);
    void data.reload();
  };
  const onPublished = (outcome: PublishOutcome) => {
    setPublishOpen(false);
    if (outcome.kind === "approval") setApproval(outcome.approval);
    else toast.success(`Published version ${outcome.number}`);
    void data.reload();
  };
  const scopeQuery = `${SCOPE_PARAM}=${encodeURIComponent(scope)}`;

  const content = (tab: PolicyTab) => {
    if (jsonTabs.has(tab.id) || tab.kind === "json")
      return <TabJson tab={tab} />;
    switch (tab.kind) {
      case "lists": {
        const own = Array.isArray(working.lists) ? working.lists.length : 0;
        return (
          <div
            className="policy-tab"
            data-testid="tab-lists"
          >
            <p>
              {own.toLocaleString("en")} entr{own === 1 ? "y" : "ies"} set here
              {data.inherited.length > 0
                ? `, ${data.inherited.length.toLocaleString("en")} inherited`
                : ""}
              .{" "}
              <Link
                to={`/lists?${scopeQuery}`}
                data-testid="lists-link"
              >
                Open the lists
              </Link>{" "}
              to search, add, import and export them (saved into the same
              draft).
            </p>
          </div>
        );
      }
      case "crawlers":
        return <CrawlersTab node={nodeOf(root, "crawlers")} />;
      case "limits":
        return (
          <div
            className="policy-tab"
            data-testid="tab-limits"
          >
            <KeyedItems
              section="limits"
              item={
                (nodeOf(root, "limits").items as SchemaNode | undefined) ?? {}
              }
              noun="limit"
              summary={limitSummary}
            />
            <SchemaFields
              node={{
                type: "object",
                properties: pick(propertiesOf(root), ["presets"]),
              }}
              path={[]}
            />
          </div>
        );
      case "counted":
        return (
          <div
            className="policy-tab"
            data-testid="tab-counted"
          >
            <KeyedItems
              section="countedRules"
              item={
                (nodeOf(root, "countedRules").items as
                  SchemaNode | undefined) ?? {}
              }
              noun="counted rule"
              summary={countedSummary}
            />
            <LadderTab node={nodeOf(root, "ladder")} />
            <SchemaFields
              node={{
                type: "object",
                properties: pick(propertiesOf(root), ["bans"]),
              }}
              path={[]}
            />
          </div>
        );
      case "rules":
        return (
          <RuleEditorSlot
            node={nodeOf(root, "requestRules")}
            canTest={canEstimate}
          />
        );
      default:
        return (
          <div
            className="policy-tab"
            data-testid={`tab-${tab.id}`}
          >
            <SchemaFields
              node={{
                type: "object",
                properties: pick(propertiesOf(root), tab.keys),
              }}
              path={[]}
            />
          </div>
        );
    }
  };

  return (
    <PolicyEditorContext value={editor}>
      <div
        className="screen policy-editor"
        data-testid="policy-editor"
      >
        <div className="screen-header">
          <h1>Policy: {scopeLabel(scope)}</h1>
          <div className="screen-actions">
            <Link
              to={`/policies/versions?${scopeQuery}`}
              data-testid="versions-link"
            >
              Versions
            </Link>
          </div>
        </div>
        <div
          className="policy-bar"
          data-testid="policy-bar"
        >
          <p data-testid="policy-source">
            {draft !== null
              ? `Editing the draft (revision ${draft.revision}${head === null ? ", nothing published yet" : `, over published version ${head.number}`}).`
              : head !== null
                ? `Editing published version ${head.number}: a save makes a draft.`
                : "Nothing published yet: a save makes the first draft."}{" "}
            {dryRun > 0
              ? `${dryRun.toLocaleString("en")} item(s) in dry run.`
              : ""}
          </p>
          <div className="policy-bar-actions">
            {dirty ? (
              <span
                className="badge"
                data-testid="policy-unsaved"
              >
                Unsaved changes
              </span>
            ) : null}
            {canDraft && dirty ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="policy-save"
                  disabled={saving}
                  onClick={() => void saveEdits()}
                >
                  {saving ? "Saving…" : "Save draft"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="policy-forget"
                  onClick={() => {
                    setEdits(null);
                    setIssues([]);
                  }}
                >
                  Forget changes
                </Button>
              </>
            ) : null}
            {canDraft && draft !== null && !dirty ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="policy-discard"
                onClick={() => setDiscardOpen(true)}
              >
                Discard draft
              </Button>
            ) : null}
            {canPublish && draft !== null && !dirty ? (
              <Button
                variant="primary"
                size="sm"
                data-testid="policy-publish"
                onClick={() => setPublishOpen(true)}
              >
                Publish…
              </Button>
            ) : null}
          </div>
        </div>
        {conflict === null ? null : (
          <div
            className="notice"
            role="alert"
            data-testid="policy-conflict"
          >
            <p>
              {conflict === "draft"
                ? "Someone saved this scope's draft since you read it: your unsaved changes were not saved."
                : "Someone published this scope since you read it: publish again from the current version."}
            </p>
            <Button
              size="sm"
              onClick={reloadAfterConflict}
            >
              Reload
            </Button>
          </div>
        )}
        {saveError === null ? null : (
          <ProblemBanner
            error={saveError}
            title="The draft was not saved"
            isApiError={isApiError}
            onDismiss={() => setSaveError(null)}
          />
        )}
        {issues.length === 0 ? null : (
          <ul
            className="field-error"
            data-testid="policy-issues"
          >
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <code>{issue.path || "(policy)"}</code>: {issue.message}
              </li>
            ))}
          </ul>
        )}
        {approval === null ? null : (
          <div
            className="notice"
            role="status"
            data-testid="policy-approval"
          >
            <p>
              <strong>Approval {approval.id} opened</strong> ({approval.status}
              ): a second operator must approve this publish before it goes out.
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setApproval(null)}
            >
              Dismiss
            </Button>
          </div>
        )}
        {draft === null ? null : (
          <Card title="The draft's changes">
            <DraftChanges
              scope={scope}
              revision={draft.revision}
            />
            {dirty ? (
              <p className="muted">
                Unsaved changes are not in this list until saved.
              </p>
            ) : null}
            {scope.startsWith("service:") ? null : (
              <>
                <h3>What it does to each service</h3>
                <DraftEffect
                  scope={scope}
                  revision={draft.revision}
                />
              </>
            )}
          </Card>
        )}
        <UrlTabs
          param="tab"
          defaultValue={POLICY_TABS[0].id}
          label="Policy layers"
          tabs={POLICY_TABS.map((tab) => ({ value: tab.id, label: tab.label }))}
        />
        <TabBody
          jsonTabs={jsonTabs}
          setJsonTabs={setJsonTabs}
          content={content}
        />
        <PublishDialog
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          scope={scope}
          expectedHead={head?.id ?? null}
          summary="The draft becomes the published policy."
          canEstimate={canEstimate}
          onPublished={onPublished}
          onConflict={() => {
            setPublishOpen(false);
            setConflict("head");
          }}
          {...(conflicts.data === undefined ||
          conflicts.data.conflicts.length === 0
            ? {}
            : {
                notice: (
                  <ConflictList
                    report={conflicts.data}
                    testId="publish-conflicts"
                  />
                ),
              })}
        />
        <ConfirmDialog
          open={discardOpen}
          onClose={() => setDiscardOpen(false)}
          title="Discard the draft?"
          description={
            head === null
              ? "The draft is deleted: nothing has been published yet."
              : `The draft is deleted, and the scope shows published version ${head.number} again.`
          }
          confirmLabel="Discard"
          pendingLabel="Discarding…"
          variant="danger"
          isApiError={isApiError}
          onConfirm={async () => {
            try {
              await discard(draft!.revision);
            } catch (error) {
              if (isConflict(error)) {
                setDiscardOpen(false);
                setConflict("draft");
                return;
              }
              throw error;
            }
            setDiscardOpen(false);
            toast.success("Draft discarded");
          }}
        />
      </div>
    </PolicyEditorContext>
  );
}

/** The selected tab's body, with its switch to JSON. */
function TabBody({
  jsonTabs,
  setJsonTabs,
  content,
}: {
  jsonTabs: ReadonlySet<string>;
  setJsonTabs: (next: ReadonlySet<string>) => void;
  content: (tab: PolicyTab) => ReactNode;
}) {
  const { location } = useRouter();
  const tab = tabOf(new URLSearchParams(location.search).get("tab"));
  const json = jsonTabs.has(tab.id);
  return (
    <div
      className="policy-tab-body"
      role="tabpanel"
      aria-label={tab.label}
    >
      {tab.kind === "json" ? null : (
        <Button
          size="sm"
          variant="ghost"
          data-testid="tab-json-toggle"
          onClick={() => {
            const next = new Set(jsonTabs);
            if (json) next.delete(tab.id);
            else next.add(tab.id);
            setJsonTabs(next);
          }}
        >
          {json ? "Back to the form" : "Edit as JSON"}
        </Button>
      )}
      {content(tab)}
    </div>
  );
}
