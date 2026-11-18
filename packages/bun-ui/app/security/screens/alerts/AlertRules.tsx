/**
 * The alert rules (README §9.3) the operator may read, a page at a time:
 * title, scope, severity, what it watches, its channels, on or off. With
 * `alerts:write` on the scope on screen, **New rule**.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "../../../kit/components/Badge";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { useSecurityClient } from "../../context";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { scopeLabel } from "../../scope/scope";
import { alertKeys, ruleCondition, SEVERITY_TONE } from "./alertQueries";
import { describeCondition } from "./conditionForm";

/** See the module's description. */
export function AlertRules({ scope }: { scope: string }) {
  const { client } = useSecurityClient();
  const position = useUrlCursor(50);
  const canWrite = useCan("alerts:write");
  const page = useQuery({
    queryKey: alertKeys.rules(position.cursor, position.limit),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/alerts/rules", {
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
    <section
      aria-label="Alert rules"
      data-testid="alerts-rules"
    >
      {canWrite ? (
        <p>
          <Link
            to={`/alerts/rules/new?${scopeQuery}`}
            data-testid="new-alert-rule"
          >
            New rule
          </Link>
        </p>
      ) : null}
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The alert rules could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Scope</th>
                <th scope="col">Severity</th>
                <th scope="col">Watches</th>
                <th scope="col">Channels</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {(page.data?.items ?? []).map((rule) => (
                <tr
                  key={rule.id}
                  data-testid="alert-rule-row"
                >
                  <td>
                    <Link
                      to={`/alerts/rules/${encodeURIComponent(rule.id)}?${scopeQuery}`}
                    >
                      {rule.title}
                    </Link>
                  </td>
                  <td>{scopeLabel(rule.scope)}</td>
                  <td>
                    <Badge tone={SEVERITY_TONE[rule.severity]}>
                      {rule.severity}
                    </Badge>
                  </td>
                  <td>{describeCondition(ruleCondition(rule))}</td>
                  <td>{rule.channels.join(", ") || "—"}</td>
                  <td>{rule.enabled ? "On" : "Off"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.data !== undefined && page.data.items.length === 0 ? (
            <p data-testid="alert-rules-empty">No alert rule.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Alert rule pages"
          />
        </>
      )}
    </section>
  );
}
