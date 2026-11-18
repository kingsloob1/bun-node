/**
 * An alert rule's condition as a form holds it (strings, as typed) and
 * back (README §9.3): durations in minutes, dimensions as `key=value`
 * pairs separated by commas, warning kinds separated by commas. What the
 * form cannot say is refused with a reason, before the API is asked.
 */
import type { AlertConditionDto } from "./alertQueries";

/** The condition kinds, as the form names them. */
export const CONDITION_TYPES = [
  "threshold",
  "rate",
  "baseline",
  "sustained",
  "banStorm",
  "agentSilent",
  "agentWarning",
] as const;

/** A condition kind. */
export type ConditionType = (typeof CONDITION_TYPES)[number];

/** What each kind watches, for people. */
export const CONDITION_LABELS: Record<ConditionType, string> = {
  threshold: "A metric's total over a window reaches a value",
  rate: "A metric's rate per minute reaches a value",
  baseline: "A metric's share spikes above its usual share at this hour",
  sustained: "A metric counts in every one of the last hours",
  banStorm: "Many bans made in a window",
  agentSilent: "An agent goes silent",
  agentWarning: "An agent reports a warning",
};

/** The form's fields, all as typed. */
export interface ConditionFields {
  /** The kind. */
  type: ConditionType;
  /** The metric (`requests`, `rules`, `top.refused`, `events.capped`). */
  metric: string;
  /** Its dimensions: `key=value, …`. */
  dims: string;
  /** The window, minutes. */
  windowMinutes: string;
  /** The value reached (threshold, rate, ban storm). */
  value: string;
  /** Each value of this dimension on its own (threshold). */
  groupBy: string;
  /** Only grouped values with this prefix (threshold). */
  prefix: string;
  /** The total's metric (baseline). */
  totalMetric: string;
  /** The total's dimensions (baseline). */
  totalDims: string;
  /** The complete clock hours, 1 to 168 (sustained). */
  hours: string;
  /** The days of history (baseline). */
  baselineDays: string;
  /** The factor over the usual share (baseline). */
  factor: string;
  /** The least counted for a spike (baseline). */
  minimum: string;
  /** The bans' source, or empty for any (ban storm). */
  source: "" | "auto" | "manual";
  /** Silent for, minutes (agent silent). */
  afterMinutes: string;
  /** The warning kinds, `*` for any (agent warning). */
  kinds: string;
  /** How recent the heartbeat, minutes; empty for the default (agent warning). */
  maxAgeMinutes: string;
}

/** An empty form of `type`, with the usual starting values. */
export function emptyCondition(
  type: ConditionType = "threshold",
): ConditionFields {
  return {
    type,
    metric: "requests",
    dims: "",
    windowMinutes: "5",
    value: "",
    groupBy: "",
    prefix: "",
    totalMetric: "requests",
    totalDims: "",
    hours: "6",
    baselineDays: "7",
    factor: "3",
    minimum: "100",
    source: "",
    afterMinutes: "10",
    kinds: "*",
    maxAgeMinutes: "",
  };
}

