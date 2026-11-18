/**
 * Per service and per route (ui.md §7, PR-U2): requests and blocks by
 * service with each one's p95 decision latency; choosing a service drills
 * down to its routes.
 */
import { useState } from "react";
import { BarList } from "../../../kit/charts/BarList";
import { ChartFrame } from "../../../kit/charts/ChartFrame";
import { formatCount } from "../../../kit/charts/chart";
import { Select } from "../../../kit/components/inputs";
import { Table } from "../../../kit/components/Table";
import { readSeries, readTop } from "../api";
import { p95 } from "../latency";
import { REFUSING } from "../actions";
import { Panel } from "../Panel";
import { usePanelQuery } from "../usePanelQuery";

/** See the module's description. */
export function ServicesRoutes() {
  const requests = usePanelQuery("services.requests", (c) =>
    readSeries(c, "requests", {}, { groupBy: "service" }),
  );
  const latency = usePanelQuery("services.latency", (c) =>
    readSeries(c, "latency", {}, { groupBy: "service" }),
  );
  const [service, setService] = useState<string>("");
  const routes = usePanelQuery(
    "services.routes",
    (c) =>
      readTop({ ...c, scope: `service:${service}` }, "requests.route", {}, 100),
    { enabled: service !== "", key: [service] },
  );
  return (
    <Panel
      title="Services and routes"
      testId="panel-services"
      states={[requests, latency, ...(service === "" ? [] : [routes])]}
    >
      {() => {
        const byService = new Map<
          string,
          { requests: number; blocks: number; latency: Map<string, number> }
        >();
        const of = (id: string) => {
          let entry = byService.get(id);
          if (entry === undefined)
            byService.set(
              id,
              (entry = { requests: 0, blocks: 0, latency: new Map() }),
            );
          return entry;
        };
        for (const point of requests.data!.points) {
          const entry = of(point.service ?? "(unknown)");
          entry.requests += point.value;
          if (REFUSING.has(point.dims.action ?? ""))
            entry.blocks += point.value;
        }
        for (const point of latency.data!.points) {
          const entry = of(point.service ?? "(unknown)");
          const le = point.dims.le ?? "";
          entry.latency.set(le, (entry.latency.get(le) ?? 0) + point.value);
        }
        const services = [...byService].sort(
          (a, b) => b[1].requests - a[1].requests,
        );
        const items = services.map(([id, entry]) => ({
          key: id,
          label: id,
          parts: [
            { tone: "block" as const, value: entry.blocks },
            { tone: "allow" as const, value: entry.requests - entry.blocks },
          ],
          text: `${formatCount(entry.requests)} (${formatCount(entry.blocks)} blocked), p95 ${p95(entry.latency)}`,
        }));
        const byRoute = new Map<string, { requests: number; blocks: number }>();
        for (const row of routes.data?.rows ?? []) {
          const route = row.dims.route ?? "(unknown)";
          const entry = byRoute.get(route) ?? { requests: 0, blocks: 0 };
          entry.requests += row.value;
          if (REFUSING.has(row.dims.action ?? "")) entry.blocks += row.value;
          byRoute.set(route, entry);
        }
        return (
          <>
            <ChartFrame
              title="By service"
              summary={
                items.map((item) => `${item.label}: ${item.text}`).join("; ") ||
                "No requests."
              }
              columns={["Service", "Requests"]}
              rows={items.map((item) => [item.label, item.text])}
              empty={items.length === 0}
              testId="services-chart"
            >
              <BarList items={items} />
            </ChartFrame>
            {services.length === 0 ? null : (
              <Select
                aria-label="Drill down to a service's routes"
                value={service}
                onChange={(value) => setService(value)}
                options={[
                  { value: "", label: "Choose a service for its routes" },
                  ...services.map(([id]) => ({ value: id, label: id })),
                ]}
              />
            )}
            {service === "" ? null : (
              <Table label={`Routes of ${service}`}>
                <thead>
                  <tr>
                    <th scope="col">Route</th>
                    <th scope="col">Requests</th>
                    <th scope="col">Blocked</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byRoute]
                    .sort((a, b) => b[1].requests - a[1].requests)
                    .map(([route, entry]) => (
                      <tr key={route}>
                        <td className="mono">{route}</td>
                        <td>{formatCount(entry.requests)}</td>
                        <td>{formatCount(entry.blocks)}</td>
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
