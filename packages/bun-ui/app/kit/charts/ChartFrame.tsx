/**
 * A chart's frame (PR-U2, the user's decision on accessible charts): its
 * heading, the chart as an image with a text summary (`role="img"`), a
 * legend, and a "Table" toggle that shows the same data as a real table,
 * which reads and navigates by keyboard. An empty chart says so instead.
 */
import type { ReactNode } from "react";
import type { ChartSeries } from "./chart";
import { useId, useState } from "react";
import { Button } from "../components/Button";
import { Table } from "../components/Table";
import "./charts.css";

/** Props of {@link ChartFrame}. */
export interface ChartFrameProps {
  /** The chart's name. */
  title: string;
  /** One or two sentences saying what the chart shows: the image's accessible name. */
  summary: string;
  /** The series, for the legend (none: no legend). */
  series?: readonly ChartSeries[];
  /** The table's header cells. */
  columns: readonly string[];
  /** The table's rows, each one cell per column. */
  rows: readonly (readonly ReactNode[])[];
  /** Nothing to draw: the frame shows `empty` instead. */
  empty?: boolean;
  /** What an empty chart says. Default "Nothing in this range." */
  emptyText?: string;
  /** The SVG chart. */
  children: ReactNode;
  /** A test id. */
  testId?: string;
}

/** See the module's description. */
export function ChartFrame({
  title,
  summary,
  series,
  columns,
  rows,
  empty = false,
  emptyText = "Nothing in this range.",
  children,
  testId,
}: ChartFrameProps) {
  const [table, setTable] = useState(false);
  const summaryId = useId();
  return (
    <figure
      className="chart"
      data-testid={testId}
    >
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {empty ? null : (
          <Button
            variant="ghost"
            aria-pressed={table}
            onClick={() => setTable((shown) => !shown)}
          >
            {table ? "Chart" : "Table"}
          </Button>
        )}
      </figcaption>
      {empty ? (
        <p className="chart-empty">{emptyText}</p>
      ) : table ? (
        <Table label={`${title}: data`}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <>
          <div
            className="chart-body"
            role="img"
            aria-labelledby={summaryId}
          >
            {children}
          </div>
          <p
            id={summaryId}
            className="chart-summary"
          >
            {summary}
          </p>
          {series === undefined || series.length === 0 ? null : (
            <ul className="chart-legend">
              {series.map((item) => (
                <li key={item.key}>
                  <span
                    className={`chart-swatch chart-tone-${item.tone}`}
                    aria-hidden="true"
                  />
                  {item.label}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </figure>
  );
}
