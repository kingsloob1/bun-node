/**
 * The crawler allowance's tab (ui.md §3, layers.md L3.2), hand-built: the
 * conflicts the agents report at the top, a switch per registry crawler
 * (and per custom one) with its origin like any field, then the
 * allowance's other settings, and each verified crawler's traffic over the
 * last 24 hours (requests, 404s, 429s from its own limit, and what its
 * allowance lifted) with the spoofed claimants. AI crawlers are not in the
 * registry: one is added as a custom crawler, off until allowed.
 */
import type { SchemaNode } from "./schema";
import { Card } from "../../../kit/components/Card";
import { ErrorView } from "../../components/ErrorView";
import { useCan, useGlobalCanFn } from "../../meta/hooks";
import { ConflictList } from "./ConflictList";
import {
  CRAWLER_OUTCOMES,
  CRAWLER_REGISTRY,
  DEFAULT_ALLOWED,
  useCrawlerConflicts,
  useCrawlerSeries,
} from "./crawlers";
import { usePolicyEditor } from "./editorContext";
import { InheritedField, SchemaFields } from "./fields";
import { getAt, isObject } from "./paths";

/** How each outcome reads in the table's head. */
const OUTCOME_LABELS: Readonly<
  Record<(typeof CRAWLER_OUTCOMES)[number], string>
> = {
  request: "Requests",
  "not-found": "404s",
  limited: "429s (its limit)",
  probe: "Probe hits lifted",
  honeypot: "Honeypot hits lifted",
};

/** Props of {@link CrawlersTab}. */
export interface CrawlersTabProps {
  /** The `crawlers` node of the policy's schema. */
  node: SchemaNode;
}

/** The custom crawlers' ids, from the working policy or the effective one. */
function customIds(...policies: unknown[]): string[] {
  const ids = new Set<string>();
  for (const policy of policies) {
    const custom = getAt(policy, ["crawlers", "custom"]);
    if (!Array.isArray(custom)) continue;
    for (const crawler of custom) {
      if (isObject(crawler) && typeof crawler.id === "string")
        ids.add(crawler.id);
    }
  }
  return [...ids];
}

/** See the module's description. */
export function CrawlersTab({ node }: CrawlersTabProps) {
  const editor = usePolicyEditor();
  const canAgents = useGlobalCanFn()("agents:read");
  const canAnalytics = useCan("analytics:read");
  const conflicts = useCrawlerConflicts(editor.scope, canAgents);
  const series = useCrawlerSeries(editor.scope, canAnalytics);
  const custom = customIds(editor.working, editor.effective?.policy);
  return (
    <div
      className="policy-tab"
      data-testid="tab-crawlers"
    >
      {canAgents ? (
        <Card title="Conflicts the agents report">
          {conflicts.isError ? (
            <ErrorView
              error={conflicts.error}
              title="The agents could not be read"
              onRetry={() => void conflicts.refetch()}
            />
          ) : conflicts.data === undefined ? (
            <p className="muted">Reading the agents…</p>
          ) : (
            <ConflictList
              report={conflicts.data}
              testId="crawler-conflicts"
            />
          )}
        </Card>
      ) : null}
      <Card title="Allowed crawlers">
        <InheritedField
          path={["crawlers", "allow"]}
          label="Allowed"
          hint={`The registry's crawlers${custom.length > 0 ? " and the custom ones" : ""}; verified ones get the allowance. AI crawlers are not in the registry: add one under Custom.`}
          control={{
            kind: "choices",
            values: [...CRAWLER_REGISTRY, ...custom],
          }}
          defaultValue={[...DEFAULT_ALLOWED]}
        />
        <SchemaFields
          node={node}
          path={["crawlers"]}
          skip={["allow"]}
        />
      </Card>
      {canAnalytics ? (
        <Card title="Verified crawler traffic, last 24 hours">
          {series.isError ? (
            <ErrorView
              error={series.error}
              title="The crawler series could not be read"
              onRetry={() => void series.refetch()}
            />
          ) : series.data === undefined ? (
            <p className="muted">Reading the series…</p>
          ) : (
            <>
              <table
                className="table"
                data-testid="crawler-series"
              >
                <caption className="visually-hidden">
                  Each verified crawler&apos;s requests and outcomes
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Crawler</th>
                    {CRAWLER_OUTCOMES.map((outcome) => (
                      <th
                        key={outcome}
                        scope="col"
                      >
                        {OUTCOME_LABELS[outcome]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {series.data.counts.map((row) => (
                    <tr
                      key={row.crawler}
                      data-testid={`crawler-series-${row.crawler}`}
                    >
                      <th scope="row">{row.crawler}</th>
                      {CRAWLER_OUTCOMES.map((outcome) => (
                        <td key={outcome}>
                          {row.counts[outcome].toLocaleString("en")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {series.data.counts.length === 0 ? (
                <p
                  className="muted"
                  data-testid="crawler-series-empty"
                >
                  No verified crawler traffic recorded.
                </p>
              ) : null}
              <p data-testid="crawler-spoofed">
                Spoofed claimants (a crawler&apos;s name, failing verification):{" "}
                {series.data.spoofed.toLocaleString("en")}
              </p>
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}
