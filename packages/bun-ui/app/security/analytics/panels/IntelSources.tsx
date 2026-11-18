/**
 * IP-intel sources (ui.md §7, PR-AN's heartbeat, PR-U2; `agents:read`):
 * each feed the agents report, its size, its last refresh and its last
 * failure, the newest any agent saw.
 */
import { Table } from "../../../kit/components/Table";
import { formatCount, formatTime } from "../../../kit/charts/chart";
import { readAgents } from "../api";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** A feed across the agents. */
interface Feed {
  size: number;
  refreshedAt: number | null;
  attemptedAt: number | null;
  error: string | undefined;
  agents: number;
}

/** See the module's description. */
export function IntelSources() {
  const agents = usePanelQuery("intel.agents", readAgents, { liveMs: 60_000 });
  return (
    <Panel
      title="IP-intel sources"
      testId="panel-intel"
      states={[agents]}
    >
      {() => {
        const feeds = new Map<string, Feed>();
        for (const agent of agents.data!.items) {
          for (const feed of agent.reported?.intel?.feeds ?? []) {
            const known = feeds.get(feed.id);
            const newer =
              known === undefined ||
              (feed.attemptedAt ?? 0) >= (known.attemptedAt ?? 0);
            feeds.set(feed.id, {
              size: newer ? feed.size : known!.size,
              refreshedAt:
                Math.max(feed.refreshedAt ?? 0, known?.refreshedAt ?? 0) ||
                null,
              attemptedAt: newer ? feed.attemptedAt : known!.attemptedAt,
              error: newer ? feed.error : known!.error,
              agents: (known?.agents ?? 0) + 1,
            });
          }
        }
        if (feeds.size === 0)
          return <p className="chart-empty">No agent reports an IP feed.</p>;
        return (
          <Table label="IP feeds">
            <thead>
              <tr>
                <th scope="col">Feed</th>
                <th scope="col">Size</th>
                <th scope="col">Last refresh</th>
                <th scope="col">Last failure</th>
                <th scope="col">Agents</th>
              </tr>
            </thead>
            <tbody>
              {[...feeds].map(([id, feed]) => (
                <tr key={id}>
                  <td className="mono">{id}</td>
                  <td>{formatCount(feed.size)}</td>
                  <td>
                    {feed.refreshedAt === null
                      ? "never"
                      : formatTime(feed.refreshedAt)}
                  </td>
                  <td data-testid={`intel-error-${id}`}>{feed.error ?? "—"}</td>
                  <td>{feed.agents}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        );
      }}
    </Panel>
  );
}
