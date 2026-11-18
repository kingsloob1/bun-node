/**
 * Identifier patterns (ui.md §7, PR-AN's counters, PR-U2): each pattern's
 * hits and its last hit; choosing one lists the addresses it tripped. A
 * pattern id naming an account comes redacted for a viewer (the server's).
 */
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Table } from "../../../kit/components/Table";
import { formatCount, formatTime } from "../../../kit/charts/chart";
import { readSeries, readTop } from "../api";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** See the module's description. */
export function Patterns() {
  const series = usePanelQuery(
    "patterns.series",
    (c) => readSeries(c, "patterns"),
    { liveMs: 5_000 },
  );
  const [open, setOpen] = useState<string | null>(null);
  const tripped = usePanelQuery(
    "patterns.tripped",
    (c) => readTop(c, "top.pattern", { kind: "ip", pattern: open ?? "" }, 10),
    { enabled: open !== null, key: [open], liveMs: 5_000 },
  );
  return (
    <Panel
      title="Identifier patterns"
      testId="panel-patterns"
      states={[series, ...(open === null ? [] : [tripped])]}
    >
      {() => {
        const byPattern = new Map<string, { hits: number; last: number }>();
        for (const point of series.data!.points) {
          const pattern = point.dims.pattern ?? "(none)";
          const entry = byPattern.get(pattern) ?? { hits: 0, last: 0 };
          entry.hits += point.value;
          if (point.value > 0) entry.last = Math.max(entry.last, point.at);
          byPattern.set(pattern, entry);
        }
        const rows = [...byPattern].sort((a, b) => b[1].hits - a[1].hits);
        if (rows.length === 0)
          return <p className="chart-empty">No pattern hit in this range.</p>;
        return (
          <>
            <Table label="Patterns">
              <thead>
                <tr>
                  <th scope="col">Pattern</th>
                  <th scope="col">Hits</th>
                  <th scope="col">Last hit</th>
                  <th scope="col">
                    <span className="visually-hidden">Addresses</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([pattern, entry]) => (
                  <tr key={pattern}>
                    <td className="mono">{pattern}</td>
                    <td>{formatCount(entry.hits)}</td>
                    <td>{entry.last === 0 ? "—" : formatTime(entry.last)}</td>
                    <td>
                      <Button
                        variant="ghost"
                        aria-expanded={open === pattern}
                        onClick={() =>
                          setOpen(open === pattern ? null : pattern)
                        }
                      >
                        Addresses
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {open === null || tripped.data === undefined ? null : (
              <Table label={`Addresses ${open} tripped`}>
                <thead>
                  <tr>
                    <th scope="col">Address</th>
                    <th scope="col">Hits</th>
                  </tr>
                </thead>
                <tbody>
                  {tripped.data.rows.map((row) => (
                    <tr key={row.dims.subject}>
                      <td className="mono">{row.dims.subject}</td>
                      <td>{formatCount(row.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        );
      }}
    </Panel>
  );
}
