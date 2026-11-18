/**
 * `/services` (ui.md §3): the services a page at a time (the cursor trail in
 * the URL), each with its groups, environment and topology, its agents'
 * health (their states, the bundle version they enforce against the
 * latest, the signing key), its requests a minute and blocked share over
 * the last hour, and its policy's mode with how many items run in dry run.
 * The figures each need their own permission and are absent without it;
 * the per-service reads (the effective policy and the latest bundle) are
 * made for the first 50 rows of the page only. Links lead to a service's
 * form and its policy editor; **New service** with `services:write`.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { Table } from "../../../kit/components/Table";
import { ANALYTICS_KEY } from "../../analytics/usePanelQuery";
import { readAgents, readSeries } from "../../analytics/api";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { useSecurityClient } from "../../context";
import { useGlobalCanFn } from "../../meta/hooks";
import { Link } from "../../router";
import { SCOPE_PARAM } from "../../scope/scope";
import { agentSummary, modeSummary, trafficByService } from "./figures";
import { servicesKeys } from "./queries";
import { ServicesNav } from "./ServicesNav";
import "./services.css";

/** The most rows whose per-service figures are read. */
const FIGURE_ROWS = 50;

/** A share as a percentage. */
function percent(share: number | null): string {
  return share === null
    ? "—"
    : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}

/** See the module's description. */
export function ServicesScreen() {
  const { client } = useSecurityClient();
  const can = useGlobalCanFn();
  const position = useUrlCursor(50);
  const page = useQuery({
    queryKey: servicesKeys.page(position.cursor, position.limit),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/services", {
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
  const agents = useQuery({
    queryKey: [ANALYTICS_KEY, "agents"],
    enabled: can("agents:read"),
    queryFn: ({ signal }) => readAgents({ client, signal }),
  });
  const traffic = useQuery({
    queryKey: servicesKeys.traffic(),
    enabled: can("analytics:read"),
    queryFn: async ({ signal }) =>
      trafficByService(
        await readSeries(
          {
            client,
            scope: "global",
            range: { kind: "preset", seconds: 3_600 },
            signal,
          },
          "requests",
          {},
          { groupBy: "service", tier: "minute" },
        ),
        60,
      ),
  });
  const rows = page.data?.items ?? [];
  const figured = rows.slice(0, FIGURE_ROWS);
  const effective = useQueries({
    queries: figured.map((service) => ({
      queryKey: servicesKeys.effective(service.id),
      enabled: can("policy:read"),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        dataOf(
          client.get("/services/:id/effective", {
            params: { id: service.id },
            signal,
          }),
        ),
    })),
  });
  const bundles = useQueries({
    queries: figured.map((service) => ({
      queryKey: servicesKeys.bundle(service.id),
      enabled: can("bundles:read"),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        try {
          const bundle = await dataOf(
            client.get("/services/:id/bundle", {
              params: { id: service.id },
              signal,
            }),
          );
          return typeof bundle.version === "number" ? bundle.version : null;
        } catch (error) {
          // A service with nothing published has no bundle yet.
          if (isApiError(error) && error.status === 404) return null;
          throw error;
        }
      },
    })),
  });
  const canWrite = can("services:write");
  return (
    <div
      className="screen"
      data-testid="services"
    >
      <div className="screen-header">
        <h1>Services</h1>
        <div className="screen-actions">
          {canWrite ? (
            <Link
              to="/services/new"
              data-testid="new-service"
            >
              New service
            </Link>
          ) : null}
        </div>
      </div>
      <ServicesNav current="services" />
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The services could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : (
        <>
          <div data-testid="services-table">
            <Table label="Services">
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Groups</th>
                  <th scope="col">Environment</th>
                  <th scope="col">Topology</th>
                  {can("agents:read") ? <th scope="col">Agents</th> : null}
                  {can("analytics:read") ? (
                    <>
                      <th scope="col">Requests/min</th>
                      <th scope="col">Blocked</th>
                    </>
                  ) : null}
                  {can("policy:read") ? <th scope="col">Mode</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((service, index) => {
                  const summary =
                    agents.data === undefined
                      ? undefined
                      : agentSummary(agents.data.items, service.id);
                  const latest = bundles[index]?.data;
                  const figures = traffic.data?.get(service.id);
                  const policy = effective[index]?.data?.policy;
                  return (
                    <tr
                      key={service.id}
                      data-testid="service-row"
                    >
                      <th scope="row">
                        <Link
                          to={`/services/${encodeURIComponent(service.id)}`}
                        >
                          {service.name}
                        </Link>{" "}
                        <span className="muted">
                          (<code>{service.id}</code>)
                        </span>{" "}
                        <Link
                          to={`/policies?${SCOPE_PARAM}=${encodeURIComponent(`service:${service.id}`)}`}
                          data-testid="service-policy-link"
                        >
                          Policy
                        </Link>
                      </th>
                      <td>{service.groups.join(", ") || "—"}</td>
                      <td>{service.environment || "—"}</td>
                      <td>{service.topology}</td>
                      {can("agents:read") ? (
                        <td data-testid="service-agents">
                          {summary === undefined
                            ? "…"
                            : summary.count === 0
                              ? "No agent"
                              : Object.entries(summary.states)
                                  .map(([state, n]) => `${n} ${state}`)
                                  .join(", ")}
                          {summary !== undefined &&
                          summary.bundles.length > 0 ? (
                            <span
                              className={
                                latest !== undefined &&
                                latest !== null &&
                                summary.bundles[0] !== latest
                                  ? "services-stale"
                                  : "muted"
                              }
                            >
                              {" "}
                              bundle v{summary.bundles.join(", v")}
                              {latest === undefined || latest === null
                                ? ""
                                : ` of v${latest}`}
                              {summary.keys.length > 0
                                ? `, key ${summary.keys.join(", ")}`
                                : ""}
                            </span>
                          ) : null}
                        </td>
                      ) : null}
                      {can("analytics:read") ? (
                        <>
                          <td data-testid="service-rate">
                            {figures === undefined
                              ? traffic.data === undefined
                                ? "…"
                                : "0"
                              : figures.perMinute.toLocaleString("en", {
                                  maximumFractionDigits: 1,
                                })}
                          </td>
                          <td data-testid="service-blocked">
                            {percent(figures?.blockedShare ?? null)}
                          </td>
                        </>
                      ) : null}
                      {can("policy:read") ? (
                        <td data-testid="service-mode">
                          {index >= FIGURE_ROWS
                            ? "—"
                            : policy === undefined
                              ? effective[index]?.isError
                                ? "Does not compile"
                                : "…"
                              : modeSummary(policy)}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
          {page.data !== undefined && rows.length === 0 ? (
            <p data-testid="services-empty">No service yet.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Services pages"
          />
        </>
      )}
    </div>
  );
}
