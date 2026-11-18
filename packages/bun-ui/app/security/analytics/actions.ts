/** How the analytics page groups decisions' actions (PR-U2). */
import type { ChartSeries, ChartTone } from "../../kit/charts/chart";

/** The actions that refuse a request. */
export const REFUSING = new Set(["block", "ban", "drop"]);

/** An action's group on the charts. */
export function actionGroup(
  action: string,
): "allow" | "log" | "delay" | "challenge" | "block" {
  if (REFUSING.has(action)) return "block";
  if (action === "challenge" || action === "delay" || action === "allow")
    return action;
  return "log";
}

/** The traffic chart's series, bottom first. */
export const ACTION_SERIES: readonly ChartSeries[] = [
  { key: "allow", label: "Allowed", tone: "allow" },
  { key: "log", label: "Logged or tagged", tone: "log" },
  { key: "delay", label: "Delayed", tone: "delay" },
  { key: "challenge", label: "Challenged", tone: "challenge" },
  { key: "block", label: "Blocked", tone: "block" },
];

/** An action group's tone. */
export function toneOf(group: string): ChartTone {
  return ACTION_SERIES.find((series) => series.key === group)?.tone ?? "other";
}

/** Whether a rule id looks like a Tor class's (its id names `tor`). */
export function isTorRule(rule: string): boolean {
  return /(?:^|[:._-])tor(?:[:._-]|$)/i.test(rule);
}

/** Whether a rule is a request rule or a managed probe (ConcaveHR's "pattern refusals"). */
export function isPatternRule(rule: string): boolean {
  return rule.startsWith("rule:") || rule.startsWith("probe:");
}
