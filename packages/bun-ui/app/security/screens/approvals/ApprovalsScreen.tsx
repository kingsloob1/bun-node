/**
 * The approvals (ui.md §8, control-plane.md §5.4): every approval, newest
 * first, a page at a time — what it would do, where, who asked, when it
 * expires and where it stands; each opens its detail. Read again every
 * 15 seconds.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "../../../kit/components/Badge";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { when } from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { Link } from "../../router";
import { scopeLabel } from "../../scope/scope";
import { ACTIONS, approvalKeys, STATUSES } from "./approvalQueries";

/** Props of {@link ApprovalsScreen}. */
export interface ApprovalsScreenProps {
  /** The scope on screen (links keep it). */
  scope: string;
}

/** See the module's description. */
export function ApprovalsScreen({ scope }: ApprovalsScreenProps) {
  const { client } = useSecurityClient();
  const position = useUrlCursor(50);
  const page = useQuery({
    queryKey: approvalKeys.list(position.cursor, position.limit),
    refetchInterval: 15_000,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/approvals", {
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
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  return (
    <div
      className="screen"
      data-testid="approvals"
    >
      <h1>Approvals</h1>
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The approvals could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : (
        <>
          <table
            className="table"
            data-testid="approvals-table"
          >
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Scope</th>
                <th scope="col">Asked by</th>
                <th scope="col">Asked</th>
                <th scope="col">Expires</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {(page.data?.items ?? []).map((approval) => {
                const status = STATUSES[approval.status];
                return (
                  <tr
                    key={approval.id}
                    data-testid="approval-row"
                  >
                    <td>
                      <Link
                        to={`/approvals/${encodeURIComponent(approval.id)}?${scopeQuery}`}
                      >
                        {ACTIONS[approval.action]}
                      </Link>
                    </td>
                    <td>{scopeLabel(approval.scope)}</td>
                    <td>{approval.author}</td>
                    <td>{when(approval.createdAt)}</td>
                    <td>{when(approval.expiresAt)}</td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {page.data !== undefined && page.data.items.length === 0 ? (
            <p data-testid="approvals-empty">No approval.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Approval pages"
          />
        </>
      )}
    </div>
  );
}
