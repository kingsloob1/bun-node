/**
 * The ban timeline (ui.md §7, PR-U2): bans made per bucket (a heat strip,
 * and their sources), bans lifted, and how many are in force now
 * (`bans:read`).
 */
import { ChartFrame } from "../../../kit/charts/ChartFrame";
import { formatCount, formatTime } from "../../../kit/charts/chart";
import { HeatStrip } from "../../../kit/charts/HeatStrip";
import { readBanTimeline } from "../api";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** See the module's description. */
export function BanTimeline() {
  const timeline = usePanelQuery("bans.timeline", readBanTimeline);
  return (
    <Panel
      title="Ban timeline"
      testId="panel-bans"
      states={[timeline]}
    >
      {() => {
        const { points, active, truncated } = timeline.data!;
        const made = points.map((point) =>
          Object.values(point.created).reduce((a, b) => a + b, 0),
        );
        const lifted = points.map((point) => point.lifted);
        const bySource = new Map<string, number>();
        for (const point of points) {
          for (const [source, count] of Object.entries(point.created)) {
            bySource.set(source, (bySource.get(source) ?? 0) + count);
          }
        }
        const totalMade = made.reduce((a, b) => a + b, 0);
        const totalLifted = lifted.reduce((a, b) => a + b, 0);
        const sources = [...bySource]
          .map(([source, count]) => `${formatCount(count)} ${source}`)
          .join(", ");
        return (
          <>
            <p
              className="panel-figure"
              data-testid="bans-active"
            >
              {formatCount(active)} in force now
            </p>
            <ChartFrame
              title="Bans made"
              summary={`${formatCount(totalMade)} bans made in the range${sources === "" ? "" : ` (${sources})`}, ${formatCount(totalLifted)} lifted.${truncated ? " The read stopped at its bound: the counts are a floor." : ""}`}
              columns={["Time", "Made", "Lifted"]}
              rows={points.map((point, index) => [
                formatTime(point.at),
                formatCount(made[index] ?? 0),
                formatCount(point.lifted),
              ])}
              empty={totalMade === 0 && totalLifted === 0}
              emptyText="No ban made or lifted in this range."
              testId="bans-chart"
            >
              <HeatStrip
                values={made}
                tone="block"
              />
              <HeatStrip
                values={lifted}
                tone="allow"
              />
            </ChartFrame>
          </>
        );
      }}
    </Panel>
  );
}
