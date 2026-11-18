/**
 * Geography and ASN (ui.md §7, Q15: a table first, PR-U2): requests and
 * blocks by country, and by autonomous system, as the enforcement points'
 * IP databases attributed them.
 */
import { Table } from "../../../kit/components/Table";
import { formatCount } from "../../../kit/charts/chart";
import { readTop } from "../api";
import { REFUSING } from "../actions";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** Sums rows by `dim`: requests, and those refused. */
function byDim(
  rows: readonly { dims: Readonly<Record<string, string>>; value: number }[],
  dim: string,
) {
  const out = new Map<string, { requests: number; blocks: number }>();
  for (const row of rows) {
    const key = row.dims[dim] ?? "(unknown)";
    const entry = out.get(key) ?? { requests: 0, blocks: 0 };
    entry.requests += row.value;
    if (REFUSING.has(row.dims.action ?? "")) entry.blocks += row.value;
    out.set(key, entry);
  }
  return [...out].sort((a, b) => b[1].requests - a[1].requests).slice(0, 25);
}

/** A table of `rows`. */
function Ranked({
  label,
  head,
  rows,
}: {
  label: string;
  head: string;
  rows: ReturnType<typeof byDim>;
}) {
  return (
    <Table label={label}>
      <thead>
        <tr>
          <th scope="col">{head}</th>
          <th scope="col">Requests</th>
          <th scope="col">Blocked</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, entry]) => (
          <tr key={key}>
            <td>{key}</td>
            <td>{formatCount(entry.requests)}</td>
            <td>{formatCount(entry.blocks)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** See the module's description. */
export function Geography() {
  const countries = usePanelQuery(
    "geo.countries",
    (c) => readTop(c, "requests.country", {}, 100),
    { liveMs: 5_000 },
  );
  const asns = usePanelQuery(
    "geo.asns",
    (c) => readTop(c, "requests.asn", {}, 100),
    { liveMs: 5_000 },
  );
  return (
    <Panel
      title="Geography and ASN"
      testId="panel-geography"
      states={[countries, asns]}
    >
      {() => (
        <div className="geo-tables">
          <Ranked
            label="Requests by country"
            head="Country"
            rows={byDim(countries.data!.rows, "country")}
          />
          <Ranked
            label="Requests by autonomous system"
            head="ASN"
            rows={byDim(asns.data!.rows, "asn")}
          />
          <p className="panel-note">
            Countries and autonomous systems are as each enforcement point's IP
            database attributed them; see that database's licence for its
            attribution.
          </p>
        </div>
      )}
    </Panel>
  );
}
