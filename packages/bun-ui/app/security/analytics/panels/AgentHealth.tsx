/**
 * Agent health (ui.md §7, PR-U2; `agents:read`): each agent's service, state,
 * last heartbeat and bundle version, the events its service dropped in the
 * range, its store warnings, and whether it runs on its local fallback.
 */
import { Table } from "../../../kit/components/Table";
import { formatCount, formatTime } from "../../../kit/charts/chart";
import { readAgents, readSeries } from "../api";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** See the module's description. */
export function AgentHealth() {
  const agents = usePanelQuery("agents.list", readAgents);
  const drops = usePanelQuery("agents.drops", (c) =>
    readSeries(c, "events.dropped", {}, { groupBy: "service" }),
  );
  return (
    <Panel
      title="Agent health"
      testId="panel-agents"
      states={[agents, drops]}
    >
      {() => {
        const dropped = new Map<string, number>();
        for (const point of drops.data!.points) {
          const service = point.service ?? "";
          dropped.set(service, (dropped.get(service) ?? 0) + point.value);
        }
        const items = agents.data!.items;
        if (items.length === 0) return <p className="chart-empty">No agent.</p>;
        return (
          <Table label="Agents">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Service</th>
                <th scope="col">State</th>
                <th scope="col">Last seen</th>
                <th scope="col">Bundle</th>
                <th scope="col">Events dropped</th>
                <th scope="col">Store</th>
              </tr>
            </thead>
            <tbody>
              {items.map((agent) => {
                const warnings = agent.reported?.warnings ?? [];
                const store = warnings.filter((warning) =>
                  warning.kind.startsWith("store."),
                );
                const fallback = store.some(
                  (warning) => warning.kind === "store.unavailable",
                );
                return (
                  <tr key={agent.id}>
                    <td className="mono">{agent.id}</td>
                    <td>{agent.service}</td>
                    <td>{agent.status}</td>
                    <td>
                      {agent.lastSeen === null
                        ? "never"
                        : formatTime(agent.lastSeen)}
                    </td>
                    <td>{agent.reported?.bundleVersion ?? "—"}</td>
                    <td>{formatCount(dropped.get(agent.service) ?? 0)}</td>
                    <td data-testid={`agent-store-${agent.id}`}>
                      {fallback
                        ? "Down: on its local fallback"
                        : store.length > 0
                          ? store.map((warning) => warning.kind).join(", ")
                          : "OK"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        );
      }}
    </Panel>
  );
}
