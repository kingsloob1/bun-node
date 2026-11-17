/**
 * The analytics reads (ui.md §7, control-plane.md §4, PR-CP5): a metric's
 * series and top-N, and the events, over the store's analytics operations,
 * for a scope and everything under it.
 *
 * Who sees what (control-plane.md §5.2, the user's decision of 2026-11-17):
 * `analytics:read` reads series, top-N by address, country and ASN, and
 * events without their request samples or their user, username and API-key
 * subjects (a rule id naming one redacted); `events:read` reads events
 * whole, top-N by user, username and API key, and one event by id. Each is
 * checked on the scope asked for, which covers its descendants; how much
 * of each event is shown is decided on the event's own service (the user's
 * decision of 2026-11-17).
 *
 * Bounds: a range of at most 400 days, a series of at most 10,000 points,
 * a top-N of at most 100, a page of at most 200 events.
 */
import type { AnalyticsScope } from "./contract/live";
import type { SecurityApiPermission } from "./contract/constants";
import type { PolicyScopeId } from "./contract/types";
import type { ControlPlane } from "./plane";
import type { AnyRoute } from "./routes";
import type { Infer } from "./schema";
import type { EventListQuery, SecurityStoreDriver, Tier } from "../store/types";
import { ConfigError } from "@kingsleyweb/bun-common";
import * as A from "./analyticsSchemas";
import { ANALYTICS_READ_LIMITS } from "./contract/live";
import { TIER_MS } from "../store/types";
import { eventView, viewerRule } from "./live/view";
import { ApiProblem, notFound } from "./problems";

/** The most bans one timeline read scans (the store bounds active bans at 100,000 per EP). */
const MAX_TIMELINE_BANS = 20_000;

/** The metrics keyed by a subject, whose `kind` decides the permission. */
const SUBJECT_METRICS = new Set(["refused", "top.refused", "top.requests"]);

/** The subject kinds an analyst alone may read. */
const ACCOUNT_KINDS = new Set(["user", "username", "apiKey"]);

/** The store's analytics operations, or a `501`-like refusal when it has none. */
function analytics(store: SecurityStoreDriver) {
  const { series, topK, listEvents } = store;
  if (series === undefined || topK === undefined || listEvents === undefined) {
    throw new ApiProblem(
      404,
      "not_found",
      `the "${store.name}" store keeps no analytics`,
    );
  }
  return { series, topK, listEvents };
}

/** The services a scope covers: `undefined` for every one. */
async function servicesUnder(
  plane: ControlPlane,
  scope: AnalyticsScope,
): Promise<string[] | undefined> {
  const under = await plane.auditScopesUnder(scope);
  if (under === undefined) return undefined;
  return under
    .filter((covered) => covered.startsWith("service:"))
    .map((covered) => covered.slice("service:".length));
}

/** Checks a range: `to` after `from`, at most 400 days. */
function checkRange(from: number, to: number): void {
  if (to <= from) {
    throw new ApiProblem(400, "invalid_request", "to must be after from");
  }
  if (to - from > ANALYTICS_READ_LIMITS.rangeMs) {
    throw new ApiProblem(
      400,
      "invalid_request",
      "a range spans at most 400 days",
    );
  }
}

/** The dimension filters a query named. */
function dimsOf(
  query: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const dims: Record<string, string> = {};
  for (const name of A.DIM_FILTER_NAMES) {
    const value = query[name];
    if (typeof value === "string") dims[name] = value;
  }
  return dims;
}

/**
 * The permission a counter read needs: `analytics:read`, or `events:read`
 * for a subject metric by an account's kind. A subject metric names its
 * kind.
 */
function counterPermission(
  metric: string,
  dims: Readonly<Record<string, string>>,
): SecurityApiPermission {
  if (!SUBJECT_METRICS.has(metric)) return "analytics:read";
  const kind = dims.kind;
  if (kind === undefined) {
    throw new ApiProblem(
      400,
      "invalid_request",
      `${metric} is read one subject kind at a time: name kind (ip, user, username, apiKey)`,
    );
  }
  return ACCOUNT_KINDS.has(kind) ? "events:read" : "analytics:read";
}

/** A row's dims as the reader may see them: a rule id naming an account redacted for a viewer. */
function dimsView(
  dims: Readonly<Record<string, string>>,
  detail: boolean,
): Readonly<Record<string, string>> {
  if (detail || dims.rule === undefined) return dims;
  return { ...dims, rule: viewerRule(dims.rule) };
}

