/**
 * The alerts open now (`GET /alerts/open`, read-only: an alert closes when
 * its rule's condition stops holding), for the rules the operator may
 * read; polled.
 */
import { Table } from "../../../kit/components/Table";
import { useQuery } from "@tanstack/react-query";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { when } from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { Link } from "../../router";
import { scopeLabel } from "../../scope/scope";
import { alertKeys } from "./alertQueries";

/** See the module's description. */
export function OpenAlerts({ scope }: { scope: string }) {
  const { client } = useSecurityClient();
  const open = useQuery({
    queryKey: alertKeys.open(),
    refetchInterval: 15_000,
    queryFn: ({ signal }) => dataOf(client.get("/alerts/open", { signal })),
  });
  if (open.isError) {
    return (
      <ErrorView
        error={open.error}
        title="The open alerts could not be read"
        onRetry={() => void open.refetch()}
      />
    );
  }
  const items = open.data?.items ?? [];
  return (
    <section
      aria-label="Open alerts"
      data-testid="alerts-open"
    >
      <p className="muted">
        Open on this instance now. An alert closes by itself when its rule's
        condition stops holding.
      </p>
      {open.data !== undefined && items.length === 0 ? (
        <p data-testid="alerts-open-none">No alert is open.</p>
      ) : (
        <Table label="Open alerts">
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Scope</th>
              <th scope="col">Since</th>
            </tr>
          </thead>
          <tbody>
            {items.map((alert) => (
              <tr
                key={`${alert.rule}-${alert.since}`}
                data-testid="alert-open-row"
              >
                <td>
                  <Link
                    to={`/alerts/rules/${encodeURIComponent(alert.rule)}?scope=${encodeURIComponent(scope)}`}
                  >
                    {alert.rule}
                  </Link>
                </td>
                <td>{scopeLabel(alert.scope)}</td>
                <td>{when(alert.since)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
