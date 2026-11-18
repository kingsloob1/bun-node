/**
 * `/policies/versions` (ui.md §3, control-plane.md §3.3): a scope's
 * published versions, newest first, a page at a time (the cursor trail in
 * the URL). Tick any two to compare them (`GET /policies/:scope/diff`), or
 * compare one with the published head. **Roll back to this** (with
 * `policy:publish`) publishes that version's content again as a new
 * version, through U3's publish dialog: a step-up, a typed confirmation
 * for a dangerous change, or an approval; a `409` when someone published
 * since.
 */
import type { ApprovalDto, PublishOutcome } from "../lists/PublishDialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Card } from "../../../kit/components/Card";
import { Checkbox } from "../../../kit/components/inputs";
import { ProblemBanner } from "../../../kit/components/ProblemBanner";
import { Spinner } from "../../../kit/components/Spinner";
import { Table } from "../../../kit/components/Table";
import { useToast } from "../../../kit/components/toast";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { useSecurityClient } from "../../context";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { scopeLabel, SCOPE_PARAM } from "../../scope/scope";
import { listsKeys } from "../lists/policy";
import { PublishDialog } from "../lists/PublishDialog";
import "./policies.css";

/** Props of {@link VersionsScreen}. */
export interface VersionsScreenProps {
  /** The scope. */
  scope: string;
}

/** The differences between two versions. */
function VersionDiff({
  scope,
  from,
  to,
}: {
  scope: string;
  from: string;
  to: string;
}) {
  const { client } = useSecurityClient();
  const diff = useQuery({
    queryKey: [...listsKeys.all(scope), "diff", from, to],
    // Two versions never change.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/policies/:scope/diff", {
          params: { scope },
          query: { from, to },
          signal,
        }),
      ),
  });
  if (diff.isError)
    return (
      <ProblemBanner
        error={diff.error}
        title="Could not compare the versions"
        isApiError={isApiError}
      />
    );
  if (diff.data === undefined) return <Spinner label="Comparing" />;
  return diff.data.changes.length === 0 ? (
    <p data-testid="versions-diff-none">The two versions are the same.</p>
  ) : (
    <ul
      className="policy-changes"
      data-testid="versions-diff"
    >
      {diff.data.changes.map((change) => (
        <li
          key={change.path}
          data-testid="versions-change"
        >
          <code>{change.path}</code>:{" "}
          {change.before === undefined
            ? `added ${JSON.stringify(change.after)}`
            : change.after === undefined
              ? `removed (was ${JSON.stringify(change.before)})`
              : `${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`}
        </li>
      ))}
    </ul>
  );
}

