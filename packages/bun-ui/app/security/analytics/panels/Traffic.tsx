/**
 * Traffic over time (ui.md §7, PR-U2): requests by action, stacked, at the
 * range's tier, with the dry run's would-block as a dashed line; while the
 * range ends now, the live overview's per-second counts are added to the
 * newest bucket as they arrive.
 */
import type { StackedPoint } from "../../../kit/charts/StackedArea";
import { useState } from "react";
import { ChartFrame } from "../../../kit/charts/ChartFrame";
import { formatCount, formatTime } from "../../../kit/charts/chart";
import { StackedArea } from "../../../kit/charts/StackedArea";
import type { LiveOverviewDto } from "@kingsleyweb/bun-security/control/contract";
import { useLiveMessages, useLiveTopic } from "../../live/hooks";
import { readSeries } from "../api";
import { ACTION_SERIES, actionGroup, REFUSING } from "../actions";
import { useAnalyticsView } from "../context";
import { Panel } from "../Panel";
import { endsNow } from "../range";
import { usePanelQuery } from "../usePanelQuery";

/** The dry run's line. */
const DRY = {
  key: "dryrun",
  label: "Would block (dry run)",
  tone: "dryrun",
} as const;

/** See the module's description. */
export function Traffic() {
  const { range } = useAnalyticsView();
  const requests = usePanelQuery(
    "traffic.requests",
    (c) => readSeries(c, "requests"),
    { liveMs: 60_000 },
  );
  const dry = usePanelQuery(
    "traffic.dry",
    (c) => readSeries(c, "rules", { dryRun: "true" }),
    { liveMs: 60_000 },
  );
  // The live counts since the last read, by action group.
  const [liveCounts, setLive] = useState<{
    readonly since: number;
    readonly counts: Readonly<Record<string, number>>;
  }>({
    since: 0,
    counts: {},
  });
  const live = endsNow(range);
  useLiveTopic("overview", live);
  useLiveMessages(["overview"], (data) => {
    if (!live) return;
    const message = data as LiveOverviewDto;
    setLive((current) => {
      const read = requests.dataUpdatedAt;
      const counts = current.since === read ? { ...current.counts } : {};
      for (const [action, value] of Object.entries(message.requests)) {
        const group = actionGroup(action);
        counts[group] = (counts[group] ?? 0) + value;
      }
      return { since: read, counts };
    });
  });
  return (
    <Panel
      title="Traffic over time"
      testId="panel-traffic"
      states={[requests, dry]}
      className="analytics-wide"
    >
      {() => {
        const buckets = new Map<number, Record<string, number>>();
        for (const point of requests.data!.points) {
          const values = buckets.get(point.at) ?? {};
          const group = actionGroup(point.dims.action ?? "");
          values[group] = (values[group] ?? 0) + point.value;
          buckets.set(point.at, values);
        }
        for (const point of dry.data!.points) {
          if (!REFUSING.has(point.dims.action ?? "")) continue;
          const values = buckets.get(point.at) ?? {};
          values[DRY.key] = (values[DRY.key] ?? 0) + point.value;
          buckets.set(point.at, values);
        }
        const points: StackedPoint[] = [...buckets]
          .sort((a, b) => a[0] - b[0])
          .map(([at, values]) => ({ at, values }));
        const last = points.at(-1);
        if (last !== undefined && liveCounts.since === requests.dataUpdatedAt) {
          const values = { ...last.values };
          for (const [group, value] of Object.entries(liveCounts.counts))
            values[group] = (values[group] ?? 0) + value;
          points[points.length - 1] = { at: last.at, values };
        }
        const total = (key: string) =>
          points.reduce((sum, point) => sum + (point.values[key] ?? 0), 0);
        const all = ACTION_SERIES.reduce(
          (sum, series) => sum + total(series.key),
          0,
        );
        return (
          <ChartFrame
            title="Requests by action"
            summary={`${formatCount(all)} requests: ${ACTION_SERIES.map((series) => `${formatCount(total(series.key))} ${series.label.toLowerCase()}`).join(", ")}; ${formatCount(total(DRY.key))} would have been blocked by rules in dry run.`}
            series={[...ACTION_SERIES, DRY]}
            columns={[
              "Time",
              ...ACTION_SERIES.map((series) => series.label),
              DRY.label,
            ]}
            rows={points.map((point) => [
              formatTime(point.at),
              ...ACTION_SERIES.map((series) =>
                formatCount(point.values[series.key] ?? 0),
              ),
              formatCount(point.values[DRY.key] ?? 0),
            ])}
            empty={points.length === 0}
            testId="traffic-chart"
          >
            <StackedArea
              series={ACTION_SERIES}
              points={points}
              overlay={DRY}
            />
          </ChartFrame>
        );
      }}
    </Panel>
  );
}
