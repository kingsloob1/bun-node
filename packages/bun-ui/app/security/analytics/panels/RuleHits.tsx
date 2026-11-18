/**
 * Per-rule hits (ui.md §7, PR-U2): each rule's hits, blocks, dry-run
 * would-blocks and false-positive reports, sortable, with its trend. A rule
 * id naming an account comes redacted for a viewer (the server's).
 */
import { useState } from "react";
import { Table } from "../../../kit/components/Table";
import { formatCount } from "../../../kit/charts/chart";
import { Sparkline } from "../../../kit/charts/Sparkline";
import { readSeries, readTop } from "../api";
import { REFUSING } from "../actions";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** A rule's row. */
interface RuleRow {
  readonly rule: string;
  hits: number;
  blocks: number;
  wouldBlock: number;
  falsePositives: number;
  readonly trend: Map<number, number>;
}

/** The sortable columns. */
type SortKey = "hits" | "blocks" | "wouldBlock" | "falsePositives";

/** How each column reads. */
const COLUMNS: readonly [SortKey, string][] = [
  ["hits", "Hits"],
  ["blocks", "Blocks"],
  ["wouldBlock", "Would block (dry run)"],
  ["falsePositives", "False positives"],
];

/** See the module's description. */
export function RuleHits() {
  const series = usePanelQuery("rules.series", (c) => readSeries(c, "rules"));
  const reports = usePanelQuery("rules.fp", (c) =>
    readTop(c, "rules.false-positive", {}, 100),
  );
  const [sort, setSort] = useState<SortKey>("hits");
  return (
    <Panel
      title="Per-rule hits"
      testId="panel-rules"
      states={[series, reports]}
      className="analytics-wide"
    >
      {() => {
        const rows = new Map<string, RuleRow>();
        const of = (rule: string) => {
          let row = rows.get(rule);
          if (row === undefined) {
            row = {
              rule,
              hits: 0,
              blocks: 0,
              wouldBlock: 0,
              falsePositives: 0,
              trend: new Map(),
            };
            rows.set(rule, row);
          }
          return row;
        };
        for (const point of series.data!.points) {
          const row = of(point.dims.rule ?? "(none)");
          row.hits += point.value;
          row.trend.set(point.at, (row.trend.get(point.at) ?? 0) + point.value);
          if (REFUSING.has(point.dims.action ?? "")) {
            if (point.dims.dryRun === "true") row.wouldBlock += point.value;
            else row.blocks += point.value;
          }
        }
        for (const report of reports.data!.rows)
          of(report.dims.rule ?? "(none)").falsePositives += report.value;
        const buckets = [
          ...new Set(series.data!.points.map((point) => point.at)),
        ].sort((a, b) => a - b);
        const sorted = [...rows.values()].sort(
          (a, b) => b[sort] - a[sort] || a.rule.localeCompare(b.rule),
        );
        if (sorted.length === 0)
          return <p className="chart-empty">No rule hit in this range.</p>;
        return (
          <Table label="Per-rule hits">
            <thead>
              <tr>
                <th scope="col">Rule</th>
                {COLUMNS.map(([key, label]) => (
                  <th
                    key={key}
                    scope="col"
                    aria-sort={sort === key ? "descending" : "none"}
                  >
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => setSort(key)}
                    >
                      {label}
                    </button>
                  </th>
                ))}
                <th scope="col">Trend</th>
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 100).map((row) => (
                <tr key={row.rule}>
                  <td className="mono">{row.rule}</td>
                  <td>{formatCount(row.hits)}</td>
                  <td>{formatCount(row.blocks)}</td>
                  <td>{formatCount(row.wouldBlock)}</td>
                  <td data-testid={`fp-${row.rule}`}>
                    {formatCount(row.falsePositives)}
                  </td>
                  <td>
                    <Sparkline
                      values={buckets.map((at) => row.trend.get(at) ?? 0)}
                      label={`${row.rule}: hits over the range`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        );
      }}
    </Panel>
  );
}