/** `key=value, …` as an object. */
function dimsOf(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const pair = part.trim();
    if (pair === "") continue;
    const at = pair.indexOf("=");
    if (at <= 0 || at === pair.length - 1) return `“${pair}” is not key=value`;
    out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

/** An object as `key=value, …`. */
function dimsText(dims: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(dims ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

/** A positive number typed, or a reason. */
function positive(text: string, what: string): number | string {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && value > 0
    ? value
    : `${what} must be a number above 0`;
}

/** A positive whole number typed, or a reason. */
function whole(text: string, what: string): number | string {
  const value = Number(text);
  return /^\d+$/.test(text.trim()) && value > 0
    ? value
    : `${what} must be a whole number above 0`;
}

/** Minutes typed as milliseconds, or a reason. */
function minutes(text: string, what: string): number | string {
  const value = positive(text, what);
  return typeof value === "string" ? value : Math.round(value * 60_000);
}

/** The condition the form says, or the first reason it cannot. */
export function conditionOf(
  fields: ConditionFields,
): { condition: AlertConditionDto } | { error: string } {
  const fail = (error: string) => ({ error });
  const metricPart = ():
    { metric: string; dims?: Record<string, string> } | string => {
    if (fields.metric.trim() === "") return "Name the metric";
    const dims = dimsOf(fields.dims);
    if (typeof dims === "string") return dims;
    return {
      metric: fields.metric.trim(),
      ...(Object.keys(dims).length === 0 ? {} : { dims }),
    };
  };
  switch (fields.type) {
    case "threshold":
    case "rate": {
      const metric = metricPart();
      if (typeof metric === "string") return fail(metric);
      const windowMs = minutes(fields.windowMinutes, "The window");
      if (typeof windowMs === "string") return fail(windowMs);
      const value = positive(fields.value, "The value");
      if (typeof value === "string") return fail(value);
      if (fields.type === "rate")
        return { condition: { type: "rate", ...metric, windowMs, value } };
      return {
        condition: {
          type: "threshold",
          ...metric,
          windowMs,
          value,
          ...(fields.groupBy.trim() === ""
            ? {}
            : { groupBy: fields.groupBy.trim() }),
          ...(fields.prefix.trim() === ""
            ? {}
            : { prefix: fields.prefix.trim() }),
        },
      };
    }
    case "baseline": {
      const metric = metricPart();
      if (typeof metric === "string") return fail(metric);
      if (fields.totalMetric.trim() === "")
        return fail("Name the total's metric");
      const totalDims = dimsOf(fields.totalDims);
      if (typeof totalDims === "string") return fail(totalDims);
      const windowMs = minutes(fields.windowMinutes, "The window");
      if (typeof windowMs === "string") return fail(windowMs);
      const baselineDays = whole(fields.baselineDays, "The days of history");
      if (typeof baselineDays === "string") return fail(baselineDays);
      const factor = positive(fields.factor, "The factor");
      if (typeof factor === "string") return fail(factor);
      const minimum = whole(fields.minimum, "The minimum");
      if (typeof minimum === "string") return fail(minimum);
      return {
        condition: {
          type: "baseline",
          ...metric,
          total: {
            metric: fields.totalMetric.trim(),
            ...(Object.keys(totalDims).length === 0 ? {} : { dims: totalDims }),
          },
          windowMs,
          baselineDays,
          factor,
          minimum,
        },
      };
    }
    case "sustained": {
      const metric = metricPart();
      if (typeof metric === "string") return fail(metric);
      const hours = whole(fields.hours, "The hours");
      if (typeof hours === "string") return fail(hours);
      if (hours > 168) return fail("The hours are at most 168");
      return {
        condition: {
          type: "sustained",
          ...metric,
          hours,
          ...(fields.groupBy.trim() === ""
            ? {}
            : { groupBy: fields.groupBy.trim() }),
        },
      };
    }
    case "banStorm": {
      const windowMs = minutes(fields.windowMinutes, "The window");
      if (typeof windowMs === "string") return fail(windowMs);
      const value = whole(fields.value, "The number of bans");
      if (typeof value === "string") return fail(value);
      return {
        condition: {
          type: "banStorm",
          windowMs,
          value,
          ...(fields.source === "" ? {} : { source: fields.source }),
        },
      };
    }
    case "agentSilent": {
      const afterMs = minutes(fields.afterMinutes, "The silence");
      if (typeof afterMs === "string") return fail(afterMs);
      return { condition: { type: "agentSilent", afterMs } };
    }
    case "agentWarning": {
      const kinds = fields.kinds
        .split(",")
        .map((kind) => kind.trim())
        .filter((kind) => kind !== "");
      if (kinds.length === 0) return fail("Name a warning kind, or * for any");
      let maxAgeMs: number | undefined;
      if (fields.maxAgeMinutes.trim() !== "") {
        const age = minutes(fields.maxAgeMinutes, "The heartbeat's age");
        if (typeof age === "string") return fail(age);
        maxAgeMs = age;
      }
      return {
        condition: {
          type: "agentWarning",
          kinds,
          ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
        },
      };
    }
  }
}

/** The form for a stored `condition`. */
export function fieldsOf(condition: AlertConditionDto): ConditionFields {
  const fields = emptyCondition(condition.type);
  const mins = (ms: number) => String(ms / 60_000);
  switch (condition.type) {
    case "threshold":
    case "rate":
      return {
        ...fields,
        metric: condition.metric,
        dims: dimsText(condition.dims),
        windowMinutes: mins(condition.windowMs),
        value: String(condition.value),
        ...(condition.type === "threshold"
          ? {
              groupBy: condition.groupBy ?? "",
              prefix: condition.prefix ?? "",
            }
          : {}),
      };
    case "baseline":
      return {
        ...fields,
        metric: condition.metric,
        dims: dimsText(condition.dims),
        totalMetric: condition.total.metric,
        totalDims: dimsText(condition.total.dims),
        windowMinutes: mins(condition.windowMs),
        baselineDays: String(condition.baselineDays),
        factor: String(condition.factor),
        minimum: String(condition.minimum),
      };
    case "sustained":
      return {
        ...fields,
        metric: condition.metric,
        dims: dimsText(condition.dims),
        hours: String(condition.hours),
        groupBy: condition.groupBy ?? "",
      };
    case "banStorm":
      return {
        ...fields,
        windowMinutes: mins(condition.windowMs),
        value: String(condition.value),
        source: condition.source ?? "",
      };
    case "agentSilent":
      return { ...fields, afterMinutes: mins(condition.afterMs) };
    case "agentWarning":
      return {
        ...fields,
        kinds: condition.kinds.join(", "),
        maxAgeMinutes:
          condition.maxAgeMs === undefined ? "" : mins(condition.maxAgeMs),
      };
  }
}

/** A condition in one line, for the rules list. */
export function describeCondition(condition: AlertConditionDto): string {
  const mins = (ms: number) => {
    const m = ms / 60_000;
    return m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;
  };
  const metric = (m: {
    metric: string;
    dims?: Readonly<Record<string, string>>;
  }) =>
    m.dims === undefined || Object.keys(m.dims).length === 0
      ? m.metric
      : `${m.metric} (${dimsText(m.dims)})`;
  switch (condition.type) {
    case "threshold":
      return `${metric(condition)} ≥ ${condition.value} in ${mins(condition.windowMs)}${condition.groupBy === undefined ? "" : `, per ${condition.groupBy}${condition.prefix === undefined ? "" : ` starting “${condition.prefix}”`}`}`;
    case "rate":
      return `${metric(condition)} ≥ ${condition.value}/min over ${mins(condition.windowMs)}`;
    case "baseline":
      return `${metric(condition)} share of ${metric(condition.total)} ≥ ${condition.factor}× its usual over ${mins(condition.windowMs)} (${condition.baselineDays} days, at least ${condition.minimum})`;
    case "sustained":
      return `${metric(condition)} in each of the last ${condition.hours} hours${condition.groupBy === undefined ? "" : `, per ${condition.groupBy}`}`;
    case "banStorm":
      return `≥ ${condition.value} ${condition.source ?? ""} bans in ${mins(condition.windowMs)}`.replace(
        "  ",
        " ",
      );
    case "agentSilent":
      return `an agent silent for ${mins(condition.afterMs)}`;
    case "agentWarning":
      return `an agent reports ${condition.kinds.join(", ")}`;
  }
}
