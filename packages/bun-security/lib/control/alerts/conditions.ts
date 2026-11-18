/**
 * An alert rule's condition, evaluated over the store (README §9.3, PR-CP6):
 * CP1's counters through the analytics reads, the ban records, and the
 * agents' heartbeats, for the rule's scope and what is under it. Each
 * evaluation answers what fires now: one entry per group (a rule, a
 * subject, an agent), or one for the rule as a whole.
 */
import type { PolicyScopeId } from "../contract/types";
import type { ControlPlane } from "../plane";
import type { AlertCondition, AlertMetric } from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
import { TIER_MS } from "../../store/types";
import { viewerRule } from "../live/view";

/** What fires. */
export interface Firing {
  /** The group (`rules` → the rule's id), or `undefined` for the rule as a whole. */
  readonly group: string | undefined;
  /** The figures behind it. */
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

/** The longest window a condition reads. */
const MAX_WINDOW_MS = 7 * 86_400_000;

/** The most groups a grouped threshold reads. */
const MAX_GROUPS = 1_000;

/** The most hours a `sustained` condition reads (7 days). */
const MAX_SUSTAINED_HOURS = 168;

/** The most minute points a `sustained` condition reads in one evaluation. */
const MAX_SUSTAINED_POINTS = 200_000;

/**
 * Each group's count per complete clock hour of `[from, to)` (`""` for
 * the rule as a whole): the hourly rollups, and the minute rows for any
 * hour not rolled up yet (each hour takes the larger, as the two agree
 * once both are there).
 */
async function hourlyByGroup(
  plane: ControlPlane,
  metric: AlertMetric,
  groupBy: string | undefined,
  from: number,
  to: number,
  services: string[] | undefined,
): Promise<Map<string, Map<number, number>>> {
  const series = plane.store.series;
  const out = new Map<string, Map<number, number>>();
  if (series === undefined) return out;
  const read = async (tier: "minute" | "hour") => {
    const sums = new Map<string, Map<number, number>>();
    const points = await series({
      metric: metric.metric,
      from,
      to,
      tier,
      ...(metric.dims === undefined ? {} : { dims: metric.dims }),
      ...(services === undefined ? {} : { services }),
    });
    for (const point of points.slice(0, MAX_SUSTAINED_POINTS)) {
      const group = groupBy === undefined ? "" : point.dims[groupBy];
      if (group === undefined) continue;
      const hour = Math.floor(point.at / TIER_MS.hour) * TIER_MS.hour;
      let hours = sums.get(group);
      if (hours === undefined)
        sums.set(group, (hours = new Map<number, number>()));
      hours.set(hour, (hours.get(hour) ?? 0) + point.value);
    }
    return sums;
  };
  for (const sums of [await read("hour"), await read("minute")]) {
    for (const [group, hours] of sums) {
      let merged = out.get(group);
      if (merged === undefined)
        out.set(group, (merged = new Map<number, number>()));
      for (const [hour, value] of hours)
        merged.set(hour, Math.max(merged.get(hour) ?? 0, value));
    }
  }
  return out;
}

/** The most bans or agents one evaluation scans. */
const MAX_SCAN = 20_000;

/** A metric's name. */
const METRIC = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** Checks a condition; throws a `ConfigError` naming what is wrong. */
export function checkCondition(condition: unknown): AlertCondition {
  if (typeof condition !== "object" || condition === null) {
    throw new ConfigError("an alert rule's condition must be an object");
  }
  const c = condition as Record<string, unknown>;
  const positive = (
    value: unknown,
    what: string,
    max = Number.MAX_SAFE_INTEGER,
  ) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > max
    ) {
      throw new ConfigError(
        `an alert rule's ${what} must be a positive number${max === Number.MAX_SAFE_INTEGER ? "" : ` up to ${max}`}`,
      );
    }
  };
  const metric = (value: unknown, what: string) => {
    const m = value as Partial<AlertMetric> | undefined;
    if (typeof m?.metric !== "string" || !METRIC.test(m.metric)) {
      throw new ConfigError(`an alert rule's ${what} is not a metric name`);
    }
    if (m.dims !== undefined) {
      if (typeof m.dims !== "object" || m.dims === null) {
        throw new ConfigError(
          `an alert rule's ${what} dims must be an object of strings`,
        );
      }
      for (const v of Object.values(m.dims)) {
        if (typeof v !== "string")
          throw new ConfigError(`an alert rule's ${what} dims must be strings`);
      }
    }
  };
  switch (c.type) {
    case "threshold":
      metric(c, "metric");
      positive(c.windowMs, "windowMs", MAX_WINDOW_MS);
      positive(c.value, "value");
      if (
        c.groupBy !== undefined &&
        (typeof c.groupBy !== "string" || !/^\w{1,40}$/.test(c.groupBy))
      ) {
        throw new ConfigError(
          "an alert rule's groupBy must be a dimension's name",
        );
      }
      if (
        c.prefix !== undefined &&
        (typeof c.prefix !== "string" || c.groupBy === undefined)
      ) {
        throw new ConfigError(
          "an alert rule's prefix needs groupBy and must be a string",
        );
      }
      break;
    case "rate":
      metric(c, "metric");
      positive(c.windowMs, "windowMs", MAX_WINDOW_MS);
      positive(c.value, "value");
      break;
    case "baseline":
      metric(c, "metric");
      metric(c.total, "total");
      positive(c.windowMs, "windowMs", TIER_MS.hour);
      positive(c.baselineDays, "baselineDays", 30);
      positive(c.factor, "factor");
      positive(c.minimum, "minimum");
      break;
    case "banStorm":
      positive(c.windowMs, "windowMs", MAX_WINDOW_MS);
      positive(c.value, "value");
      if (
        c.source !== undefined &&
        c.source !== "auto" &&
        c.source !== "manual"
      ) {
        throw new ConfigError('an alert rule\'s source is "auto" or "manual"');
      }
      break;
    case "sustained":
      metric(c, "metric");
      if (
        typeof c.hours !== "number" ||
        !Number.isInteger(c.hours) ||
        c.hours < 1 ||
        c.hours > MAX_SUSTAINED_HOURS
      ) {
        throw new ConfigError(
          `an alert rule's hours must be a whole number from 1 to ${MAX_SUSTAINED_HOURS}`,
        );
      }
      if (
        c.groupBy !== undefined &&
        (typeof c.groupBy !== "string" || !/^\w{1,40}$/.test(c.groupBy))
      ) {
        throw new ConfigError(
          "an alert rule's groupBy must be a dimension's name",
        );
      }
      break;
    case "agentSilent":
      positive(c.afterMs, "afterMs", MAX_WINDOW_MS);
      break;
    case "agentWarning":
      if (
        !Array.isArray(c.kinds) ||
        c.kinds.length === 0 ||
        c.kinds.length > 50 ||
        !c.kinds.every(
          (kind: unknown) =>
            typeof kind === "string" &&
            (kind === "*" || /^[a-z][a-z0-9.-]{0,59}$/.test(kind)),
        )
      ) {
        throw new ConfigError(
          'an alert rule\'s kinds must be 1 to 50 warning kinds (or "*")',
        );
      }
      if (c.maxAgeMs !== undefined)
        positive(c.maxAgeMs, "maxAgeMs", MAX_WINDOW_MS);
      break;
    default:
      throw new ConfigError(
        `an alert rule's condition type is threshold, rate, baseline, sustained, banStorm, agentSilent or agentWarning, not "${String(c.type)}"`,
      );
  }
  return condition as AlertCondition;
}