/** See the module's description. */
export function VersionsScreen({ scope }: VersionsScreenProps) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const canPublish = useCan("policy:publish");
  const position = useUrlCursor(50);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [rollback, setRollback] = useState<{
    id: string;
    number: number;
  } | null>(null);
  const [approval, setApproval] = useState<ApprovalDto | null>(null);
  const [conflict, setConflict] = useState(false);
  const policy = useQuery({
    queryKey: listsKeys.policy(scope),
    queryFn: ({ signal }) =>
      dataOf(client.get("/policies/:scope", { params: { scope }, signal })),
  });
  const versions = useQuery({
    queryKey: [
      ...listsKeys.all(scope),
      "versions",
      position.cursor ?? "",
      position.limit,
    ],
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/policies/:scope/versions", {
          params: { scope },
          query: {
            limit: position.limit,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
          },
          signal,
        }),
      ),
  });
  const head = policy.data?.head ?? null;
  const toggle = (id: string, on: boolean) =>
    setPicked((old) =>
      on
        ? [...old.filter((p) => p !== id), id].slice(-2)
        : old.filter((p) => p !== id),
    );
  const onPublished = (outcome: PublishOutcome) => {
    setRollback(null);
    if (outcome.kind === "approval") setApproval(outcome.approval);
    else toast.success(`Rolled back: published version ${outcome.number}`);
    void queryClient.invalidateQueries({ queryKey: listsKeys.all(scope) });
  };
  const [first, second] = picked;
  return (
    <div
      className="screen"
      data-testid="versions"
    >
      <div className="screen-header">
        <h1>Versions: {scopeLabel(scope)}</h1>
        <div className="screen-actions">
          <Link to={`/policies?${SCOPE_PARAM}=${encodeURIComponent(scope)}`}>
            The policy editor
          </Link>
        </div>
      </div>
      {conflict ? (
        <div
          className="notice"
          role="alert"
          data-testid="versions-conflict"
        >
          <p>
            Someone published this scope since you read it: nothing was rolled
            back.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setConflict(false);
              void queryClient.invalidateQueries({
                queryKey: listsKeys.all(scope),
              });
            }}
          >
            Reload
          </Button>
        </div>
      ) : null}
      {approval === null ? null : (
        <div
          className="notice"
          role="status"
          data-testid="versions-approval"
        >
          <p>
            <strong>Approval {approval.id} opened</strong> ({approval.status}):
            a second operator must approve this rollback before it goes out.
          </p>
        </div>
      )}
      {versions.isError ? (
        <ErrorView
          error={versions.error}
          title="The versions could not be read"
          onRetry={() => void versions.refetch()}
        />
      ) : (
        <>
          <div data-testid="versions-table">
            <Table label="Versions">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Compare</span>
                  </th>
                  <th scope="col">Version</th>
                  <th scope="col">Published</th>
                  <th scope="col">By</th>
                  <th scope="col">Message</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(versions.data?.items ?? []).map((version) => (
                  <tr
                    key={version.id}
                    data-testid="version-row"
                  >
                    <td>
                      <Checkbox
                        label={`Compare version ${version.number}`}
                        data-testid={`version-pick-${version.number}`}
                        checked={picked.includes(version.id)}
                        onChange={(on) => toggle(version.id, on)}
                      />
                    </td>
                    <td>
                      {version.number}
                      {version.id === head?.id ? (
                        <span className="badge"> published</span>
                      ) : null}
                    </td>
                    <td>{new Date(version.createdAt).toISOString()}</td>
                    <td>{version.createdBy ?? "—"}</td>
                    <td>{version.message ?? ""}</td>
                    <td className="row-actions">
                      {head !== null && version.id !== head.id ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`version-vs-head-${version.number}`}
                          onClick={() => setPicked([version.id, head.id])}
                        >
                          Compare with published
                        </Button>
                      ) : null}
                      {canPublish && head !== null && version.id !== head.id ? (
                        <Button
                          size="sm"
                          data-testid={`version-rollback-${version.number}`}
                          onClick={() =>
                            setRollback({
                              id: version.id,
                              number: version.number,
                            })
                          }
                        >
                          Roll back to this
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {versions.data !== undefined && versions.data.items.length === 0 ? (
            <p data-testid="versions-empty">Nothing published yet.</p>
          ) : null}
          <UrlPager
            position={position}
            page={versions.data}
            label="Versions pages"
          />
        </>
      )}
      {first !== undefined && second !== undefined ? (
        <Card title="Compared">
          <VersionDiff
            scope={scope}
            from={first}
            to={second}
          />
        </Card>
      ) : picked.length === 1 ? (
        <p className="muted">Tick one more version to compare.</p>
      ) : null}
      <PublishDialog
        open={rollback !== null}
        onClose={() => setRollback(null)}
        scope={scope}
        expectedHead={head?.id ?? null}
        summary={
          rollback === null
            ? ""
            : `Version ${rollback.number}'s content is published again as a new version.`
        }
        canEstimate={false}
        onPublished={onPublished}
        onConflict={() => {
          setRollback(null);
          setConflict(true);
        }}
        {...(rollback === null ? {} : { rollbackTo: rollback })}
      />
    </div>
  );
}