/** A store's refusal of a query (a `ConfigError`) as a `400`. */
async function asProblem<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ApiProblem(400, "invalid_request", error.message);
    }
    throw error;
  }
}

/** The analytics routes. */
export function analyticsRoutes(): AnyRoute[] {
  return [
    {
      method: "get",
      path: "/analytics/series",
      summary:
        "A metric's points over a range, one per bucket and dimension set, for a scope and what is under it",
      tag: "analytics",
      query: A.SeriesQuery,
      responses: { 200: A.Series },
      problems: [403, 404],
      handle: async ({ plane, require, query, operator }) => {
        const q = query as Infer<typeof A.SeriesQuery>;
        const scope: PolicyScopeId = q.scope ?? "global";
        const dims = dimsOf(q);
        await require(counterPermission(q.metric, dims), scope);
        checkRange(q.from, q.to);
        const { series } = analytics(plane.store);
        const services = await servicesUnder(plane, scope);
        const detail = await plane.can(operator, "events:read", scope);
        const span = q.to - q.from;
        const tier: Tier =
          q.tier ??
          (span <= 6 * 3_600_000
            ? "minute"
            : span <= 14 * 86_400_000
              ? "hour"
              : "day");
        const points = await asProblem(async () =>
          series({
            metric: q.metric,
            from: q.from,
            to: q.to,
            tier,
            ...(Object.keys(dims).length === 0 ? {} : { dims }),
            ...(services === undefined ? {} : { services }),
          }),
        );
        return {
          status: 200,
          body: {
            tier,
            points: points.map((point) => ({
              at: point.at,
              dims: dimsView(point.dims, detail),
              value: point.value,
            })),
          },
        };
      },
    },
    {
      method: "get",
      path: "/analytics/top",
      summary:
        "A metric summed per dimension set over a range, the largest first, for a scope and what is under it",
      tag: "analytics",
      query: A.TopQuery,
      responses: { 200: A.Top },
      problems: [403, 404],
      handle: async ({ plane, require, query, operator }) => {
        const q = query as Infer<typeof A.TopQuery>;
        const scope: PolicyScopeId = q.scope ?? "global";
        const dims = dimsOf(q);
        await require(counterPermission(q.metric, dims), scope);
        checkRange(q.from, q.to);
        const { topK } = analytics(plane.store);
        const services = await servicesUnder(plane, scope);
        const detail = await plane.can(operator, "events:read", scope);
        const rows = await asProblem(async () =>
          topK({
            metric: q.metric,
            from: q.from,
            to: q.to,
            limit: q.limit ?? 10,
            ...(q.tier === undefined ? {} : { tier: q.tier }),
            ...(Object.keys(dims).length === 0 ? {} : { dims }),
            ...(services === undefined ? {} : { services }),
          }),
        );
        return {
          status: 200,
          body: {
            rows: rows.map((row) => ({
              dims: dimsView(row.dims, detail),
              value: row.value,
            })),
          },
        };
      },
    },
    {
      method: "get",
      path: "/analytics/events",
      summary:
        "The events, a page at a time, filtered, for a scope and what is under it: whole under events:read, without samples or account subjects otherwise",
      tag: "analytics",
      query: A.EventsQuery,
      responses: { 200: A.EventPage },
      problems: [403, 404],
      handle: async ({ plane, require, query, operator }) => {
        const q = query as Infer<typeof A.EventsQuery>;
        const scope: PolicyScopeId = q.scope ?? "global";
        await require("analytics:read", scope);
        // Filtering by an account is reading it.
        if (
          q.user !== undefined ||
          q.username !== undefined ||
          q.apiKey !== undefined
        ) {
          await require("events:read", scope);
        }
        if (q.from !== undefined && q.to !== undefined)
          checkRange(q.from, q.to);
        const { listEvents } = analytics(plane.store);
        const services = await servicesUnder(plane, scope);
        // Decided per event, on its own service (groups included): an
        // analyst of a group sees its services' events whole on any page.
        const rights = new Map<string, Promise<boolean>>();
        const detailFor = (service: string): Promise<boolean> => {
          let found = rights.get(service);
          if (found === undefined) {
            found = plane.can(operator, "events:read", `service:${service}`);
            rights.set(service, found);
          }
          return found;
        };
        const filter: EventListQuery = {
          limit: q.limit ?? 50,
          direction: q.direction ?? "desc",
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          ...(services === undefined ? {} : { services }),
          ...(q.from === undefined ? {} : { from: q.from }),
          ...(q.to === undefined ? {} : { to: q.to }),
          ...(q.action === undefined ? {} : { action: q.action }),
          ...(q.rule === undefined ? {} : { rule: q.rule }),
          ...(q.route === undefined ? {} : { route: q.route }),
          ...(q.ip === undefined ? {} : { ip: q.ip }),
          ...(q.country === undefined ? {} : { country: q.country }),
          ...(q.asn === undefined ? {} : { asn: q.asn }),
          ...(q.dryRun === undefined ? {} : { dryRun: q.dryRun }),
          ...(q.user === undefined ? {} : { user: q.user }),
          ...(q.username === undefined ? {} : { username: q.username }),
          ...(q.apiKey === undefined ? {} : { apiKey: q.apiKey }),
        };
        const page = await asProblem(async () => listEvents(filter));
        return {
          status: 200,
          body: {
            items: await Promise.all(
              page.items.map(async (event) =>
                eventView(event, {
                  detail: await detailFor(event.service),
                  live: false,
                }),
              ),
            ),
            ...(page.next === undefined ? {} : { next: page.next }),
          },
        };
      },
    },
    {
      method: "get",
      path: "/analytics/bans",
      summary:
        "The ban timeline: bans created (by source) and lifted per bucket over a range, and how many are in force, for a scope and what is under it",
      tag: "analytics",
      query: A.BanTimelineQuery,
      responses: { 200: A.BanTimeline },
      problems: [403],
      handle: async ({ plane, require, query }) => {
        const q = query as Infer<typeof A.BanTimelineQuery>;
        const scope: PolicyScopeId = q.scope ?? "global";
        await require("bans:read", scope);
        checkRange(q.from, q.to);
        const span = q.to - q.from;
        const bucket: Tier =
          q.bucket ??
          (span <= 6 * 3_600_000
            ? "minute"
            : span <= 14 * 86_400_000
              ? "hour"
              : "day");
        const width = TIER_MS[bucket];
        if (span / width > ANALYTICS_READ_LIMITS.seriesPoints) {
          throw new ApiProblem(
            400,
            "invalid_request",
            `the range holds more than ${ANALYTICS_READ_LIMITS.seriesPoints} buckets; widen the bucket`,
          );
        }
        const points = new Map<
          number,
          { created: Record<string, number>; lifted: number }
        >();
        const point = (at: number) => {
          const start = Math.floor(at / width) * width;
          let found = points.get(start);
          if (found === undefined) {
            found = { created: {}, lifted: 0 };
            points.set(start, found);
          }
          return found;
        };
        let active = 0;
        let scanned = 0;
        let truncated = false;
        let cursor: string | undefined;
        do {
          const page = await plane.listBans({
            limit: 200,
            scope,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const ban of page.items) {
            scanned += 1;
            if (ban.active) active += 1;
            if (ban.createdAt >= q.from && ban.createdAt < q.to) {
              const created = point(ban.createdAt).created;
              created[ban.source] = (created[ban.source] ?? 0) + 1;
            }
            if (
              ban.liftedAt !== null &&
              ban.liftedAt >= q.from &&
              ban.liftedAt < q.to
            ) {
              point(ban.liftedAt).lifted += 1;
            }
          }
          cursor = page.next;
          if (cursor !== undefined && scanned >= MAX_TIMELINE_BANS) {
            truncated = true;
            break;
          }
        } while (cursor !== undefined);
        return {
          status: 200,
          body: {
            bucketMs: width,
            points: [...points.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([at, counts]) => ({ at, ...counts })),
            active,
            truncated,
          },
        };
      },
    },
    {
      method: "get",
      path: "/analytics/events/:id",
      summary:
        "One event, whole, with its redacted request (events:read on its service)",
      tag: "analytics",
      params: A.EventParams,
      responses: { 200: A.EventView },
      problems: [403, 404],
      handle: async ({ plane, require, params }) => {
        const { id } = params as { id: string };
        const { listEvents } = analytics(plane.store);
        const page = await asProblem(async () => listEvents({ limit: 1, id }));
        const event = page.items[0];
        if (event === undefined) throw notFound(`event "${id}"`);
        await require("events:read", `service:${event.service}`);
        return {
          status: 200,
          body: eventView(event, { detail: true, live: false }),
        };
      },
    },
  ];
}
