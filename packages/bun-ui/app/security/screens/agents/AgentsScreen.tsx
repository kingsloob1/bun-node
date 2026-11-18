/**
 * The agents (ui.md §8, control-plane.md §7): each agent's key and health,
 * a page at a time — its service, state (late after 3 missed heartbeats,
 * offline after 10), last heartbeat, the bundle version and signing key it
 * last verified, the bans it holds, and what it reported wrong (warnings,
 * ban reports dropped). With `agents:write`, **New agent** makes a key for
 * a service, its secret shown once.
 */
import { Table } from "../../../kit/components/Table";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "../../../kit/components/Badge";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { when } from "../../components/urlParams";
import { useSecurityClient } from "../../context";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { agentKeys, notConfigured, STATUS } from "./agentQueries";

/** Props of {@link AgentsScreen}. */
export interface AgentsScreenProps {
  /** The scope on screen (links keep it). */
  scope: string;
}

/** See the module's description. */
export function AgentsScreen({ scope }: AgentsScreenProps) {
  const { client } = useSecurityClient();
  const position = useUrlCursor(50);
  const canWrite = useCan("agents:write");
  const page = useQuery({
    queryKey: agentKeys.list(position.cursor, position.limit),
    refetchInterval: 15_000,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/agents", {
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
      data-testid="agents"
    >
      <div className="screen-header">
        <h1>Agents</h1>
        {canWrite ? (
          <div className="screen-actions">
            <Link
              to={`/agents/new?${scopeQuery}`}
              data-testid="new-agent"
            >
              New agent
            </Link>
          </div>
        ) : null}
      </div>
      {page.isError ? (
        notConfigured(page.error) ? (
          <p data-testid="agents-off">
            This control plane serves no agents (its <code>agents</code> option
            is not set).
          </p>
        ) : (
          <ErrorView
            error={page.error}
            title="The agents could not be read"
            onRetry={() => void page.refetch()}
          />
        )
      ) : (
        <>
          <Table
            label="Agents"
            testId="agents-table"
          >
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Service</th>
                <th scope="col">State</th>
                <th scope="col">Last heartbeat</th>
                <th scope="col">Bundle</th>
                <th scope="col">Bans held</th>
                <th scope="col">Reported</th>
              </tr>
            </thead>
            <tbody>
              {(page.data?.items ?? []).map((agent) => {
                const status = STATUS[agent.status];
                const reported = agent.reported;
                const warnings = reported?.warnings?.length ?? 0;
                const dropped = reported?.bansDropped ?? 0;
                return (
                  <tr
                    key={agent.id}
                    data-testid="agent-row"
                  >
                    <td>
                      <Link
                        to={`/agents/${encodeURIComponent(agent.id)}?${scopeQuery}`}
                      >
                        {agent.name}
                      </Link>
                      {agent.name === agent.id ? null : (
                        <span className="muted"> ({agent.id})</span>
                      )}
                    </td>
                    <td>{agent.service}</td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td>{when(agent.lastSeen)}</td>
                    <td>
                      {reported?.bundleVersion == null
                        ? "—"
                        : `v${reported.bundleVersion} (${reported.bundleKeyId ?? "?"})`}
                      {reported?.bundleExpired === true ? (
                        <Badge tone="warning">expired</Badge>
                      ) : null}
                    </td>
                    <td>{reported === null ? "—" : reported.banCount}</td>
                    <td data-testid="agent-reported">
                      {warnings === 0 && dropped === 0
                        ? "—"
                        : [
                            warnings === 0
                              ? null
                              : `${warnings} warning${warnings === 1 ? "" : "s"}`,
                            dropped === 0
                              ? null
                              : `${dropped} ban report${dropped === 1 ? "" : "s"} dropped`,
                          ]
                            .filter((part) => part !== null)
                            .join(", ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {page.data !== undefined && page.data.items.length === 0 ? (
            <p data-testid="agents-empty">No agent yet.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Agents pages"
          />
        </>
      )}
    </div>
  );
}
