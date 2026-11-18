/**
 * The crawler allowance's data on a scope (layers.md L3.2, PR-AN2): the
 * registry the allowance picks from, the conflicts the scope's agents
 * report in their heartbeats (an allowed crawler's published range covered
 * by a refusing list entry or a manual ban; only the agents hold the
 * ranges, so a draft's new conflicts show once it is published), and each
 * verified crawler's counters (`crawlers { crawler, outcome }`) and the
 * spoofed claimants (`rules { rule: "crawler.spoofed" }`).
 */
import type { AgentsDto, SeriesDto } from "../../analytics/api";
import { useQuery } from "@tanstack/react-query";
import { readAgents, readSeries } from "../../analytics/api";
import { dataOf } from "../../api/client";
import { useSecurityClient } from "../../context";
import { groupOf, serviceOf } from "../lists/policy";
import { CRAWLER_OUTCOMES } from "./registry";

export {
  CRAWLER_OUTCOMES,
  CRAWLER_REGISTRY,
  DEFAULT_ALLOWED,
} from "./registry";

/** One conflict, with the agents reporting it. */
export interface ReportedConflict {
  /** The crawler. */
  readonly crawler: string;
  /** The list entry's key, when an entry covers it. */
  readonly entry?: string;
  /** The ban's id, when a ban covers it. */
  readonly ban?: string;
  /** One range covered. */
  readonly range: string;
  /** The services whose agents report it. */
  readonly services: readonly string[];
}

/** What the scope's agents report. */
export interface ConflictReport {
  /** The conflicts, each once. */
  readonly conflicts: readonly ReportedConflict[];
  /** Whether an agent found more than it could send (32 each). */
  readonly truncated: boolean;
  /** How many of the scope's agents report conflicts at all (an older agent does not). */
  readonly reporting: number;
  /** How many agents serve the scope's services. */
  readonly agents: number;
}

/**
 * The conflicts `agents` report for the services in `services` (`null`:
 * every service), each conflict once with the services reporting it.
 */
export function conflictsOf(
  agents: AgentsDto["items"],
  services: ReadonlySet<string> | null,
): ConflictReport {
  const found = new Map<string, ReportedConflict & { services: string[] }>();
  let truncated = false;
  let reporting = 0;
  let count = 0;
  for (const agent of agents) {
    if (agent.revokedAt !== null && agent.revokedAt !== undefined) continue;
    if (services !== null && !services.has(agent.service)) continue;
    count += 1;
    const crawlers = agent.reported?.crawlers;
    if (crawlers === undefined) continue;
    reporting += 1;
    if (crawlers.total > crawlers.conflicts.length) truncated = true;
    for (const conflict of crawlers.conflicts) {
      const key = `${conflict.crawler}\u0000${conflict.entry ?? ""}\u0000${conflict.ban ?? ""}`;
      const known = found.get(key);
      if (known === undefined) {
        found.set(key, { ...conflict, services: [agent.service] });
      } else if (!known.services.includes(agent.service)) {
        known.services.push(agent.service);
      }
    }
  }
  return {
    conflicts: [...found.values()],
    truncated,
    reporting,
    agents: count,
  };
}

/**
 * The services a scope covers among `services` (each with its groups) and
 * `groups` (each with its parent): `null` on global (every one).
 */
export function servicesUnder(
  scope: string,
  services: readonly {
    readonly id: string;
    readonly groups: readonly string[];
  }[],
  groups: readonly { readonly id: string; readonly parent: string | null }[],
): ReadonlySet<string> | null {
  const service = serviceOf(scope);
  if (service !== null) return new Set([service]);
  const group = groupOf(scope);
  if (group === null) return null;
  const under = new Set([group]);
  // Each pass adds the children of the groups found so far.
  for (let grew = true; grew;) {
    grew = false;
    for (const g of groups) {
      if (g.parent !== null && under.has(g.parent) && !under.has(g.id)) {
        under.add(g.id);
        grew = true;
      }
    }
  }
  return new Set(
    services.filter((s) => s.groups.some((g) => under.has(g))).map((s) => s.id),
  );
}

/** Reads every page of a cursor list, at most `max` items. */
async function readAll<T>(
  read: (cursor: string | undefined) => Promise<{ items: T[]; next?: string }>,
  max = 2_000,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    out.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined && out.length < max);
  return out;
}

/** The conflicts the scope's agents report (`agents:read` on global). */
export function useCrawlerConflicts(scope: string, enabled: boolean) {
  const { client } = useSecurityClient();
  return useQuery({
    queryKey: ["policies", scope, "crawler-conflicts"],
    enabled,
    queryFn: async ({ signal }) => {
      const agents = await readAgents({ client, signal });
      let services: ReadonlySet<string> | null = null;
      if (scope !== "global") {
        const [all, groups] = await Promise.all([
          readAll((cursor) =>
            dataOf(
              client.get("/services", {
                query: {
                  limit: 200,
                  ...(cursor === undefined ? {} : { cursor }),
                },
                signal,
              }),
            ),
          ),
          readAll((cursor) =>
            dataOf(
              client.get("/groups", {
                query: {
                  limit: 200,
                  ...(cursor === undefined ? {} : { cursor }),
                },
                signal,
              }),
            ),
          ),
        ]);
        services = servicesUnder(scope, all, groups);
      }
      return conflictsOf(agents.items, services);
    },
  });
}

/** One crawler's counts over the series' range. */
export interface CrawlerCounts {
  /** The crawler. */
  readonly crawler: string;
  /** Its counts per outcome. */
  readonly counts: Readonly<Record<(typeof CRAWLER_OUTCOMES)[number], number>>;
}

/** Each crawler's counts per outcome, busiest first. */
export function countsOf(series: SeriesDto): CrawlerCounts[] {
  const by = new Map<
    string,
    Record<(typeof CRAWLER_OUTCOMES)[number], number>
  >();
  for (const point of series.points) {
    const crawler = point.dims.crawler;
    const outcome = point.dims.outcome as (typeof CRAWLER_OUTCOMES)[number];
    if (crawler === undefined || !CRAWLER_OUTCOMES.includes(outcome)) continue;
    let counts = by.get(crawler);
    if (counts === undefined) {
      counts = {
        request: 0,
        "not-found": 0,
        limited: 0,
        probe: 0,
        honeypot: 0,
      };
      by.set(crawler, counts);
    }
    counts[outcome] += point.value;
  }
  return [...by]
    .map(([crawler, counts]) => ({ crawler, counts }))
    .sort((a, b) => b.counts.request - a.counts.request);
}

/** The scope's crawler series over the last 24 hours, and the spoofed claimants. */
export function useCrawlerSeries(scope: string, enabled: boolean) {
  const { client } = useSecurityClient();
  return useQuery({
    queryKey: ["policies", scope, "crawler-series"],
    enabled,
    queryFn: async ({ signal }) => {
      const context = {
        client,
        scope,
        range: { kind: "preset", seconds: 86_400 } as const,
        signal,
      };
      const [crawlers, spoofed] = await Promise.all([
        readSeries(context, "crawlers"),
        readSeries(context, "rules", { rule: "crawler.spoofed" }),
      ]);
      return {
        counts: countsOf(crawlers),
        spoofed: spoofed.points.reduce((sum, point) => sum + point.value, 0),
      };
    },
  });
}