/** The services a scope covers: `undefined` for every one. */
async function servicesUnder(
  plane: ControlPlane,
  scope: PolicyScopeId,
): Promise<string[] | undefined> {
  const under = await plane.auditScopesUnder(scope);
  return under
    ?.filter((covered) => covered.startsWith("service:"))
    .map((covered) => covered.slice("service:".length));
}

/** A metric's sum over `[from, to)` for the services. */
async function sumOf(
  plane: ControlPlane,
  metric: AlertMetric,
  from: number,
  to: number,
  services: string[] | undefined,
  tier: "minute" | "hour" = "minute",
): Promise<number> {
  const series = plane.store.series;
  if (series === undefined) return 0;
  const points = await series({
    metric: metric.metric,
    from,
    to,
    tier,
    ...(metric.dims === undefined ? {} : { dims: metric.dims }),
    ...(services === undefined ? {} : { services }),
  });
  return points.reduce((sum, point) => sum + point.value, 0);
}

/** What `condition` fires for `scope` at `now`. */
export async function evaluateCondition(
  plane: ControlPlane,
  scope: PolicyScopeId,
  condition: AlertCondition,
  now: number,
): Promise<Firing[]> {
  switch (condition.type) {
    case "threshold": {
      const services = await servicesUnder(plane, scope);
      const from = now - condition.windowMs;
      const window = {
        windowMs: condition.windowMs,
        threshold: condition.value,
      };
      if (condition.groupBy === undefined) {
        const value = await sumOf(plane, condition, from, now, services);
        return value >= condition.value
          ? [{ group: undefined, facts: { ...window, value } }]
          : [];
      }
      const topK = plane.store.topK;
      if (topK === undefined) return [];
      const rows = await topK({
        metric: condition.metric,
        from,
        to: now,
        tier: "minute",
        limit: MAX_GROUPS,
        ...(condition.dims === undefined ? {} : { dims: condition.dims }),
        ...(services === undefined ? {} : { services }),
      });
      const sums = new Map<string, number>();
      /** Groups whose every row is an address's (`kind: "ip"`). */
      const notIp = new Set<string>();
      for (const row of rows) {
        const group = row.dims[condition.groupBy];
        if (group === undefined) continue;
        if (
          condition.prefix !== undefined &&
          !group.startsWith(condition.prefix)
        )
          continue;
        sums.set(group, (sums.get(group) ?? 0) + row.value);
        if (row.dims.kind !== "ip") notIp.add(group);
      }
      return [...sums]
        .filter(([, value]) => value >= condition.value)
        .sort((a, b) => b[1] - a[1])
        .map(([group, value]) => ({
          group,
          facts: {
            ...window,
            value,
            // What an alert may name (the user's rule, 2026-11-17): a rule
            // id as a viewer sees it (one naming an account redacted), an
            // address only when the alert is about it; never a user's or
            // an API key's subject, not even its key.
            ...(condition.groupBy === "rule"
              ? { rule: viewerRule(group) }
              : condition.groupBy === "subject" && !notIp.has(group)
                ? { ip: group }
                : condition.groupBy === "route"
                  ? { route: group }
                  : {}),
          },
        }));
    }
    case "rate": {
      const services = await servicesUnder(plane, scope);
      const value = await sumOf(
        plane,
        condition,
        now - condition.windowMs,
        now,
        services,
      );
      const perMinute = value / (condition.windowMs / TIER_MS.minute);
      return perMinute >= condition.value
        ? [
            {
              group: undefined,
              facts: {
                windowMs: condition.windowMs,
                threshold: condition.value,
                perMinute: Math.round(perMinute * 100) / 100,
              },
            },
          ]
        : [];
    }
    case "baseline": {
      const services = await servicesUnder(plane, scope);
      const from = now - condition.windowMs;
      const count = await sumOf(plane, condition, from, now, services);
      if (count < condition.minimum) return [];
      const total = await sumOf(plane, condition.total, from, now, services);
      if (total === 0) return [];
      const share = count / total;
      // The same hour on each earlier day, from the hourly rollups.
      const hour = Math.floor(now / TIER_MS.hour) * TIER_MS.hour;
      let shares = 0;
      let days = 0;
      for (let day = 1; day <= condition.baselineDays; day++) {
        const start = hour - day * 86_400_000;
        const end = start + TIER_MS.hour;
        const before = await sumOf(
          plane,
          condition.total,
          start,
          end,
          services,
          "hour",
        );
        if (before === 0) continue;
        shares +=
          (await sumOf(plane, condition, start, end, services, "hour")) /
          before;
        days += 1;
      }
      if (days === 0) return [];
      const baseline = shares / days;
      return share >= condition.factor * Math.max(baseline, 0.001)
        ? [
            {
              group: undefined,
              facts: {
                windowMs: condition.windowMs,
                share: Math.round(share * 10_000) / 10_000,
                baseline: Math.round(baseline * 10_000) / 10_000,
                factor: condition.factor,
                count,
              },
            },
          ]
        : [];
    }
    case "sustained": {
      const services = await servicesUnder(plane, scope);
      // The complete clock hours before the current one.
      const to = Math.floor(now / TIER_MS.hour) * TIER_MS.hour;
      const from = to - condition.hours * TIER_MS.hour;
      const groups = await hourlyByGroup(
        plane,
        condition,
        condition.groupBy,
        from,
        to,
        services,
      );
      const out: Firing[] = [];
      for (const [group, hours] of groups) {
        let counted = 0;
        let total = 0;
        for (let hour = from; hour < to; hour += TIER_MS.hour) {
          const value = hours.get(hour) ?? 0;
          if (value > 0) counted += 1;
          total += value;
        }
        if (counted < condition.hours) continue;
        out.push({
          group: condition.groupBy === undefined ? undefined : group,
          facts: {
            hours: condition.hours,
            value: total,
            // What an alert may name (2026-11-17): a crawler's id is no
            // one's; other groups are not named.
            ...(condition.groupBy === "crawler" ? { crawler: group } : {}),
          },
        });
      }
      return out.sort((a, b) => ((a.group ?? "") < (b.group ?? "") ? -1 : 1));
    }
    case "banStorm": {
      const since = now - condition.windowMs;
      let count = 0;
      let scanned = 0;
      let cursor: string | undefined;
      do {
        const page = await plane.listBans({
          limit: 200,
          scope,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const ban of page.items) {
          scanned += 1;
          if (
            ban.createdAt >= since &&
            (condition.source === undefined || ban.source === condition.source)
          ) {
            count += 1;
          }
        }
        cursor = page.next;
      } while (cursor !== undefined && scanned < MAX_SCAN);
      return count >= condition.value
        ? [
            {
              group: undefined,
              facts: {
                windowMs: condition.windowMs,
                threshold: condition.value,
                bans: count,
              },
            },
          ]
        : [];
    }
    case "agentSilent": {
      const agents = plane.agents;
      if (agents === undefined) return [];
      const services = await servicesUnder(plane, scope);
      const out: Firing[] = [];
      let scanned = 0;
      let cursor: string | undefined;
      do {
        const page = await agents.list(200, cursor);
        for (const agent of page.items) {
          scanned += 1;
          if (agent.revokedAt !== null || agent.lastSeen === null) continue;
          if (services !== undefined && !services.includes(agent.service))
            continue;
          const silentMs = now - agent.lastSeen;
          if (silentMs >= condition.afterMs) {
            out.push({
              group: agent.id,
              facts: { agent: agent.id, service: agent.service, silentMs },
            });
          }
        }
        cursor = page.next;
      } while (cursor !== undefined && scanned < MAX_SCAN);
      return out;
    }
    case "agentWarning": {
      const agents = plane.agents;
      if (agents === undefined) return [];
      const services = await servicesUnder(plane, scope);
      const maxAge = condition.maxAgeMs ?? 5 * 60_000;
      const any = condition.kinds.includes("*");
      const out: Firing[] = [];
      let scanned = 0;
      let cursor: string | undefined;
      do {
        const page = await agents.list(200, cursor);
        for (const agent of page.items) {
          scanned += 1;
          if (agent.revokedAt !== null || agent.lastSeen === null) continue;
          if (now - agent.lastSeen > maxAge) continue;
          if (services !== undefined && !services.includes(agent.service))
            continue;
          for (const warning of agent.reported?.warnings ?? []) {
            if (!any && !condition.kinds.includes(warning.kind)) continue;
            out.push({
              group: `${agent.id}:${warning.kind}`,
              facts: {
                warning: warning.kind,
                agent: agent.id,
                service: agent.service,
                since: warning.since,
                ...(warning.share === undefined
                  ? {}
                  : { share: warning.share }),
              },
            });
          }
        }
        cursor = page.next;
      } while (cursor !== undefined && scanned < MAX_SCAN);
      return out;
    }
  }
}
